"""The tokenizer: a declared edit becomes a stream of edit tokens.

This is the part of waveform-forge that must never be a model call. A model can propose an
edit; only this code can say whether its frames add up.

Design decisions worth knowing before reading the code:

* **Violation-carrying, not exception-throwing.** `compile_timeline` never raises on a bad
  declaration. It emits every token it can and returns the reasons it could not emit the rest,
  so one bad cut does not hide the next nine.
* **Never clamp.** An out-of-range source read is reported, not silently truncated. Clamping is
  how a half-second of a person's interview disappears without anyone noticing.
* **Integer frames only.** No float ever appears in this module.
"""

from __future__ import annotations

from typing import Any

from .model import (
    TRANSITIONS,
    EdlEntry,
    EditToken,
    Program,
    Rate,
    SourceProgram,
    Timeline,
    Violation,
)
from .protocol import EngineError

DEFAULT_TRANSITION = "cut"


def _as_int(value: Any, field: str) -> int:
    """Frames are integers. `bool` is rejected explicitly: `isinstance(True, int)` is True in
    Python, and `{"frame_count": true}` must not become a one-frame cut."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise EngineError("BAD_SHAPE", f"{field} must be an integer, got {type(value).__name__}")
    return value


def _as_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise EngineError("BAD_SHAPE", f"{field} must be a non-empty string")
    return value


def parse_rate(raw: Any) -> Rate:
    if not isinstance(raw, dict):
        raise EngineError("BAD_SHAPE", "program.frame_rate must be an object")
    num = _as_int(raw.get("num"), "program.frame_rate.num")
    den = _as_int(raw.get("den"), "program.frame_rate.den")
    if num <= 0 or den <= 0:
        raise EngineError("BAD_RATE", f"frame rate {num}/{den} must have positive numerator and denominator")
    return {"num": num, "den": den}


def parse_program(raw: Any) -> Program:
    """Validate the shape of a program. Structural problems raise; content problems do not."""
    if not isinstance(raw, dict):
        raise EngineError("BAD_SHAPE", "program must be an object")
    raw_sources = raw.get("sources")
    if not isinstance(raw_sources, list):
        raise EngineError("BAD_SHAPE", "program.sources must be an array")
    if not raw_sources:
        raise EngineError("EMPTY_PROGRAM", "program.sources must declare at least one source")

    sources: list[SourceProgram] = []
    seen: set[str] = set()
    for index, item in enumerate(raw_sources):
        if not isinstance(item, dict):
            raise EngineError("BAD_SHAPE", f"program.sources[{index}] must be an object")
        source_id = _as_str(item.get("id"), f"program.sources[{index}].id")
        duration = _as_int(item.get("duration_frames"), f"program.sources[{index}].duration_frames")
        if source_id in seen:
            raise EngineError("DUPLICATE_SOURCE", f"program.sources[{index}].id {source_id!r} is declared twice")
        seen.add(source_id)
        if duration <= 0:
            raise EngineError(
                "BAD_DURATION", f"program.sources[{index}].duration_frames must be positive, got {duration}"
            )
        label = item.get("label")
        source: SourceProgram = {"id": source_id, "duration_frames": duration}
        if isinstance(label, str) and label:
            source["label"] = label
        sources.append(source)

    return {"frame_rate": parse_rate(raw.get("frame_rate")), "sources": sources}


def parse_edl(raw: Any) -> list[EdlEntry]:
    if not isinstance(raw, list):
        raise EngineError("BAD_SHAPE", "edl must be an array")
    entries: list[EdlEntry] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise EngineError("BAD_SHAPE", f"edl[{index}] must be an object")
        entry: EdlEntry = {
            "source_id": _as_str(item.get("source_id"), f"edl[{index}].source_id"),
            "src_start_frame": _as_int(item.get("src_start_frame"), f"edl[{index}].src_start_frame"),
            "frame_count": _as_int(item.get("frame_count"), f"edl[{index}].frame_count"),
        }
        transition = item.get("transition", DEFAULT_TRANSITION)
        entry["transition"] = _as_str(transition, f"edl[{index}].transition")
        token_id = item.get("token_id")
        if token_id is not None:
            entry["token_id"] = _as_str(token_id, f"edl[{index}].token_id")
        entries.append(entry)
    return entries


def _entry_violations(
    entry: EdlEntry,
    index: int,
    sources: dict[str, int],
    claimed_ids: dict[str, int],
) -> list[Violation]:
    """Content checks for one declared entry. Shared by validation and compilation so the two
    can never disagree about what is wrong with an edit."""
    found: list[Violation] = []
    source_id = entry["source_id"]

    if source_id not in sources:
        found.append(
            Violation(
                code="UNKNOWN_SOURCE",
                severity="error",
                message=f"entry references undeclared source {source_id!r}",
                entry_index=index,
                field="source_id",
            )
        )
        return found  # range checks are meaningless without a duration

    duration = sources[source_id]
    start = entry["src_start_frame"]
    count = entry["frame_count"]

    if count <= 0:
        found.append(
            Violation(
                code="NON_POSITIVE_LENGTH",
                severity="error",
                message=f"entry has frame_count {count}; a token must cover at least one frame",
                entry_index=index,
                field="frame_count",
            )
        )
    if start < 0:
        found.append(
            Violation(
                code="NEGATIVE_START",
                severity="error",
                message=f"entry starts at frame {start}; source frames start at 0",
                entry_index=index,
                field="src_start_frame",
            )
        )
    elif start >= duration:
        found.append(
            Violation(
                code="START_PAST_END",
                severity="error",
                message=f"entry starts at frame {start} but source {source_id!r} is only {duration} frames long",
                entry_index=index,
                field="src_start_frame",
            )
        )
    if count > 0 and start >= 0 and start + count > duration:
        found.append(
            Violation(
                code="READS_PAST_END",
                severity="error",
                message=(
                    f"entry reads frames {start}..{start + count} but source {source_id!r} "
                    f"ends at frame {duration}"
                ),
                entry_index=index,
                field="frame_count",
            )
        )

    transition = entry.get("transition", DEFAULT_TRANSITION)
    if transition not in TRANSITIONS:
        found.append(
            Violation(
                code="UNKNOWN_TRANSITION",
                severity="error",
                message=f"unknown transition {transition!r}; expected one of {', '.join(TRANSITIONS)}",
                entry_index=index,
                field="transition",
            )
        )

    token_id = entry.get("token_id")
    if token_id is not None:
        if token_id in claimed_ids:
            found.append(
                Violation(
                    code="DUPLICATE_TOKEN_ID",
                    severity="error",
                    message=(
                        f"token_id {token_id!r} was already used by entry {claimed_ids[token_id]}"
                    ),
                    entry_index=index,
                    token_id=token_id,
                    field="token_id",
                )
            )
        else:
            claimed_ids[token_id] = index
    return found


def expected_token_id(index: int, declared_id: str | None) -> str:
    """The id an entry will carry: its own if it declared one, else a stable positional id.

    Declared here rather than in the auditor so the compiler and the round-trip check cannot
    disagree about the rule. If they did, every tokenized timeline would look lossy.
    """
    return declared_id if declared_id else f"t{index:05d}"


def validate_declaration(program: Program, edl: list[EdlEntry]) -> list[Violation]:
    """Pre-flight an edit without compiling it.

    Reports every problem it can see, in declaration order, so the author fixes one pass of
    errors instead of one error per run.
    """
    sources = {source["id"]: source["duration_frames"] for source in program["sources"]}
    claimed: dict[str, int] = {}
    violations: list[Violation] = []

    for index, entry in enumerate(edl):
        violations.extend(_entry_violations(entry, index, sources, claimed))

    for index, entry in enumerate(edl):
        transition = entry.get("transition", DEFAULT_TRANSITION)
        if index == 0 and transition != DEFAULT_TRANSITION:
            violations.append(
                Violation(
                    code="TRANSITION_WITHOUT_PREDECESSOR",
                    severity="warning",
                    message=(
                        f"first token declares transition {transition!r}, but a transition applies "
                        "between two tokens and this one has no left neighbour"
                    ),
                    entry_index=index,
                    field="transition",
                )
            )
    return violations


def compile_timeline(program: Program, edl: list[EdlEntry]) -> Timeline:
    """Tokenize a declaration.

    Tokens are laid end to end on the output timeline: each token's `out_start_frame` is the
    previous token's `out_end_frame`, so the output is gapless by construction. An entry that
    fails validation is skipped and reported, never clamped.
    """
    sources = {source["id"]: source["duration_frames"] for source in program["sources"]}
    claimed: dict[str, int] = {}
    tokens: list[EditToken] = []
    violations: list[Violation] = []
    cursor = 0

    for index, entry in enumerate(edl):
        entry_violations = _entry_violations(entry, index, sources, claimed)
        violations.extend(entry_violations)

        blocking = [v for v in entry_violations if v["severity"] == "error"]
        if blocking:
            continue

        token_id = expected_token_id(index, entry.get("token_id"))
        src_start = entry["src_start_frame"]
        count = entry["frame_count"]
        tokens.append(
            EditToken(
                token_id=token_id,
                index=index,
                out_start_frame=cursor,
                out_end_frame=cursor + count,
                frame_count=count,
                source_id=entry["source_id"],
                src_start_frame=src_start,
                src_end_frame=src_start + count,
                transition=entry.get("transition", DEFAULT_TRANSITION),
            )
        )
        cursor += count

    for index, entry in enumerate(edl):
        transition = entry.get("transition", DEFAULT_TRANSITION)
        if index == 0 and transition != DEFAULT_TRANSITION:
            violations.append(
                Violation(
                    code="TRANSITION_WITHOUT_PREDECESSOR",
                    severity="warning",
                    message=(
                        f"first token declares transition {transition!r}, but a transition applies "
                        "between two tokens and this one has no left neighbour"
                    ),
                    entry_index=index,
                    field="transition",
                )
            )

    return Timeline(
        frame_rate=program["frame_rate"],
        sources=program["sources"],
        tokens=tokens,
        declared_edl=edl,
        total_out_frames=cursor,
        emitted_entries=len(tokens),
        dropped_entries=len(edl) - len(tokens),
        violations=violations,
    )
