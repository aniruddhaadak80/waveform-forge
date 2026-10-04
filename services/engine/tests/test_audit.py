"""Round-trip proof, frame conservation, and exact timecode."""

from __future__ import annotations

import json

import pytest

from factories import entry, program, source
from waveform_forge.analysis import op_audit_coverage, op_timeline_summary, op_verify_roundtrip
from waveform_forge.audit import (
    audit_coverage,
    exact_duration,
    frames_to_timecode,
    timeline_summary,
    verify_roundtrip,
)
from waveform_forge.compile import compile_timeline
from waveform_forge.protocol import EngineError

ONE_CAM = program([source("cam_a", 1000)])
TWO_CAM = program([source("cam_a", 1000), source("cam_b", 500)])
FPS_2997 = program([source("cam_a", 1000)], rate=(30000, 1001))


def compiled(p: dict = TWO_CAM, entries: list | None = None) -> dict:
    return compile_timeline(p, entries if entries is not None else [entry("cam_a", 0, 100)])


class TestVerifyRoundtrip:
    def test_a_sound_timeline_is_lossless(self) -> None:
        report = verify_roundtrip(compiled(entries=[entry("cam_a", 0, 50), entry("cam_b", 10, 20)]))
        assert report["lossless"] is True
        assert report["differences"] == []
        assert report["declared_entries"] == 2
        assert report["reconstructed_entries"] == 2

    def test_a_dropped_entry_makes_the_timeline_lossy(self) -> None:
        timeline = compile_timeline(ONE_CAM, [entry("cam_a", 0, 50), entry("cam_a", 995, 100)])
        report = verify_roundtrip(timeline)
        assert report["lossless"] is False
        assert report["reconstructed_entries"] == 1
        assert any(d["kind"] == "entry_count" for d in report["differences"])
        assert any(d["kind"] == "missing_entry" for d in report["differences"])

    def test_a_duplicated_declared_id_is_reported_once_not_twice(self) -> None:
        # Both entries claim the same id, so it cannot be aligned to a single entry. That is
        # DUPLICATE_TOKEN_ID's job; counting it again here would double-report one defect.
        timeline = compile_timeline(ONE_CAM, [
            entry("cam_a", 0, 50, token_id="dup"),
            entry("cam_a", 60, 50, token_id="dup"),
        ])
        report = verify_roundtrip(timeline)
        missing = [d for d in report["differences"] if d["kind"] == "missing_entry"]
        assert missing == []

    def test_detects_a_gap_between_tokens(self) -> None:
        # Simulates a corrupted timeline: the tokenizer can never emit this, so if the check
        # passes it the round-trip guard has stopped guarding.
        timeline = compiled()
        timeline["tokens"][0]["out_start_frame"] = 7
        report = verify_roundtrip(timeline)
        assert report["lossless"] is False
        assert any("gap or an overlap" in d["detail"] for d in report["differences"])

    def test_detects_inconsistent_frame_counts(self) -> None:
        timeline = compiled()
        timeline["tokens"][0]["frame_count"] = 999
        report = verify_roundtrip(timeline)
        assert report["lossless"] is False
        assert any("frame counts disagree" in d["detail"] for d in report["differences"])


class TestAuditCoverage:
    def test_accounts_for_every_frame_of_every_source(self) -> None:
        timeline = compiled(entries=[entry("cam_a", 0, 100)])
        report = audit_coverage(timeline)
        cam_a = next(s for s in report["sources"] if s["source_id"] == "cam_a")
        cam_b = next(s for s in report["sources"] if s["source_id"] == "cam_b")
        assert cam_a["used_once_frames"] == 100
        assert cam_a["dropped_frames"] == 900
        assert cam_a["conserved"] is True
        assert cam_b["used_once_frames"] == 0
        assert cam_b["dropped_frames"] == 500
        assert cam_b["dropped_ranges"] == [{"start": 0, "end": 500, "frame_count": 500}]

    def test_reports_an_overlapping_read_as_a_reuse_site(self) -> None:
        # [0,50) is read once, [50,100) twice, [100,150) once.
        timeline = compiled(entries=[
            entry("cam_a", 0, 100),
            entry("cam_a", 50, 100),
        ])
        cam_a = audit_coverage(timeline)["sources"][0]
        assert cam_a["used_once_frames"] == 100
        assert cam_a["reused_frames"] == 50
        site = cam_a["reuse_sites"][0]
        assert (site["start"], site["end"], site["use_count"]) == (50, 100, 2)
        assert site["token_ids"] == ["t00000", "t00001"]

    def test_three_way_overlap_reports_the_highest_use_count(self) -> None:
        timeline = compiled(entries=[
            entry("cam_a", 0, 100),
            entry("cam_a", 0, 100),
            entry("cam_a", 0, 100),
        ])
        cam_a = audit_coverage(timeline)["sources"][0]
        assert cam_a["reused_frames"] == 100
        assert cam_a["reuse_sites"][0]["use_count"] == 3

    def test_a_source_read_from_start_to_finish_has_no_dropped_ranges(self) -> None:
        timeline = compiled(entries=[entry("cam_a", 0, 1000)])
        cam_a = audit_coverage(timeline)["sources"][0]
        assert cam_a["dropped_ranges"] == []
        assert cam_a["dropped_frames"] == 0
        assert cam_a["conserved"] is True

    def test_two_separate_reads_produce_two_dropped_ranges(self) -> None:
        timeline = compiled(entries=[entry("cam_a", 100, 50), entry("cam_a", 300, 50)])
        cam_a = audit_coverage(timeline)["sources"][0]
        assert cam_a["dropped_ranges"] == [
            {"start": 0, "end": 100, "frame_count": 100},
            {"start": 150, "end": 300, "frame_count": 150},
            {"start": 350, "end": 1000, "frame_count": 650},
        ]

    def test_reuse_of_the_whole_axis_has_no_dropped_tail(self) -> None:
        timeline = compiled(entries=[entry("cam_a", 0, 1000), entry("cam_a", 0, 1000)])
        cam_a = audit_coverage(timeline)["sources"][0]
        assert cam_a["dropped_ranges"] == []
        assert cam_a["reused_frames"] == 1000
        assert cam_a["conserved"] is True

    def test_totals_are_reported(self) -> None:
        timeline = compiled(entries=[entry("cam_a", 0, 100), entry("cam_b", 0, 50)])
        report = audit_coverage(timeline)
        assert report["total_dropped_frames"] == 1350
        assert report["total_reused_frames"] == 0
        assert report["all_conserved"] is True


