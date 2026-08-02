"""Shared fixture access. The same JSON backs the TypeScript suite."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "fixtures.json").read_text(encoding="utf-8")
)
MAX_STALENESS_MS = FIXTURE["max_staleness_ms"]
OBSERVATIONS = FIXTURE["observations"]
REQUESTS = FIXTURE["requests"]
EXPECTED = FIXTURE["expected"]


def observations(*indexes: int) -> list[dict]:
    """Deep-copied fixture observations — all, or the given 0-based positions."""

    if not indexes:
        return copy.deepcopy(OBSERVATIONS)
    return [copy.deepcopy(OBSERVATIONS[i]) for i in indexes]


def requests(*indexes: int) -> list[dict]:
    """Deep-copied fixture requests — all, or the given 0-based positions."""

    if not indexes:
        return copy.deepcopy(REQUESTS)
    return [copy.deepcopy(REQUESTS[i]) for i in indexes]


def sample(rows=None, reqs=None, max_staleness_ms=None):
    from fintech_previous_tick import previous_tick

    return previous_tick(
        observations() if rows is None else rows,
        requests() if reqs is None else reqs,
        MAX_STALENESS_MS if max_staleness_ms is None else max_staleness_ms,
    )
