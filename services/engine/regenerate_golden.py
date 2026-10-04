#!/usr/bin/env python3
"""Regenerate the golden timeline.

Run deliberately and read the diff:

    python services/engine/regenerate_golden.py

A golden file that is regenerated without being read is worse than no golden file, because it
turns an anti-drift test into a tautology.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

from test_golden import GOLDEN, build  # noqa: E402


def main() -> int:
    payload = build()
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf8")
    print(f"wrote {GOLDEN.relative_to(ROOT.parent.parent)}")
    print(f"  total_out_frames = {payload['timeline']['total_out_frames']}")
    print(f"  verdict          = {payload['certification']['verdict']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
