---
name: diagnose
description: Use when waveform-forge is misbehaving and the cause is not obvious, because the diagnostic order below finds the failing subsystem without guesswork.
metadata:
  version: 1.1.0
---

# Diagnose waveform-forge

## When to use this

Something is broken and you do not yet know which subsystem is at fault.

## Steps

1. `wf doctor` — read the failing row and its **fix** line. Do not skip to step 2.
2. If `skills` is failing: `wf skills --json` lists every validation issue with a file
   and line. Fix the file, do not delete the skill.
3. If `plugins` is warning: `wf plugins --json` shows each rejection with its reason.
   A version mismatch names the required and running versions.
4. If a single capability misbehaves: `wf tools --json` to confirm it is registered,
   then `wf mcp call <tool> '<input>'` to see the error envelope with its stable code.
5. If `engine` is failing: `wf doctor` already ran the engine. Reproduce directly with
   `python -m pytest services/engine -q` — it fails with the same code.
6. If the web app is stale: `curl -s localhost:3000/api/health` and read `checks`.

## Error codes

| Code                | Meaning                               | First move                            |
| ------------------- | ------------------------------------- | ------------------------------------- |
| `VALIDATION_FAILED` | input did not match the tool's schema | print the schema, fix the caller      |
| `PERMISSION_DENIED` | tool needs a permission not granted   | check the declared permissions        |
| `CONFLICT`          | duplicate name at registration        | find the other registrant             |
| `UPSTREAM_FAILED`   | the Python engine returned an error   | run the op directly, see `durationMs` |
| `TIMEOUT`           | exceeded `engine.timeoutMs`           | raise it or make the op cheaper       |

## Verify

`wf doctor` exits 0.
