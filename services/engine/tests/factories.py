"""Shared builders for the engine tests.

Kept in one place so a test never hand-rolls a program shape differently from another, which
is how a suite starts asserting its own typos instead of the engine's behaviour.
"""

from __future__ import annotations

from typing import Any

Source = dict[str, Any]
Program = dict[str, Any]
Entry = dict[str, Any]


def source(identifier: str, duration_frames: int, label: str | None = None) -> Source:
    built: Source = {"id": identifier, "duration_frames": duration_frames}
    if label is not None:
        built["label"] = label
    return built


def program(
    sources: list[Source],
    rate: tuple[int, int] = (30, 1),
) -> Program:
    return {"frame_rate": {"num": rate[0], "den": rate[1]}, "sources": sources}


def entry(
    source_id: str,
    src_start_frame: int,
    frame_count: int,
    transition: str | None = None,
    token_id: str | None = None,
) -> Entry:
    built: Entry = {
        "source_id": source_id,
        "src_start_frame": src_start_frame,
        "frame_count": frame_count,
    }
    if transition is not None:
        built["transition"] = transition
    if token_id is not None:
        built["token_id"] = token_id
    return built


def codes(violations: list[dict[str, Any]]) -> list[str]:
    return [v["code"] for v in violations]
