"""The deterministic operations.

These are the parts of waveform-forge that must never be a model call. Each function is pure:
it reads its arguments, it returns a value, and it touches nothing else.

Two families live here:

* **Timeline ops** (`compile_timeline`, `verify_roundtrip`, `audit_coverage`,
  `validate_declaration`, `timeline_summary`, `certify`) — the product. Implemented in
  `compile.py` and `audit.py`.
* **Record ops** (`normalize`, `diff`, `summarize`) — generic structural utilities over stored
  records. Two timeline revisions are compared by diffing their compiled token records, so
  these are load-bearing rather than filler.
"""

from __future__ import annotations

from typing import Any, Final, TypedDict

from .audit import (
    audit_coverage,
    parse_timeline,
    timeline_summary,
    verify_roundtrip,
)
from .compile import compile_timeline, parse_edl, parse_program, validate_declaration
from .model import Certification, Timeline, Violation
from .protocol import EngineError


# --------------------------------------------------------------------- record ops


class Record(TypedDict):
    id: str
    kind: str
    payload: dict[str, Any]
    createdAt: int
    updatedAt: int


class NormalizeInput(TypedDict):
    records: list[Record]


class NormalizedRecord(TypedDict):
    id: str
    kind: str
    fields: dict[str, Any]
    updatedAt: int


class NormalizeOutput(TypedDict):
    records: list[NormalizedRecord]
    kinds: list[str]
    count: int


class DiffInput(TypedDict):
    before: list[Record]
    after: list[Record]


class Change(TypedDict):
    id: str
    kind: str
    change: str
    fields: list[str]


class DiffOutput(TypedDict):
    added: list[str]
    removed: list[str]
    changed: list[Change]
    unchanged: int


class SummaryInput(TypedDict):
    records: list[Record]


class SummaryOutput(TypedDict):
    total: int
    byKind: dict[str, int]
    oldest: int
    newest: int


def _require_records(payload: Any, field: str) -> list[Record]:
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", f"expected an object with {field!r}")
    records = payload.get(field)
    if not isinstance(records, list):
        raise EngineError("BAD_SHAPE", f"{field!r} must be a list")
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise EngineError("BAD_SHAPE", f"{field}[{index}] must be an object")
        for key in ("id", "kind", "payload", "createdAt", "updatedAt"):
            if key not in record:
                raise EngineError("MISSING_FIELD", f"{field}[{index}] is missing {key!r}")
        if not isinstance(record["payload"], dict):
            raise EngineError("BAD_SHAPE", f"{field}[{index}].payload must be an object")
    return records


def normalize(payload: NormalizeInput) -> NormalizeOutput:
    """Flatten records into a stable, sorted, comparable shape.

    Deterministic by construction: output order depends only on the input, never on dict
    iteration order, the clock, or the filesystem.
    """
    records = _require_records(payload, "records")
    normalized: list[NormalizedRecord] = []
    for record in records:
        payload_obj = record["payload"]
        normalized.append(
            {
                "id": record["id"],
                "kind": record["kind"],
                "fields": {key: payload_obj[key] for key in sorted(payload_obj)},
                "updatedAt": record["updatedAt"],
            }
        )
    normalized.sort(key=lambda item: (item["kind"], item["id"]))
    return {
        "records": normalized,
        "kinds": sorted({item["kind"] for item in normalized}),
        "count": len(normalized),
    }


def diff(payload: DiffInput) -> DiffOutput:
    """Compute a minimal structural diff between two record sets.

    Applied to compiled timelines this answers "what changed between revision 1 and revision 2
    of this edit", which is the question an editor actually asks after a collaborator reorders
    a cut.
    """
    before = {record["id"]: record for record in _require_records(payload, "before")}
    after = {record["id"]: record for record in _require_records(payload, "after")}

    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    changed: list[Change] = []
    unchanged = 0

    for identifier in sorted(set(before) & set(after)):
        left = before[identifier]
        right = after[identifier]
        if left == right:
            unchanged += 1
            continue
        touched = sorted(
            set(left["payload"]) ^ set(right["payload"])
            | {key for key in set(left["payload"]) & set(right["payload"])
               if left["payload"][key] != right["payload"][key]}
        )
        changed.append(
            {"id": identifier, "kind": right["kind"], "change": "modified", "fields": touched}
        )

    return {"added": added, "removed": removed, "changed": changed, "unchanged": unchanged}


def summarize(payload: SummaryInput) -> SummaryOutput:
    """Aggregate counts without mutating or discarding anything."""
    records = _require_records(payload, "records")
    by_kind: dict[str, int] = {}
    for record in records:
        by_kind[record["kind"]] = by_kind.get(record["kind"], 0) + 1
    stamps = [record["updatedAt"] for record in records] or [0]
    return {
        "total": len(records),
        "byKind": dict(sorted(by_kind.items())),
        "oldest": min(stamps),
        "newest": max(stamps),
    }


