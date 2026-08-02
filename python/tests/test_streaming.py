"""Tests for the live engine.

The load-bearing assertion is :func:`test_streaming_equals_batch`: with retention
unbounded, feeding observations one at a time must reproduce the batch answer
exactly. If that ever drifts, the live path and the backtest path have quietly
become two different algorithms — which is the failure this repo exists to prevent.
"""

from __future__ import annotations

import pytest
from conftest import MAX_STALENESS_MS, REQUESTS, observations, requests, sample

from fintech_previous_tick import StreamingPreviousTick

ARRIVAL_ORDER = sorted(observations(), key=lambda row: row["available_time"])


def fed(max_staleness_ms=MAX_STALENESS_MS, retention_ms=None, rows=None):
    engine = StreamingPreviousTick(max_staleness_ms, retention_ms)
    engine.observe_many(ARRIVAL_ORDER if rows is None else rows)
    return engine


# --- equivalence with the batch function -------------------------------------- #
def test_streaming_equals_batch():
    engine = fed()
    streamed = [
        row
        for request in requests()
        for row in engine.sample(request["grid_time"], request["query_time"])
    ]
    batch = sample()
    assert sorted(streamed, key=lambda r: (r["instrument"], r["grid_time"], r["query_time"])) == \
           sorted(batch, key=lambda r: (r["instrument"], r["grid_time"], r["query_time"]))


def test_a_fresh_engine_reports_nothing():
    engine = StreamingPreviousTick(MAX_STALENESS_MS)
    assert engine.instruments == []
    assert engine.sample(REQUESTS[0]["grid_time"], REQUESTS[0]["query_time"]) == []


def test_the_engine_tracks_its_instruments():
    assert fed().instruments == ["A", "B"]


# --- arrival order is enforced ------------------------------------------------- #
def test_out_of_order_arrival_is_rejected():
    engine = StreamingPreviousTick(MAX_STALENESS_MS)
    engine.observe(ARRIVAL_ORDER[-1])
    with pytest.raises(ValueError, match="non-decreasing available_time"):
        engine.observe(ARRIVAL_ORDER[0])


def test_simultaneous_arrivals_are_allowed():
    """Two feeds can land in the same millisecond; that is not a fault."""

    engine = StreamingPreviousTick(MAX_STALENESS_MS)
    for instrument in ("A", "B"):
        engine.observe(
            {
                "instrument": instrument,
                "event_time": "2026-01-02T14:30:00.000Z",
                "available_time": "2026-01-02T14:30:00.000Z",
                "revision": 0,
                "value": 1.0,
            }
        )
    assert engine.instruments == ["A", "B"]


def test_a_duplicate_revision_is_rejected_live():
    engine = fed()
    with pytest.raises(ValueError, match="unique per instrument"):
        engine.observe(observations(2)[0])


def test_a_revision_that_arrives_too_early_is_rejected_live():
    engine = StreamingPreviousTick(MAX_STALENESS_MS)
    engine.observe(observations(0)[0])
    bad = observations(1)[0]
    # Landing in the SAME millisecond as revision 0 — late enough to pass the
    # arrival-order check, so it is the revision rule that has to catch it.
    bad["available_time"] = "2026-01-02T14:30:00.180Z"
    with pytest.raises(ValueError, match="higher revisions must have later"):
        engine.observe(bad)


# --- retention ----------------------------------------------------------------- #
def test_unbounded_retention_drops_nothing():
    engine = fed()
    assert engine.dropped == 0
    assert engine.retained == len(ARRIVAL_ORDER)


def test_retention_bounds_memory():
    engine = fed(retention_ms=500)
    assert engine.retained < len(ARRIVAL_ORDER)
    assert engine.dropped > 0


def test_retention_can_turn_a_carry_into_no_history():
    """The honest cost of bounded memory, asserted rather than hidden."""

    kept = fed().sample_instrument(
        "B", "2026-01-02T14:30:03.000Z", "2026-01-02T14:30:03.000Z"
    )
    pruned = fed(retention_ms=0).sample_instrument(
        "A", "2026-01-02T14:30:00.000Z", "2026-01-02T14:30:00.000Z"
    )
    assert kept["status"] == "carried"
    assert pruned["status"] == "no_history"


def test_a_negative_retention_raises():
    with pytest.raises(ValueError, match="retention_ms"):
        StreamingPreviousTick(MAX_STALENESS_MS, -1)


def test_a_negative_budget_raises():
    with pytest.raises(ValueError, match="max_staleness_ms"):
        StreamingPreviousTick(-1)


# --- querying ------------------------------------------------------------------ #
def test_a_query_before_its_grid_point_raises():
    with pytest.raises(ValueError, match="query_time must not precede grid_time"):
        fed().sample_instrument(
            "A", "2026-01-02T14:30:02.000Z", "2026-01-02T14:30:01.000Z"
        )


def test_an_unknown_instrument_reports_no_history():
    row = fed().sample_instrument(
        "ZZZ", "2026-01-02T14:30:03.000Z", "2026-01-02T14:30:03.000Z"
    )
    assert row["status"] == "no_history"
    assert row["value"] is None


def test_sampling_does_not_consume_state():
    engine = fed()
    first = engine.sample("2026-01-02T14:30:03.000Z", "2026-01-02T14:30:03.000Z")
    second = engine.sample("2026-01-02T14:30:03.000Z", "2026-01-02T14:30:03.000Z")
    assert first == second


def test_a_later_observation_changes_a_later_answer():
    engine = StreamingPreviousTick(MAX_STALENESS_MS)
    engine.observe(observations(0)[0])
    before = engine.sample_instrument(
        "A", "2026-01-02T14:30:01.000Z", "2026-01-02T14:30:02.000Z"
    )
    engine.observe(observations(1)[0])
    after = engine.sample_instrument(
        "A", "2026-01-02T14:30:01.000Z", "2026-01-02T14:30:02.000Z"
    )
    assert before["source_revision"] == 0
    assert after["source_revision"] == 1


# --- checkpoint / restore ------------------------------------------------------ #
def test_a_checkpoint_round_trips():
    engine = fed()
    restored = StreamingPreviousTick.restore(engine.checkpoint())
    grid, query = "2026-01-02T14:30:03.000Z", "2026-01-02T14:30:03.000Z"
    assert restored.sample(grid, query) == engine.sample(grid, query)


def test_a_checkpoint_is_json_safe():
    import json

    state = fed().checkpoint()
    assert json.loads(json.dumps(state)) == state


def test_a_restored_engine_keeps_taking_observations():
    engine = StreamingPreviousTick(MAX_STALENESS_MS)
    engine.observe_many(ARRIVAL_ORDER[:2])
    restored = StreamingPreviousTick.restore(engine.checkpoint())
    for row in ARRIVAL_ORDER[2:]:
        restored.observe(row)
    assert restored.retained == len(ARRIVAL_ORDER)


def test_a_restored_engine_keeps_its_settings():
    engine = fed(max_staleness_ms=42, retention_ms=99)
    restored = StreamingPreviousTick.restore(engine.checkpoint())
    state = restored.checkpoint()
    assert state["max_staleness_ms"] == 42
    assert state["retention_ms"] == 99


@pytest.mark.parametrize("state", [{}, {"max_staleness_ms": 1}, "nope", 7])
def test_a_malformed_checkpoint_raises(state):
    with pytest.raises(ValueError):
        StreamingPreviousTick.restore(state)
