"""Certification: prove a compiled timeline is lossless and frame-conserving.

Three questions, three functions:

* `verify_roundtrip` — can the declaration be rebuilt from the tokens alone?
* `audit_coverage`  — is every source frame either used or explicitly dropped, and is the
                      arithmetic identity `used + reused + dropped == duration` actually true?
* `timeline_summary` — the numbers a human reads.

All pure. No clock, no randomness, no filesystem.
"""

from __future__ import annotations

from math import gcd
from typing import Any

from .compile import DEFAULT_TRANSITION, expected_token_id, parse_edl, parse_rate
from .model import (
    CoverageReport,
    Difference,
    EditToken,
    FrameRange,
    Rate,
    ReconstructedEntry,
    ReuseSite,
    RoundTripReport,
    Severity,
    SourceCoverage,
    SourceProgram,
    Timeline,
    TimelineSummary,
    Violation,
)
from .protocol import EngineError

#: A coverage depth at or above this means two or more tokens read the same frame.
OVERLAP_DEPTH = 2


def _opt_int(value: Any, field: str, fallback: int) -> int:
    """Read an optional integer field from decoded JSON.

    `int()` would coerce a string or raise a bare ValueError; a malformed timeline should
    produce the same stable error code as every other malformed input.
    """
    if value is None:
        return fallback
    if isinstance(value, bool) or not isinstance(value, int):
        raise EngineError("BAD_SHAPE", f"{field} must be an integer, got {type(value).__name__}")
    return value


def _opt_str(value: Any, field: str, fallback: str) -> str:
    if value is None:
        return fallback
    if not isinstance(value, str):
        raise EngineError("BAD_SHAPE", f"{field} must be a string, got {type(value).__name__}")
    return value


def reconstruct(timeline: Timeline) -> list[ReconstructedEntry]:
    """Rebuild the declaration from the tokens and nothing else.

    If this needs any state the tokens do not carry, the timeline is not lossless — so it
    deliberately reads only `tokens`.
    """
    return [
        ReconstructedEntry(
            token_id=token["token_id"],
            source_id=token["source_id"],
            src_start_frame=token["src_start_frame"],
            frame_count=token["frame_count"],
            transition=token["transition"],
        )
        for token in timeline["tokens"]
    ]


def _mismatch(found: ReconstructedEntry, expected: ReconstructedEntry) -> tuple[str, object, object] | None:
    """The first field on which two entries disagree, with both values.

    Written as explicit comparisons rather than a loop over a field-name tuple: a TypedDict
    cannot be indexed by a computed key, and a `dict` cast here would throw away exactly the
    checking this module exists to provide.
    """
    if found["source_id"] != expected["source_id"]:
        return ("source_id", found["source_id"], expected["source_id"])
    if found["src_start_frame"] != expected["src_start_frame"]:
        return ("src_start_frame", found["src_start_frame"], expected["src_start_frame"])
    if found["frame_count"] != expected["frame_count"]:
        return ("frame_count", found["frame_count"], expected["frame_count"])
    if found["transition"] != expected["transition"]:
        return ("transition", found["transition"], expected["transition"])
    return None


