"""The tokenizer and its pre-flight validation."""

from __future__ import annotations

import pytest

from factories import codes, entry, program, source
from waveform_forge.analysis import op_certify, op_compile_timeline, op_validate_declaration
from waveform_forge.compile import compile_timeline, parse_edl, parse_program, validate_declaration
from waveform_forge.protocol import EngineError

ONE_CAM = program([source("cam_a", 1000)])
TWO_CAM = program([source("cam_a", 1000), source("cam_b", 500)])


class TestParseProgram:
    def test_accepts_a_minimal_program(self) -> None:
        assert parse_program(ONE_CAM)["sources"][0]["duration_frames"] == 1000

    def test_keeps_a_label_when_given(self) -> None:
        parsed = parse_program(program([source("cam_a", 10, "Handheld")]))
        assert parsed["sources"][0]["label"] == "Handheld"

    @pytest.mark.parametrize(
        ("payload", "code"),
        [
            ({}, "BAD_SHAPE"),
            # A missing frame_rate is only reached once the sources pass; an empty list is
            # rejected as an empty program, not as a shape error.
            ({"sources": []}, "EMPTY_PROGRAM"),
            ({"frame_rate": {"num": 30, "den": 1}, "sources": []}, "EMPTY_PROGRAM"),
            ({"frame_rate": {"num": 30, "den": 1}, "sources": "no"}, "BAD_SHAPE"),
            ({"frame_rate": {"num": 0, "den": 1}, "sources": [{"id": "a", "duration_frames": 1}]},
             "BAD_RATE"),
            ({"frame_rate": {"num": 30, "den": 1},
              "sources": [{"id": "a", "duration_frames": 0}]}, "BAD_DURATION"),
            ({"frame_rate": {"num": 30, "den": 1},
              "sources": [{"id": "a", "duration_frames": 1}, {"id": "a", "duration_frames": 2}]},
             "DUPLICATE_SOURCE"),
        ],
    )
    def test_rejects_a_malformed_program_with_a_stable_code(self, payload: object, code: str) -> None:
        with pytest.raises(EngineError) as caught:
            parse_program(payload)
        assert caught.value.code == code

    def test_a_boolean_is_not_an_integer(self) -> None:
        # isinstance(True, int) is True in Python, so this needs an explicit guard.
        with pytest.raises(EngineError) as caught:
            parse_program({"frame_rate": {"num": 30, "den": 1},
                           "sources": [{"id": "a", "duration_frames": True}]})
        assert caught.value.code == "BAD_SHAPE"


class TestCompileTimeline:
    def test_lays_tokens_end_to_end_on_the_output(self) -> None:
        result = compile_timeline(TWO_CAM, [
            entry("cam_a", 0, 250),
            entry("cam_b", 100, 100, transition="dissolve"),
            entry("cam_a", 400, 50),
        ])
        assert [(t["out_start_frame"], t["out_end_frame"]) for t in result["tokens"]] == [
            (0, 250), (250, 350), (350, 400),
        ]
        assert result["total_out_frames"] == 400

    def test_token_spans_agree_in_output_and_source(self) -> None:
        result = compile_timeline(ONE_CAM, [entry("cam_a", 90, 10)])
        token = result["tokens"][0]
        assert token["out_end_frame"] - token["out_start_frame"] == token["frame_count"]
        assert token["src_end_frame"] - token["src_start_frame"] == token["frame_count"]

    def test_synthesizes_a_positional_id_when_none_is_declared(self) -> None:
        result = compile_timeline(ONE_CAM, [entry("cam_a", 0, 10), entry("cam_a", 20, 10)])
        assert [t["token_id"] for t in result["tokens"]] == ["t00000", "t00001"]

    def test_honours_a_declared_id(self) -> None:
        result = compile_timeline(ONE_CAM, [entry("cam_a", 0, 10, token_id="intro")])
        assert result["tokens"][0]["token_id"] == "intro"

    def test_defaults_the_transition_to_cut(self) -> None:
        assert compile_timeline(ONE_CAM, [entry("cam_a", 0, 10)])["tokens"][0]["transition"] == "cut"

    def test_an_empty_edl_is_an_empty_timeline(self) -> None:
        result = compile_timeline(ONE_CAM, [])
        assert result["tokens"] == []
        assert result["total_out_frames"] == 0
        assert result["dropped_entries"] == 0

    def test_reads_the_very_last_frame_of_a_source(self) -> None:
        result = compile_timeline(ONE_CAM, [entry("cam_a", 999, 1)])
        assert result["violations"] == []
        assert result["tokens"][0]["src_end_frame"] == 1000

    def test_reads_a_whole_single_frame_source(self) -> None:
        result = compile_timeline(program([source("clip", 1)]), [entry("clip", 0, 1)])
        assert result["total_out_frames"] == 1

    def test_a_rejected_entry_is_skipped_never_clamped(self) -> None:
        # The entry reads past the end of the source. Clamping it would silently shorten the
        # cut, which is exactly the failure this product exists to make loud.
        result = compile_timeline(ONE_CAM, [
            entry("cam_a", 0, 50),
            entry("cam_a", 990, 100),
            entry("cam_a", 100, 10),
        ])
        assert result["tokens"][0]["out_end_frame"] == 50
        assert [t["frame_count"] for t in result["tokens"]] == [50, 10]
        assert result["emitted_entries"] == 2
        assert result["dropped_entries"] == 1
        assert "READS_PAST_END" in codes(result["violations"])

    def test_reports_a_transition_with_no_predecessor_as_a_warning_not_an_error(self) -> None:
        result = compile_timeline(ONE_CAM, [entry("cam_a", 0, 10, transition="dissolve")])
        assert result["tokens"][0]["transition"] == "dissolve"
        assert [v["severity"] for v in result["violations"]] == ["warning"]


