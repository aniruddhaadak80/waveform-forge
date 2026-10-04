---
name: certify-an-edit
description: Use when declaring or changing an edit decision list, because certification proves the frame arithmetic closes before a render wastes forty minutes discovering it did not.
metadata:
  version: 1.0.0
---

# Certify an edit

## When to use this

You have declared or changed a set of cuts and need to know whether the timeline is safe to
render. Run this before every encode, not after.

## The idea

You declare _what_ the edit does. The engine proves the _arithmetic_: that the output is exactly
as long as the sum of its tokens, that every source frame is either used or explicitly dropped,
and that the declaration can be rebuilt from the tokens alone. You never do that arithmetic
yourself — it is the part a model gets wrong on long timelines.

## Steps

1. Start from a reviewed pattern instead of inventing one:
   `wf mcp call list_presets '{}'` — then feed a preset's `program` and `edl` into step 2.
2. Declare the edit as `{"program": {...}, "edl": [...]}` in a file. `program` carries an exact
   rational `frame_rate` (`{"num": 30000, "den": 1001}` for 29.97 — never a float) and a
   `sources` array with `duration_frames` per source. `edl` is the cuts in output order, each
   with `source_id`, `src_start_frame` and `frame_count`.
3. Certify it: `wf mcp call edl_certify "@edit.json"`.
4. Read `verdict`. `"certified"` means render it. `"rejected"` means fix `errors` first — see the
   `read-timeline-violations` skill for each code.
5. Ignore `warnings` only after reading them. A warning never blocks, but a `ROUNDTRIP_LOSSY`
   warning would mean something is wrong.

## Worked example

`examples/promo-2997.json` is a five-token, three-source assembly that certifies:

```
wf mcp call edl_certify "@examples/promo-2997.json"
```

It returns `"verdict": "certified"`, `"total_out_frames": 1965`, `"total_out_timecode":
"00:01:05:15"`, `"lossless": true`, and `"total_reused_frames": 3` — the three-frame overlap is
deliberate and is reported rather than blocked.

`examples/broken.json` is the same shape with four separate faults. It returns `"verdict":
"rejected"` and all four at once, which is the point: one pass, every problem.

## Chaining

`timeline_compile` output feeds the three timeline tools directly, so you can inspect one
property at a time:

```
wf mcp call timeline_compile "@edit.json" > timeline.json
wf mcp call coverage_audit "@timeline.json"
wf mcp call timeline_summary "@timeline.json"
wf mcp call timeline_verify "@timeline.json"
```

## Verify

`verdict` is `"certified"`, `roundtrip.lossless` is `true`, and `coverage.all_conserved` is
`true`.
