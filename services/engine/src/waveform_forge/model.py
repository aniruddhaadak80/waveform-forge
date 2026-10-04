"""The typed domain model for an edit timeline.

Everything here is a `TypedDict` rather than a `dict[str, Any]`, because the engine's whole
claim is that the arithmetic is exact. A typed boundary is what makes "exact" checkable by
mypy instead of by hope.

Frame arithmetic is **integer only**. A frame count is a frame count; nothing in this package
converts to a float, because 30000/1001 fps is not representable in binary floating point and
one lost ulp is one desynced frame.
"""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

Severity = Literal["error", "warning"]

#: The closed set of transitions a token may declare. An open set would make the timeline
#: unverifiable: the whole point of a tokenizer is that every token's shape is known ahead of
#: time, so a renderer never has to guess what a token means.
TRANSITIONS: tuple[str, ...] = ("cut", "dissolve", "dip_to_black", "dip_from_black", "wipe")


class Rate(TypedDict):
    """An exact frame rate as a rational. Never a float."""

    num: int
    den: int


class SourceProgram(TypedDict):
    """One recorded source program the edit may draw from."""

    id: str
    duration_frames: int
    label: NotRequired[str]


class Program(TypedDict):
    frame_rate: Rate
    sources: list[SourceProgram]


class EdlEntry(TypedDict):
    """One declared cut: take `frame_count` frames from `source_id` starting at
    `src_start_frame`, and place them in the output in this order.

    `token_id` is optional. When omitted the tokenizer synthesizes a stable positional id, so
    a caller never has to invent one; when supplied it is honoured, which makes a duplicate a
    real and reportable violation rather than an impossible state.
    """

    source_id: str
    src_start_frame: int
    frame_count: int
    transition: NotRequired[str]
    token_id: NotRequired[str]


class EditToken(TypedDict):
    """The tokenizer's output unit: one contiguous output span bound to one source span.

    The three lengths are equal by construction and must stay equal:
        out_end_frame - out_start_frame
      = src_end_frame - src_start_frame
      = frame_count
    That single equality is the conservation invariant the product exists to guarantee.
    """

    token_id: str
    index: int
    out_start_frame: int
    out_end_frame: int
    frame_count: int
    source_id: str
    src_start_frame: int
    src_end_frame: int
    transition: str


class Violation(TypedDict):
    """A machine-readable reason a declaration was rejected or a timeline deserves review."""

    code: str
    severity: Severity
    message: str
    entry_index: NotRequired[int]
    token_id: NotRequired[str]
    field: NotRequired[str]


class Timeline(TypedDict):
    """The compiled result, carrying the declaration it was compiled from.

    `declared_edl` is retained on purpose: round-trip verification is only meaningful if the
    timeline can be compared against the original intent rather than against itself.
    """

    frame_rate: Rate
    sources: list[SourceProgram]
    tokens: list[EditToken]
    declared_edl: list[EdlEntry]
    total_out_frames: int
    emitted_entries: int
    dropped_entries: int
    violations: list[Violation]


class ReconstructedEntry(TypedDict):
    source_id: str
    src_start_frame: int
    frame_count: int
    transition: str
    token_id: str


class Difference(TypedDict):
    kind: Literal["entry_count", "missing_entry", "field_mismatch"]
    detail: str
    entry_index: NotRequired[int]
    token_id: NotRequired[str]


class RoundTripReport(TypedDict):
    """Whether the timeline can be rebuilt into the declaration it came from."""

    lossless: bool
    declared_entries: int
    reconstructed_entries: int
    differences: list[Difference]


class FrameRange(TypedDict):
    start: int
    end: int
    frame_count: int


class ReuseSite(TypedDict):
    start: int
    end: int
    frame_count: int
    use_count: int
    token_ids: list[str]


class SourceCoverage(TypedDict):
    """Per-source frame accounting.

    The arithmetic identity every consumer can rely on:
        used_once_frames + reused_frames + dropped_frames == duration_frames
    `conserved` reports whether that identity actually held, so a bug in the sweep surfaces as
    a failed certification instead of a plausible-looking number.
    """

    source_id: str
    duration_frames: int
    used_once_frames: int
    reused_frames: int
    dropped_frames: int
    covered_frames: int
    conserved: bool
    dropped_ranges: list[FrameRange]
    reuse_sites: list[ReuseSite]


class CoverageReport(TypedDict):
    sources: list[SourceCoverage]
    total_dropped_frames: int
    total_reused_frames: int
    all_conserved: bool


class TimelineSummary(TypedDict):
    token_count: int
    total_out_frames: int
    total_out_timecode: str
    total_out_seconds: Rate
    distinct_sources: int
    transition_histogram: dict[str, int]
    longest_token_frames: int
    error_count: int
    warning_count: int


class Certification(TypedDict):
    """The headline verdict: may this edit be rendered?"""

    verdict: Literal["certified", "rejected"]
    summary: TimelineSummary
    roundtrip: RoundTripReport
    coverage: CoverageReport
    violations: list[Violation]
    errors: list[Violation]
    warnings: list[Violation]
    tokens: list[EditToken]
