"""Property tests for the invariants the product's claim rests on.

The claim is "proven lossless, frame-exact". A claim like that is only worth anything if the
invariants are tested against inputs nobody chose by hand, which is what hypothesis is for.

The four load-bearing invariants:

* **conservation**  — the output timeline is exactly as long as the sum of its tokens
* **losslessness**  — the declaration can be rebuilt from the tokens alone
* **idempotence**   — recompiling the reconstruction reproduces the same timeline
* **accounting**    — every source frame is used or explicitly dropped, and the sweep adds up
"""

from __future__ import annotations

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from waveform_forge.audit import audit_coverage, reconstruct, verify_roundtrip
from waveform_forge.compile import compile_timeline, expected_token_id, validate_declaration

RATES = [(30, 1), (25, 1), (24, 1), (60, 1), (30000, 1001)]
TRANSITIONS = ["cut", "dissolve", "dip_to_black", "dip_from_black", "wipe"]

PROFILE = settings(
    max_examples=60,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)


@st.composite
def programs(draw: st.DrawFn) -> dict:
    count = draw(st.integers(min_value=1, max_value=3))
    sources = [
        {"id": f"src_{index}", "duration_frames": draw(st.integers(min_value=1, max_value=400))}
        for index in range(count)
    ]
    rate = draw(st.sampled_from(RATES))
    return {"frame_rate": {"num": rate[0], "den": rate[1]}, "sources": sources}


@st.composite
def edits(draw: st.DrawFn) -> tuple[dict, list[dict]]:
    """A program paired with an EDL that is guaranteed tokenizable.

    The EDL is drawn against the program's own durations so a generated example never has to be
    repaired before use — otherwise every example would exercise the error path instead of the
    invariant.
    """
    program = draw(programs())
    size = draw(st.integers(min_value=0, max_value=8))
    edl: list[dict] = []
    for _ in range(size):
        source = draw(st.sampled_from(program["sources"]))
        duration = source["duration_frames"]
        count = draw(st.integers(min_value=1, max_value=duration))
        start = draw(st.integers(min_value=0, max_value=duration - count))
        entry: dict = {
            "source_id": source["id"],
            "src_start_frame": start,
            "frame_count": count,
        }
        if draw(st.booleans()):
            entry["transition"] = draw(st.sampled_from(TRANSITIONS))
        edl.append(entry)
    return program, edl


@pytest.mark.property
class TestConservation:
    @PROFILE
    @given(edits())
    def test_output_is_exactly_the_sum_of_its_tokens(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        timeline = compile_timeline(program, edl)
        assert sum(token["frame_count"] for token in timeline["tokens"]) == timeline["total_out_frames"]

    @PROFILE
    @given(edits())
    def test_every_token_has_one_consistent_frame_count(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        for token in compile_timeline(program, edl)["tokens"]:
            assert token["out_end_frame"] - token["out_start_frame"] == token["frame_count"]
            assert token["src_end_frame"] - token["src_start_frame"] == token["frame_count"]

    @PROFILE
    @given(edits())
    def test_the_output_has_no_gaps_or_overlaps(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        cursor = 0
        for token in compile_timeline(program, edl)["tokens"]:
            assert token["out_start_frame"] == cursor
            cursor = token["out_end_frame"]

    @PROFILE
    @given(edits())
    def test_no_token_reads_past_its_source(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        durations = {source["id"]: source["duration_frames"] for source in program["sources"]}
        for token in compile_timeline(program, edl)["tokens"]:
            assert 0 <= token["src_start_frame"] < token["src_end_frame"] <= durations[token["source_id"]]


@pytest.mark.property
class TestLosslessness:
    @PROFILE
    @given(edits())
    def test_a_valid_declaration_is_always_lossless(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        assert verify_roundtrip(compile_timeline(program, edl))["lossless"] is True

    @PROFILE
    @given(edits())
    def test_a_valid_declaration_reports_no_errors(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        found = validate_declaration(program, edl)
        assert [violation for violation in found if violation["severity"] == "error"] == []

    @PROFILE
    @given(edits())
    def test_every_declared_entry_becomes_a_token(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        timeline = compile_timeline(program, edl)
        assert timeline["emitted_entries"] == len(edl)
        assert timeline["dropped_entries"] == 0


@pytest.mark.property
class TestIdempotence:
    @PROFILE
    @given(edits())
    def test_recompiling_the_reconstruction_reproduces_the_timeline(
        self, drawn: tuple[dict, list[dict]]
    ) -> None:
        program, edl = drawn
        timeline = compile_timeline(program, edl)
        again = compile_timeline(program, reconstruct(timeline))
        assert again["tokens"] == timeline["tokens"]
        assert again["total_out_frames"] == timeline["total_out_frames"]

    @PROFILE
    @given(edits())
    def test_synthesized_ids_are_stable(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        tokens = compile_timeline(program, edl)["tokens"]
        assert [token["token_id"] for token in tokens] == [
            expected_token_id(index, entry.get("token_id")) for index, entry in enumerate(edl)
        ]


@pytest.mark.property
class TestAccounting:
    @PROFILE
    @given(edits())
    def test_every_source_frame_is_used_or_dropped(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        report = audit_coverage(compile_timeline(program, edl))
        for coverage in report["sources"]:
            assert (
                coverage["used_once_frames"]
                + coverage["reused_frames"]
                + coverage["dropped_frames"]
                == coverage["duration_frames"]
            )
            assert coverage["conserved"] is True
        assert report["all_conserved"] is True

    @PROFILE
    @given(edits())
    def test_dropped_ranges_partition_the_unused_axis(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        report = audit_coverage(compile_timeline(program, edl))
        for coverage in report["sources"]:
            assert sum(r["frame_count"] for r in coverage["dropped_ranges"]) == coverage["dropped_frames"]
            for frame_range in coverage["dropped_ranges"]:
                assert frame_range["end"] - frame_range["start"] == frame_range["frame_count"]

    @PROFILE
    @given(edits())
    def test_reuse_sites_do_not_span_unused_frames(self, drawn: tuple[dict, list[dict]]) -> None:
        program, edl = drawn
        report = audit_coverage(compile_timeline(program, edl))
        for coverage in report["sources"]:
            for site in coverage["reuse_sites"]:
                assert site["end"] - site["start"] == site["frame_count"]
                assert site["frame_count"] > 0
                assert site["use_count"] >= 2
                assert site["token_ids"]


@pytest.mark.property
class TestMonotonicity:
    @PROFILE
    @given(edits())
    def test_appending_a_cut_grows_the_timeline_by_exactly_its_length(
        self, drawn: tuple[dict, list[dict]]
    ) -> None:
        program, edl = drawn
        before = compile_timeline(program, edl)
        # The appended cut must itself be tokenizable, or this would be testing the rejection
        # path instead of monotonicity.
        duration = program["sources"][0]["duration_frames"]
        extra = min(7, duration)
        appended = compile_timeline(program, [*edl, {
            "source_id": program["sources"][0]["id"],
            "src_start_frame": 0,
            "frame_count": extra,
        }])
        assert appended["total_out_frames"] == before["total_out_frames"] + extra
        assert appended["tokens"][: len(before["tokens"])] == before["tokens"]

    @PROFILE
    @given(edits())
    def test_emptying_the_edl_empties_the_timeline(self, drawn: tuple[dict, list[dict]]) -> None:
        program, _edl = drawn
        assert compile_timeline(program, [])["tokens"] == []
