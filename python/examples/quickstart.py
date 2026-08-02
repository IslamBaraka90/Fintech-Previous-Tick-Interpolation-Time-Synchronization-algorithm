"""Sample a two-instrument feed onto a grid, then measure what honesty cost you.

Run:  python examples/quickstart.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from fintech_previous_tick import (  # noqa: E402
    StreamingPreviousTick,
    build_grid,
    previous_tick,
    revision_lookahead,
    staleness_budget_sweep,
    staleness_profile,
)

OBSERVATIONS = [
    # Revision 0 of the 14:30:00.100 print, on the wire 80ms later.
    {"instrument": "A", "event_time": "2026-01-02T14:30:00.100Z",
     "available_time": "2026-01-02T14:30:00.180Z", "revision": 0, "value": 100.0},
    # The venue corrects it 1.3 SECONDS later. Anyone sampling before then
    # legitimately saw 100.0, and no honest backtest may pretend otherwise.
    {"instrument": "A", "event_time": "2026-01-02T14:30:00.100Z",
     "available_time": "2026-01-02T14:30:01.400Z", "revision": 1, "value": 99.8},
    {"instrument": "A", "event_time": "2026-01-02T14:30:02.200Z",
     "available_time": "2026-01-02T14:30:02.260Z", "revision": 0, "value": 100.4},
    {"instrument": "B", "event_time": "2026-01-02T14:30:00.700Z",
     "available_time": "2026-01-02T14:30:01.200Z", "revision": 0, "value": 50.0},
    {"instrument": "B", "event_time": "2026-01-02T14:30:01.900Z",
     "available_time": "2026-01-02T14:30:01.950Z", "revision": 0, "value": 50.2},
]

MAX_STALENESS_MS = 1500


def rule(title: str) -> None:
    print(f"\n{title}\n{'-' * len(title)}")


# --- 1. the same grid point, asked twice ----------------------------------- #
rule("1. Knowledge time changes the answer")

for query in ("2026-01-02T14:30:01.000Z", "2026-01-02T14:30:02.000Z"):
    row = previous_tick(
        OBSERVATIONS,
        [{"grid_time": "2026-01-02T14:30:01.000Z", "query_time": query}],
        MAX_STALENESS_MS,
    )[0]
    print(f"  grid 14:30:01 asked at {query[-13:-1]}  ->  "
          f"value={row['value']}  revision={row['source_revision']}")
print("  Same grid point, two answers. That is the point-in-time contract, not a bug.")

# --- 2. a full grid -------------------------------------------------------- #
rule("2. A one-second grid with a 100ms query lag")

grid = build_grid(
    "2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", step_ms=1000, lag_ms=100
)
samples = previous_tick(OBSERVATIONS, grid, MAX_STALENESS_MS)
for row in samples:
    age = "" if row["staleness_ms"] is None else f"  age={row['staleness_ms']:.0f}ms"
    print(f"  {row['instrument']}  {row['grid_time'][-13:-1]}  "
          f"{str(row['value']):>6}  {row['status']}{age}")

# --- 3. how healthy is that series? ---------------------------------------- #
rule("3. Coverage, honestly counted")

profile = staleness_profile(samples)
for instrument, stats in profile["instruments"].items():
    print(f"  {instrument}: {stats['usable']}/{stats['total']} usable "
          f"({stats['usable_share']:.0%}), worst carry "
          f"{stats['max_staleness_ms']}ms")

# --- 4. the number that belongs in a research note ------------------------- #
rule("4. Lookahead a revised-file backtest would have absorbed")

lookahead = revision_lookahead(OBSERVATIONS, grid, MAX_STALENESS_MS)
summary = lookahead["summary"]
print(f"  {summary['differing']}/{summary['total_samples']} samples would differ "
      f"({summary['differing_share']:.0%}), worst gap "
      f"{summary['max_abs_difference']:.4f}")
for row in lookahead["rows"]:
    print(f"    {row['instrument']} {row['grid_time'][-13:-1]}  "
          f"honest={row['point_in_time_value']}  "
          f"revised={row['revised_value']}  [{row['kind']}]")

# --- 5. pick the budget off a curve, not out of the air -------------------- #
rule("5. Staleness budget sweep")

for point in staleness_budget_sweep(OBSERVATIONS, grid, [0, 500, 1000, 2000, 5000]):
    gained = "" if point["gained_vs_previous"] is None else f"  (+{point['gained_vs_previous']})"
    print(f"  {point['max_staleness_ms']:>5}ms  ->  "
          f"{point['usable']}/{point['total']} usable{gained}")

# --- 6. the same thing, live ----------------------------------------------- #
rule("6. The streaming engine agrees with the batch function")

engine = StreamingPreviousTick(MAX_STALENESS_MS)
engine.observe_many(sorted(OBSERVATIONS, key=lambda row: row["available_time"]))
live = [row for request in grid
        for row in engine.sample(request["grid_time"], request["query_time"])]
key = lambda rows: sorted(rows, key=lambda r: (r["instrument"], r["grid_time"]))  # noqa: E731
print(f"  identical to the batch result: {key(live) == key(samples)}")

state = engine.checkpoint()
resumed = StreamingPreviousTick.restore(json.loads(json.dumps(state)))
print(f"  survives a checkpoint round-trip:  "
      f"{resumed.sample(grid[-1]['grid_time'], grid[-1]['query_time']) == engine.sample(grid[-1]['grid_time'], grid[-1]['query_time'])}")