def verify_roundtrip(timeline: Timeline) -> RoundTripReport:
    """Prove the timeline is reconstructible into the declaration it was compiled from."""
    expected: list[ReconstructedEntry] = []
    index_of: dict[str, int] = {}
    occurrences: dict[str, int] = {}
    for index, declared in enumerate(timeline["declared_edl"]):
        token_id = expected_token_id(index, declared.get("token_id"))
        # First index wins, so a duplicated id resolves to the entry that legitimately owns it.
        index_of.setdefault(token_id, index)
        occurrences[token_id] = occurrences.get(token_id, 0) + 1
        expected.append(
            ReconstructedEntry(
                token_id=token_id,
                source_id=declared["source_id"],
                src_start_frame=declared["src_start_frame"],
                frame_count=declared["frame_count"],
                transition=declared.get("transition", DEFAULT_TRANSITION),
            )
        )

    actual = reconstruct(timeline)
    differences: list[Difference] = []

    if len(expected) != len(actual):
        differences.append(
            Difference(
                kind="entry_count",
                detail=(
                    f"declared {len(expected)} entries but the timeline carries {len(actual)} tokens; "
                    f"{len(expected) - len(actual)} entries could not be tokenized"
                ),
            )
        )

    actual_by_id = {entry["token_id"]: entry for entry in actual}
    for wanted in expected:
        token_id = wanted["token_id"]
        # A token id declared more than once cannot be aligned to a single entry; that is
        # DUPLICATE_TOKEN_ID's job, so reporting it again here would just be the same defect
        # counted twice.
        if occurrences[token_id] > 1:
            continue
        found = actual_by_id.get(token_id)
        if found is None:
            differences.append(
                Difference(
                    kind="missing_entry",
                    detail=(
                        f"token {token_id!r} is absent from the timeline, so the declaration "
                        "cannot be rebuilt from it"
                    ),
                    entry_index=index_of[token_id],
                    token_id=token_id,
                )
            )
            continue
        disagreement = _mismatch(found, wanted)
        if disagreement is not None:
            field, actual_value, declared_value = disagreement
            differences.append(
                Difference(
                    kind="field_mismatch",
                    detail=(
                        f"token {token_id!r} has {field}={actual_value!r} but the "
                        f"declaration says {declared_value!r}"
                    ),
                    entry_index=index_of[token_id],
                    token_id=token_id,
                )
            )

    surviving = [
        entry["token_id"]
        for entry in expected
        if occurrences[entry["token_id"]] == 1 and entry["token_id"] in actual_by_id
    ]
    emitted = [entry["token_id"] for entry in actual]
    if surviving != emitted:
        differences.append(
            Difference(
                kind="field_mismatch",
                detail="token order in the timeline differs from the declared order",
            )
        )

    differences.extend(_arithmetic_differences(timeline["tokens"]))

    return RoundTripReport(
        lossless=not differences,
        declared_entries=len(expected),
        reconstructed_entries=len(actual),
        differences=differences,
    )


def _arithmetic_differences(tokens: list[EditToken]) -> list[Difference]:
    """Check the tokenizer's own frame arithmetic.

    A round-trip check that only compares the timeline to the declaration would happily pass a
    timeline whose tokens do not add up. This closes that hole.
    """
    found: list[Difference] = []
    cursor = 0
    for token in tokens:
        if token["out_start_frame"] != cursor:
            found.append(
                Difference(
                    kind="field_mismatch",
                    detail=(
                        f"token {token['token_id']!r} starts at output frame "
                        f"{token['out_start_frame']} but the previous token ends at {cursor}; "
                        "the output timeline has a gap or an overlap"
                    ),
                    token_id=token["token_id"],
                )
            )
        spans = {
            token["out_end_frame"] - token["out_start_frame"],
            token["src_end_frame"] - token["src_start_frame"],
            token["frame_count"],
        }
        if len(spans) != 1:
            found.append(
                Difference(
                    kind="field_mismatch",
                    detail=(
                        f"token {token['token_id']!r} frame counts disagree: output span, source span "
                        f"and frame_count are {sorted(spans)}"
                    ),
                    token_id=token["token_id"],
                )
            )
        cursor = token["out_end_frame"]
    return found


def _sweep(duration: int, uses: list[tuple[int, int, str]]) -> tuple[int, int, list[FrameRange], list[ReuseSite]]:
    """Walk the coverage count across one source's frame axis.

    Returns (used_once, reused, dropped_ranges, reuse_sites). A plain boundary sweep: every
    read starts at `start` and ends at `end`, so the coverage count only ever changes at those
    boundaries and the axis can be walked in one pass.
    """
    deltas: dict[int, int] = {}
    for start, end, _token_id in uses:
        deltas[start] = deltas.get(start, 0) + 1
        deltas[end] = deltas.get(end, 0) - 1

    used_once = 0
    reused = 0
    dropped: list[FrameRange] = []
    reuse_sites: list[ReuseSite] = []
    open_site: ReuseSite | None = None
    cursor = 0
    count = 0

    def absorb(start: int, end: int, depth: int) -> None:
        nonlocal used_once, reused, open_site
        span = end - start
        if span <= 0:
            return
        if depth == 0:
            dropped.append(FrameRange(start=start, end=end, frame_count=span))
        elif depth == 1:
            used_once += span
        else:
            reused += span
            if open_site is None:
                open_site = ReuseSite(start=start, end=end, frame_count=span, use_count=depth, token_ids=[])
            else:
                open_site["end"] = end
                open_site["frame_count"] = int(open_site["frame_count"]) + span
                open_site["use_count"] = max(int(open_site["use_count"]), depth)
        if depth < OVERLAP_DEPTH and open_site is not None:
            # A non-overlapping span ends the current reuse site. Without this, two disjoint
            # reuse regions would be merged into one site spanning the gap between them.
            reuse_sites.append(open_site)
            open_site = None

    for position in sorted(deltas):
        absorb(cursor, position, count)
        count += deltas[position]
        cursor = position
    absorb(cursor, duration, count)

    if open_site is not None:
        reuse_sites.append(open_site)
    for site in reuse_sites:
        site["token_ids"] = sorted(
            token_id
            for start, end, token_id in uses
            if start < int(site["end"]) and end > int(site["start"])
        )
    return used_once, reused, dropped, reuse_sites