# ------------------------------------------------------------------- timeline ops


def _require_object(payload: Any, field: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise EngineError("BAD_SHAPE", f"expected an object with {field!r}")
    value = payload.get(field)
    if not isinstance(value, dict):
        raise EngineError("BAD_SHAPE", f"{field!r} must be an object")
    return value


def op_validate_declaration(payload: Any) -> dict[str, Any]:
    """Pre-flight an edit and report every problem, without compiling it."""
    program = parse_program(_require_object(payload, "program"))
    edl = parse_edl(payload.get("edl"))
    violations = validate_declaration(program, edl)
    return {
        "ok": not any(v["severity"] == "error" for v in violations),
        "declared_entries": len(edl),
        "violations": violations,
        "errors": [v for v in violations if v["severity"] == "error"],
        "warnings": [v for v in violations if v["severity"] == "warning"],
    }


def op_compile_timeline(payload: Any) -> Timeline:
    """Tokenize a declaration into edit tokens with exact frame arithmetic."""
    program = parse_program(_require_object(payload, "program"))
    edl = parse_edl(payload.get("edl"))
    return compile_timeline(program, edl)


def op_verify_roundtrip(payload: Any) -> dict[str, Any]:
    """Prove the timeline can be rebuilt into the declaration it came from."""
    timeline = parse_timeline(_require_object(payload, "timeline"))
    return dict(verify_roundtrip(timeline))


def op_audit_coverage(payload: Any) -> dict[str, Any]:
    """Account for every frame of every source."""
    timeline = parse_timeline(_require_object(payload, "timeline"))
    return dict(audit_coverage(timeline))


def op_timeline_summary(payload: Any) -> dict[str, Any]:
    """Token counts, exact duration and transition histogram for the UI."""
    timeline = parse_timeline(_require_object(payload, "timeline"))
    return dict(timeline_summary(timeline))


def op_certify(payload: Any) -> Certification:
    """The headline operation: compile, prove, audit, and return one verdict.

    `certified` requires all three of: no error-severity violation, a lossless round trip, and
    a conserved coverage sweep. Warnings are reported but do not block — reusing a source range
    is a legitimate creative choice, so the forge's job is to surface it, not forbid it.
    """
    program = parse_program(_require_object(payload, "program"))
    edl = parse_edl(payload.get("edl"))
    timeline = compile_timeline(program, edl)
    roundtrip = verify_roundtrip(timeline)
    coverage = audit_coverage(timeline)
    summary = timeline_summary(timeline)

    violations: list[Violation] = list(timeline["violations"])
    errors = [v for v in violations if v["severity"] == "error"]
    warnings = [v for v in violations if v["severity"] == "warning"]

    if not roundtrip["lossless"]:
        # Cap the detail: a declaration can be wrong in dozens of ways and a message that
        # concatenates all of them is unreadable in a terminal and enormous in a UI row.
        shown = roundtrip["differences"][:3]
        detail = "; ".join(d["detail"] for d in shown)
        hidden = len(roundtrip["differences"]) - len(shown)
        if hidden > 0:
            detail += f"; and {hidden} more difference{'s' if hidden != 1 else ''}"
        errors.append(
            Violation(
                code="ROUNDTRIP_LOSSY",
                severity="error",
                message=f"the timeline cannot be rebuilt into the declaration it was compiled from: {detail}",
            )
        )
    if not coverage["all_conserved"]:
        errors.append(
            Violation(
                code="COVERAGE_NOT_CONSERVED",
                severity="error",
                message="per-source frame accounting does not sum to the source duration",
            )
        )

    return Certification(
        verdict="certified" if not errors else "rejected",
        summary=summary,
        roundtrip=roundtrip,
        coverage=coverage,
        violations=violations,
        errors=errors,
        warnings=warnings,
        tokens=timeline["tokens"],
    )


OPERATIONS: Final[dict[str, Any]] = {
    # record ops
    "normalize": normalize,
    "diff": diff,
    "summarize": summarize,
    # timeline ops
    "validate_declaration": op_validate_declaration,
    "compile_timeline": op_compile_timeline,
    "verify_roundtrip": op_verify_roundtrip,
    "audit_coverage": op_audit_coverage,
    "timeline_summary": op_timeline_summary,
    "certify": op_certify,
}


def analyse(op: str, payload: Any) -> Any:
    handler = OPERATIONS.get(op)
    if handler is None:
        known = ", ".join(sorted(OPERATIONS))
        raise EngineError("UNKNOWN_OP", f"unknown op {op!r}; available: {known}")
    return handler(payload)