class TestFramesToTimecode:
    @pytest.mark.parametrize(
        ("frames", "rate", "expected"),
        [
            (0, (30, 1), "00:00:00:00"),
            (1, (30, 1), "00:00:00:01"),
            (30, (30, 1), "00:00:01:00"),
            (1800, (30, 1), "00:01:00:00"),
            (108_000, (30, 1), "01:00:00:00"),
            (25, (25, 1), "00:00:01:00"),
            (24, (24, 1), "00:00:01:00"),
            (600, (30000, 1001), "00:00:20:00"),
        ],
    )
    def test_formats_frames_as_timecode(self, frames: int, rate: tuple[int, int], expected: str) -> None:
        assert frames_to_timecode(frames, {"num": rate[0], "den": rate[1]}) == expected

    def test_rejects_a_negative_frame_count(self) -> None:
        with pytest.raises(EngineError) as caught:
            frames_to_timecode(-1, {"num": 30, "den": 1})
        assert caught.value.code == "BAD_FRAMES"

    def test_2997_uses_the_nominal_rate_and_says_so_in_the_exact_duration(self) -> None:
        # 600 frames at 30000/1001 is 20.02s, not 20s. The timecode field shows 20:00 because
        # 29.97 is not an integer rate; the exact rational carries the truth.
        assert frames_to_timecode(600, {"num": 30000, "den": 1001}) == "00:00:20:00"
        assert exact_duration(600, {"num": 30000, "den": 1001}) == {"num": 1001, "den": 50}

    def test_exact_duration_is_reduced(self) -> None:
        assert exact_duration(90000, {"num": 30000, "den": 1001}) == {"num": 3003, "den": 1}


class TestTimelineSummary:
    def test_reports_counts_and_a_histogram(self) -> None:
        timeline = compiled(entries=[
            entry("cam_a", 0, 100),
            entry("cam_b", 0, 40, transition="dissolve"),
            entry("cam_a", 200, 60),
        ])
        result = timeline_summary(timeline)
        assert result["token_count"] == 3
        assert result["total_out_frames"] == 200
        assert result["distinct_sources"] == 2
        assert result["transition_histogram"] == {"cut": 2, "dissolve": 1}
        assert result["longest_token_frames"] == 100

    def test_an_empty_timeline_summarizes_to_zero(self) -> None:
        result = timeline_summary(compile_timeline(ONE_CAM, []))
        assert result["token_count"] == 0
        assert result["longest_token_frames"] == 0
        assert result["transition_histogram"] == {}


class TestAuditOpsOverTheWire:
    def test_verify_roundtrip_op_accepts_a_compiled_timeline(self) -> None:
        result = op_verify_roundtrip({"timeline": compiled()})
        assert result["lossless"] is True

    def test_audit_coverage_op_accepts_a_compiled_timeline(self) -> None:
        result = op_audit_coverage({"timeline": compiled()})
        assert result["all_conserved"] is True

    def test_timeline_summary_op_accepts_a_compiled_timeline(self) -> None:
        assert op_timeline_summary({"timeline": compiled()})["token_count"] == 1

    def test_rejects_a_timeline_that_is_not_an_object(self) -> None:
        with pytest.raises(EngineError) as caught:
            op_audit_coverage({"timeline": []})
        assert caught.value.code == "BAD_SHAPE"

    def test_rejects_a_timeline_with_no_tokens_array(self) -> None:
        with pytest.raises(EngineError) as caught:
            op_audit_coverage({"timeline": {"declared_edl": []}})
        assert caught.value.code == "BAD_SHAPE"

    def test_survives_the_round_trip_through_json(self) -> None:
        # The host parses and re-serializes the timeline, so the audits must work on the
        # decoded shape rather than on an in-memory object graph.
        timeline = json.loads(json.dumps(compiled(entries=[
            entry("cam_a", 0, 100),
            entry("cam_a", 50, 100),
        ])))
        assert op_audit_coverage({"timeline": timeline})["total_reused_frames"] == 50
        assert op_verify_roundtrip({"timeline": timeline})["lossless"] is True