def audit_coverage(timeline: Timeline) -> CoverageReport:
    """Account for every frame of every source.

    Overlapping reads are reported as reuse sites rather than as errors: reusing a range is
    legitimate for a flashback or a stinger, and a tool that forbids it would be wrong. What is
    asserted is the arithmetic — `conserved` is true only when the sweep adds up to the source
    duration exactly.
    """
    durations = {source["id"]: source["duration_frames"] for source in timeline["sources"]}
    by_source: dict[str, list[tuple[int, int, str]]] = {source_id: [] for source_id in durations}
    for token in timeline["tokens"]:
        by_source.setdefault(token["source_id"], []).append(
            (token["src_start_frame"], token["src_end_frame"], token["token_id"])
        )

    reports: list[SourceCoverage] = []
    total_dropped = 0
    total_reused = 0
    all_conserved = True

    for source in timeline["sources"]:
        source_id = source["id"]
        duration = source["duration_frames"]
        used_once, reused, dropped_ranges, reuse_sites = _sweep(duration, by_source[source_id])
        dropped = sum(int(r["frame_count"]) for r in dropped_ranges)
        covered = used_once + reused
        conserved = covered + dropped == duration
        all_conserved = all_conserved and conserved
        total_dropped += dropped
        total_reused += reused

        reports.append(
            SourceCoverage(
                source_id=source_id,
                duration_frames=duration,
                used_once_frames=used_once,
                reused_frames=reused,
                dropped_frames=dropped,
                covered_frames=covered,
                conserved=conserved,
                dropped_ranges=dropped_ranges,
                reuse_sites=reuse_sites,
            )
        )

    return CoverageReport(
        sources=reports,
        total_dropped_frames=total_dropped,
        total_reused_frames=total_reused,
        all_conserved=all_conserved,
    )


