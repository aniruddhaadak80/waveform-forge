---
name: read-timeline-violations
description: Use when certification is rejected, because each violation code names a different mistake and guessing at the fix wastes a second render.
metadata:
  version: 1.0.0
---

# Read timeline violations

## When to use this

`edl_certify` or `edl_validate` returned `"rejected"`. Each code below is a distinct mistake with
a distinct fix; none of them are retryable by adjusting a parameter.

## Error codes — these block certification

| Code                  | What it means                                  | The fix                                                               |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| `UNKNOWN_SOURCE`      | `source_id` is not in `program.sources`        | add the source, or fix the typo in the id                             |
| `READS_PAST_END`      | the entry reads past the end of its source     | shorten `frame_count` so `src_start_frame + frame_count` fits         |
| `START_PAST_END`      | `src_start_frame` is at or beyond the duration | move the in-point earlier; this source is shorter than you assumed    |
| `NEGATIVE_START`      | `src_start_frame` is below zero                | frame 0 is the first frame; there is nothing before it                |
| `NON_POSITIVE_LENGTH` | `frame_count` is 0 or negative                 | a token covers at least one frame; delete the entry instead           |
| `DUPLICATE_TOKEN_ID`  | two entries declare the same `token_id`        | give each entry a unique id, or omit `token_id` and let it be derived |
| `UNKNOWN_TRANSITION`  | the transition is outside the closed set       | use `cut`, `dissolve`, `dip_to_black`, `dip_from_black` or `wipe`     |
| `ROUNDTRIP_LOSSY`     | the timeline cannot be rebuilt into the edit   | an entry was dropped; fix the underlying error listed above it        |

`READS_PAST_END` is never clamped. An out-of-range read is reported instead of silently
truncated, because a clamped cut loses somebody's words without anyone noticing.

## Warnings — these do not block

| Code                             | What it means                                   | What to do                                                            |
| -------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| `TRANSITION_WITHOUT_PREDECESSOR` | the first token declares a non-`cut` transition | a transition applies _between_ two tokens; set it to `cut` or drop it |
| coverage `reuse_sites`           | two or more tokens read the same source range   | usually intended (a flashback). Confirm it, do not "fix" it           |

Reuse is reported rather than forbidden because reusing a range is legitimate creative intent. A
tool that rejected it would be wrong. Judge each reuse site yourself.

## Diagnosing a rejection

1. `wf mcp call edl_validate "@edit.json"` — same codes, without compiling, so it is cheaper.
2. Every error is reported in one pass. Fix all of them together, not one per run.
3. Each error carries `entry_index` and `field`, which point at the exact element of `edl`.
4. Re-certify. `errors` must be empty before `verdict` can be `"certified"`.

## Verify

`wf mcp call edl_validate "@examples/broken.json"` returns `"ok": false` with the codes above;
the same call on `examples/promo-2997.json` returns `"ok": true`.
