<div align="center">

# waveform-forge

**Declare an edit as a list of cuts. Get a frame-exact token timeline, proven lossless, before
you render.**

[CI](https://github.com/aniruddhaadak80/waveform-forge/actions/workflows/ci.yml) ·
[License](https://github.com/aniruddhaadak80/waveform-forge/blob/main/LICENSE) ·
[Issues](https://github.com/aniruddhaadak80/waveform-forge/issues)

</div>

---

## The problem

An edit decision list is a list of cuts: take 1,200 frames from camera A starting at frame 900,
then 600 from camera B, then a 45-frame overlap. The arithmetic looks trivial and it is not.

Get one number wrong and you do not get a crash. You get an output that is 47 milliseconds short
of what the EDL asked for, and a desync that nobody notices until playback. Today you find out
by rendering for forty minutes and watching for drift, or by hand-writing an `ffmpeg
filter_complex` graph and hoping the integer arithmetic closed.

Checking that five tokens totalling 1,965 frames add up correctly is easy for a language model to
_write_. On a timeline of two hundred tokens it is easy for one to get wrong. That asymmetry is
the whole product.

## What this does

You declare what the edit does. A pure Python engine proves the arithmetic:

- **tokenizes** the declaration into edit tokens laid end to end on the output timeline, with
  integer frame arithmetic only
- **proves the round trip** — rebuilds the declaration from the tokens alone and compares it to
  the original intent
- **audits every source frame** — each frame is used once, reused, or explicitly dropped, and the
  three must sum to the source duration
- **returns one verdict**: `certified` or `rejected`, with every problem in a single pass

A model can propose an edit. Only code is allowed to sign it off.

```
$ wf mcp call edl_certify "@examples/promo-2997.json"
{
  "verdict": "certified",
  "summary": { "token_count": 5, "total_out_frames": 1965, "total_out_timecode": "00:01:05:15" },
  "roundtrip": { "lossless": true },
  "coverage": { "all_conserved": true, "total_reused_frames": 3 },
  ...
}
```

## Quick start

Requires Node >= 22.12 and Python >= 3.11.

```bash
git clone https://github.com/aniruddhaadak80/waveform-forge.git
cd waveform-forge
npm install
node packages/cli/dist/bin.js doctor
```

The CLI binary is `wf` once linked globally, or `node packages/cli/dist/bin.js` from a clone —
every example below uses the latter so it runs without a global install.

`doctor` probes the runtime, the skill catalog, the plugin registry, the config, and **the Python
engine itself** (it runs a real call, not a file-existence check), printing a fix hint for
anything that fails:

```
$ node packages/cli/dist/bin.js doctor
waveform-forge doctor
  [PASS] node     v22.23.2
  [PASS] package  waveform-forge@0.1.0
  [PASS] skills   4 skills, 0 invalid
  [PASS] plugins  2 active, 0 disabled, 0 rejected
  [WARN] config   no product.config.json — using defaults
         fix: run with defaults, or create product.config.json
  [PASS] engine   python engine answered in-process (total=0)
```

## Walkthrough

Every command below was run against this tree; the outputs are real.

### 1. Certify an edit that works

```bash
node packages/cli/dist/bin.js mcp call edl_certify "@examples/promo-2997.json"
```

A five-token, three-source assembly at 29.97fps. It returns `"verdict": "certified"`, 1,965
frames out, timecode `00:01:05:15`, `lossless: true`, and `total_reused_frames: 3` — the
three-frame overlap is deliberate, and reported rather than blocked.

### 2. Certify an edit that is broken

```bash
node packages/cli/dist/bin.js mcp call edl_certify "@examples/broken.json"
```

Four separate faults, all reported in one pass: `READS_PAST_END`, `UNKNOWN_SOURCE`,
`NON_POSITIVE_LENGTH`, `UNKNOWN_TRANSITION`, plus a derived `ROUNDTRIP_LOSSY`. `verdict` is
`"rejected"`. One run, every problem — not one error per render.

### 3. Inspect one property at a time

```bash
node packages/cli/dist/bin.js mcp call timeline_compile "@examples/promo-2997.json" > timeline.json
node packages/cli/dist/bin.js mcp call coverage_audit "@timeline.json"
node packages/cli/dist/bin.js mcp call timeline_summary "@timeline.json"
```

`coverage_audit` reports `"total_reused_frames": 3` and `"all_conserved": true`.
`timeline_summary` reports `total_out_timecode: "00:01:05:15"` and the exact duration as a
rational, `131131/2000` seconds — because 600 frames at 29.97 is 20.02s, not 20s.

### 4. Pre-flight without compiling

```bash
node packages/cli/dist/bin.js mcp call edl_validate "@examples/broken.json"
```

`{"ok": false, ...}` with the same codes, without paying for tokenization.

### 5. Start from a reviewed pattern

```bash
node packages/cli/dist/bin.js mcp call list_presets "{}"
```

Three presets ship as a real plugin. A preset is a house cut pattern somebody already certified —
`packages/cli/src/presets.test.ts` re-certifies all three against the engine, so "already
certified" is enforced by CI rather than asserted in a README.

### 6. Use it from an agent over MCP

```bash
node scripts/mcp-proof.mjs
```

Sends real JSON-RPC over a real stdio pipe and prints the exchange: `initialize`,
`tools/list` (12 tools), a `tools/call` that reaches the Python engine, and the error envelope
for invalid input.

### 7. Run it as a web app

```bash
npm run dev --workspace=@waveformforge/web
```

The overview route renders a real certified timeline server-side — the ruled token ladder, the
frame accounting, the verdict. `/forge` is the form-first editor: it posts a declaration to
`/api/certify`, which shells the same Python engine the CLI uses.

## The signature visual

A single-column timeline where each token occupies exactly its share of the output and every
token edge is a hairline at its true frame offset, with each token printing its own in/out frame
numbers. The claim "the arithmetic closes" is checkable by eye against the numbers on the ladder.

## Architecture

```
CLI · Web · MCP · Channels ──▶ one Tool registry ──▶ Python engine (pure, JSON over stdio)
```

Every capability is a `Tool` with an input schema, declared permissions, and a stateless handler.
The CLI, the web app, and the MCP server are transports over that one registry — MCP adds a
protocol, never a second implementation.

The engine is a pure function over stdin/stdout: no server, no port, no clock, no randomness, no
network. Two concurrent calls can never interleave.

```
services/engine/src/waveform_forge/
  model.py     typed domain model (TypedDict, integer frames only)
  compile.py   the tokenizer — compile_timeline, validate_declaration
  audit.py     verify_roundtrip, audit_coverage, timeline_summary, exact timecode
  analysis.py  operation dispatch
  protocol.py  the JSON wire contract
```

Frame arithmetic is integer throughout. A frame count is a frame count; nothing converts to a
float, because 30000/1001 fps is not representable in binary floating point and one lost ulp is
one desynced frame.

### Invariants, and how they are enforced

| Invariant                                         | Enforced by                                         |
| ------------------------------------------------- | --------------------------------------------------- |
| Tokens sum to the output length                   | `test_properties.py`, hypothesis                    |
| Declaration rebuilds from tokens alone            | `test_properties.py` + golden file                  |
| Recompiling the reconstruction is identical       | `test_properties.py`                                |
| `used + reused + dropped == duration` per source  | `test_properties.py`                                |
| The tokenizer's own arithmetic is self-consistent | `_arithmetic_differences` inside `verify_roundtrip` |
| Exact output for a fixed input                    | `test_golden.py` + `timeline_v1.json`               |

`mypy --strict` and `ruff` both run in `npm run check`. The golden file is regenerated
deliberately (`python services/engine/regenerate_golden.py`) and the diff is meant to be read.

## Surfaces

| Surface    | What it is                                                                 |
| ---------- | -------------------------------------------------------------------------- |
| CLI        | `doctor`, `tools`, `skills`, `plugins`, `mcp serve`, `mcp call`, `version` |
| Web        | Next.js App Router, deployed, server-rendered with real product data       |
| MCP server | Real MCP over stdio, 12 tools, stateless                                   |
| Engine     | Pure Python, deterministic, the credibility of the product                 |
| Skills     | 4 skills from disk with YAML frontmatter validation and a version gate     |
| Plugins    | Manifest registry; the presets plugin is load-bearing                      |
| Memory     | SQLite, WAL, numbered idempotent migrations, FTS5                          |
| Channels   | One interface, shared retry/backoff/queue in the base class                |
| Desktop    | Electron loads the web app rather than reimplementing it                   |

**Deliberately omitted.** No `packages/providers`: the entire claim is that the load-bearing
arithmetic is deterministic code, so an adapter that could put a model in that path would
undermine the product rather than extend it. No TUI: the primary interface is graphical, so a
TUI would be a strictly worse copy of the web app.

## Configuration

```bash
PRODUCT_MCP_PERMISSIONS=fs:read,proc:spawn   # tighten the MCP permission ceiling
PRODUCT_ENGINE_CWD=/path/to/services/engine/src
PRODUCT_PYTHON=/path/to/python
```

`product.config.json` is optional; every key has a default. See `.env.example` and
`docs/configuration.md`.

## Development

```bash
npm run check          # the aggregate gate CI runs
npm run format         # rewrite the tree
npm run dev            # turbo dev across the workspace
python -m pytest services/engine -q
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