def frames_to_timecode(frames: int, rate: Rate) -> str:
    """Frames as `HH:MM:SS:FF`.

    Non-drop-frame, using the nominal integer rate (`round(num/den)`) for the frames field.
    Drop-frame timecode is deliberately not implemented: it is a display convention for
    29.97fps that drops two frame numbers a minute to keep wall-clock time honest. This module
    reports *frame counts*, and a frames field that silently skips numbers would be worse than
    no timecode at all. Exact wall-clock duration is available separately as a rational.
    """
    nominal = round(rate["num"] / rate["den"])
    if nominal <= 0:
        raise EngineError("BAD_RATE", "frame rate must resolve to a positive nominal rate")
    if frames < 0:
        raise EngineError("BAD_FRAMES", f"frame count must not be negative, got {frames}")

    total_seconds, frame_remainder = divmod(frames, nominal)
    minutes, seconds = divmod(total_seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{frame_remainder:02d}"


def exact_duration(frames: int, rate: Rate) -> Rate:
    """Wall-clock duration of `frames` frames as an exact, reduced rational in seconds."""
    numerator = frames * rate["den"]
    denominator = rate["num"]
    divisor = gcd(numerator, denominator) or 1
    return Rate(num=numerator // divisor, den=denominator // divisor)


def timeline_summary(timeline: Timeline) -> TimelineSummary:
    """The numbers a human reads first."""
    tokens = timeline["tokens"]
    histogram: dict[str, int] = {}
    for token in tokens:
        key = token["transition"]
        histogram[key] = histogram.get(key, 0) + 1

    violations = timeline["violations"]
    total = timeline["total_out_frames"]
    return TimelineSummary(
        token_count=len(tokens),
        total_out_frames=total,
        total_out_timecode=frames_to_timecode(total, timeline["frame_rate"]),
        total_out_seconds=exact_duration(total, timeline["frame_rate"]),
        distinct_sources=len({token["source_id"] for token in tokens}),
        transition_histogram=dict(sorted(histogram.items())),
        longest_token_frames=max((token["frame_count"] for token in tokens), default=0),
        error_count=sum(1 for v in violations if v["severity"] == "error"),
        warning_count=sum(1 for v in violations if v["severity"] == "warning"),
    )


def _parse_tokens(raw: Any) -> list[EditToken]:
    items = raw.get("tokens")
    if not isinstance(items, list):
        raise EngineError("BAD_SHAPE", "timeline.tokens must be an array")
    tokens: list[EditToken] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise EngineError("BAD_SHAPE", f"timeline.tokens[{index}] must be an object")
        prefix = f"timeline.tokens[{index}]"
        tokens.append(
            EditToken(
                token_id=_opt_str(item.get("token_id"), f"{prefix}.token_id", f"t{index:05d}"),
                index=_opt_int(item.get("index"), f"{prefix}.index", index),
                out_start_frame=_opt_int(item.get("out_start_frame"), f"{prefix}.out_start_frame", 0),
                out_end_frame=_opt_int(item.get("out_end_frame"), f"{prefix}.out_end_frame", 0),
                frame_count=_opt_int(item.get("frame_count"), f"{prefix}.frame_count", 0),
                source_id=_opt_str(item.get("source_id"), f"{prefix}.source_id", ""),
                src_start_frame=_opt_int(item.get("src_start_frame"), f"{prefix}.src_start_frame", 0),
                src_end_frame=_opt_int(item.get("src_end_frame"), f"{prefix}.src_end_frame", 0),
                transition=_opt_str(item.get("transition"), f"{prefix}.transition", DEFAULT_TRANSITION),
            )
        )
    return tokens


def _parse_sources(raw: Any) -> list[SourceProgram]:
    items = raw.get("sources")
    if not isinstance(items, list):
        return []
    sources: list[SourceProgram] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise EngineError("BAD_SHAPE", f"timeline.sources[{index}] must be an object")
        prefix = f"timeline.sources[{index}]"
        built: SourceProgram = {
            "id": _opt_str(item.get("id"), f"{prefix}.id", ""),
            "duration_frames": _opt_int(item.get("duration_frames"), f"{prefix}.duration_frames", 0),
        }
        label = item.get("label")
        if isinstance(label, str) and label:
            built["label"] = label
        sources.append(built)
    return sources


def _parse_violations(raw: Any) -> list[Violation]:
    items = raw.get("violations")
    if not isinstance(items, list):
        return []
    violations: list[Violation] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise EngineError("BAD_SHAPE", f"timeline.violations[{index}] must be an object")
        severity: Severity
        if item.get("severity") == "error":
            severity = "error"
        elif item.get("severity") == "warning":
            severity = "warning"
        else:
            raise EngineError(
                "BAD_SHAPE",
                f'timeline.violations[{index}].severity must be "error" or "warning"',
            )
        code = item.get("code")
        message = item.get("message")
        if not isinstance(code, str) or not isinstance(message, str):
            raise EngineError(
                "BAD_SHAPE", f"timeline.violations[{index}] needs a string code and message"
            )
        parsed: Violation = {"code": code, "severity": severity, "message": message}
        entry_index = item.get("entry_index")
        if isinstance(entry_index, int) and not isinstance(entry_index, bool):
            parsed["entry_index"] = entry_index
        token_id = item.get("token_id")
        if isinstance(token_id, str):
            parsed["token_id"] = token_id
        field = item.get("field")
        if isinstance(field, str):
            parsed["field"] = field
        violations.append(parsed)
    return violations


def parse_timeline(raw: Any) -> Timeline:
    """Rebuild a Timeline from JSON, as returned by `compile_timeline`.

    The declaration is re-parsed through `parse_edl` rather than cast, so this path cannot drift
    from the compiler's own definition of a valid entry.
    """
    if not isinstance(raw, dict):
        raise EngineError("BAD_SHAPE", "timeline must be an object")

    rate_raw = raw.get("frame_rate")
    frame_rate: Rate = parse_rate(rate_raw) if isinstance(rate_raw, dict) else Rate(num=30, den=1)
    tokens = _parse_tokens(raw)

    return Timeline(
        frame_rate=frame_rate,
        sources=_parse_sources(raw),
        tokens=tokens,
        declared_edl=parse_edl(raw.get("declared_edl")),
        total_out_frames=_opt_int(raw.get("total_out_frames"), "timeline.total_out_frames", 0),
        emitted_entries=_opt_int(raw.get("emitted_entries"), "timeline.emitted_entries", len(tokens)),
        dropped_entries=_opt_int(raw.get("dropped_entries"), "timeline.dropped_entries", 0),
        violations=_parse_violations(raw),
    )
