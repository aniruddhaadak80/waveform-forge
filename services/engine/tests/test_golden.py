"""The anti-drift test.

A golden file pins the tokenizer's exact output for a fixed input. Property tests prove the
invariants hold; this proves the *arithmetic* has not quietly changed underneath them — the
failure mode where every invariant still passes but every number is different, which is the one
a consumer of a rendered frame count would actually notice.

Regenerate deliberately, and read the diff before committing it:

    python services/engine/regenerate_golden.py
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from waveform_forge.analysis import op_audit_coverage, op_certify, op_verify_roundtrip
from waveform_forge.compile import compile_timeline

GOLDEN = Path(__file__).parent / "golden" / "timeline_v1.json"

#: A three-source assembly with a deliberate overlap, a dissolve and an unused tail, so the
#: golden file exercises the interesting paths rather than a happy path.
PROGRAM: dict[str, Any] = {
    "frame_rate": {"num": 30000, "den": 1001},
    "sources": [
        {"id": "cam_a", "duration_frames": 45_000, "label": "Street interview"},
        {"id": "cam_b", "duration_frames": 30_000, "label": "B-roll city"},
        {"id": "cam_c", "duration_frames": 12_000, "label": "Product macro"},
    ],
}

EDL: list[dict[str, Any]] = [
    {"source_id": "cam_a", "src_start_frame": 900, "frame_count": 1_200, "token_id": "open"},
    {"source_id": "cam_b", "src_start_frame": 0, "frame_count": 600, "transition": "dissolve"},
    {"source_id": "cam_c", "src_start_frame": 240, "frame_count": 90},
    # Starts three frames before `open` ends (900 + 1200 = 2100), so frames 2097..2100 are
    # read twice and coverage must report a reuse site.
    {"source_id": "cam_a", "src_start_frame": 2_097, "frame_count": 45},
    {"source_id": "cam_b", "src_start_frame": 600, "frame_count": 30, "transition": "dip_to_black"},
]


def build() -> dict[str, Any]:
    timeline = compile_timeline(PROGRAM, EDL)
    return {
        "description": "waveform-forge golden timeline v1",
        "input": {"program": PROGRAM, "edl": EDL},
        "timeline": timeline,
        "roundtrip": op_verify_roundtrip({"timeline": timeline}),
        "coverage": op_audit_coverage({"timeline": timeline}),
        # The whole certification, not just the verdict: the web app deploys a copy of this file
        # and renders its summary, round trip and coverage, so a trimmed golden would ship a page
        # with nothing to show.
        "certification": op_certify({"program": PROGRAM, "edl": EDL}),
    }


def load() -> dict[str, Any]:
    return json.loads(GOLDEN.read_text(encoding="utf8"))


class TestGoldenTimeline:
    def test_the_timeline_is_byte_identical_to_the_golden_file(self) -> None:
        assert build() == load()

    def test_the_golden_file_still_describes_the_current_scenario(self) -> None:
        # Guards against a regenerated golden that silently drifts away from the scenario above.
        assert load()["input"] == {"program": PROGRAM, "edl": EDL}

    def test_the_golden_scenario_certifies(self) -> None:
        assert load()["certification"]["verdict"] == "certified"

    def test_the_golden_output_is_frame_exact(self) -> None:
        # 1200 + 600 + 90 + 45 + 30 = 1965 frames.
        assert load()["timeline"]["total_out_frames"] == 1965
        assert load()["timeline"]["emitted_entries"] == 5
        assert load()["timeline"]["dropped_entries"] == 0

    def test_the_golden_coverage_reports_the_deliberate_overlap(self) -> None:
        coverage = load()["coverage"]
        assert coverage["total_reused_frames"] == 3
        assert coverage["all_conserved"] is True
        cam_a = next(s for s in coverage["sources"] if s["source_id"] == "cam_a")
        site = cam_a["reuse_sites"][0]
        assert (site["start"], site["end"], site["frame_count"]) == (2097, 2100, 3)
        assert site["token_ids"] == ["open", "t00003"]