class TestValidateDeclaration:
    def test_accepts_a_sound_declaration(self) -> None:
        assert validate_declaration(TWO_CAM, [entry("cam_a", 0, 10), entry("cam_b", 0, 10)]) == []

    def test_reports_every_problem_in_one_pass(self) -> None:
        found = validate_declaration(ONE_CAM, [
            entry("cam_a", 0, 0),
            entry("ghost", 0, 10),
            entry("cam_a", 995, 100),
            entry("cam_a", 0, 10, transition="warp"),
        ])
        assert codes(found) == [
            "NON_POSITIVE_LENGTH",
            "UNKNOWN_SOURCE",
            "READS_PAST_END",
            "UNKNOWN_TRANSITION",
        ]

    def test_flags_a_start_past_the_end_separately_from_an_overrun(self) -> None:
        assert codes(validate_declaration(ONE_CAM, [entry("cam_a", 5000, 10)])) == [
            "START_PAST_END",
            "READS_PAST_END",
        ]

    def test_flags_a_negative_start(self) -> None:
        # Only the root cause is reported: the overrun check is gated on a non-negative start,
        # so a negative start is one problem, not two.
        assert codes(validate_declaration(ONE_CAM, [entry("cam_a", -1, 10)])) == ["NEGATIVE_START"]

    def test_flags_a_duplicated_token_id(self) -> None:
        found = validate_declaration(ONE_CAM, [
            entry("cam_a", 0, 10, token_id="x"),
            entry("cam_a", 20, 10, token_id="x"),
        ])
        assert codes(found) == ["DUPLICATE_TOKEN_ID"]
        assert found[0]["entry_index"] == 1

    def test_range_checks_are_skipped_for_an_unknown_source(self) -> None:
        # A range against a source with no duration is not a range violation, it is two
        # problems wearing one hat. Reporting both would bury the real cause.
        assert codes(validate_declaration(ONE_CAM, [entry("ghost", 0, 10)])) == ["UNKNOWN_SOURCE"]

    def test_a_warning_on_the_first_token_is_not_an_error(self) -> None:
        found = validate_declaration(ONE_CAM, [entry("cam_a", 0, 10, transition="wipe")])
        assert found[0]["code"] == "TRANSITION_WITHOUT_PREDECESSOR"
        assert found[0]["severity"] == "warning"


class TestTimelineOpsOverTheWire:
    def test_compile_timeline_op_returns_the_tokens(self) -> None:
        result = op_compile_timeline({"program": ONE_CAM, "edl": [entry("cam_a", 0, 25)]})
        assert result["total_out_frames"] == 25

    def test_validate_declaration_op_reports_ok_for_a_sound_edit(self) -> None:
        result = op_validate_declaration({"program": ONE_CAM, "edl": [entry("cam_a", 0, 25)]})
        assert result["ok"] is True
        assert result["violations"] == []

    def test_validate_declaration_op_is_not_ok_when_any_entry_is_broken(self) -> None:
        result = op_validate_declaration({"program": ONE_CAM, "edl": [entry("cam_a", 0, 0)]})
        assert result["ok"] is False
        assert result["errors"][0]["code"] == "NON_POSITIVE_LENGTH"

    def test_certify_certifies_a_sound_edit(self) -> None:
        verdict = op_certify({"program": TWO_CAM, "edl": [entry("cam_a", 0, 100)]})
        assert verdict["verdict"] == "certified"
        assert verdict["roundtrip"]["lossless"] is True
        assert verdict["coverage"]["all_conserved"] is True

    def test_certify_rejects_and_explains_a_broken_edit(self) -> None:
        verdict = op_certify({"program": ONE_CAM, "edl": [entry("cam_a", 995, 100)]})
        assert verdict["verdict"] == "rejected"
        assert "READS_PAST_END" in codes(verdict["errors"])

    def test_a_reused_source_range_is_surfaced_but_does_not_block(self) -> None:
        # Reusing a range is a legitimate flashback. A forge that forbade it would be wrong,
        # so it is reported and the edit still certifies.
        verdict = op_certify({"program": ONE_CAM, "edl": [
            entry("cam_a", 0, 50),
            entry("cam_a", 0, 50),
        ]})
        assert verdict["verdict"] == "certified"
        assert verdict["coverage"]["total_reused_frames"] == 50

    def test_parse_edl_rejects_a_non_object_entry(self) -> None:
        with pytest.raises(EngineError) as caught:
            parse_edl(["nope"])
        assert caught.value.code == "BAD_SHAPE"
