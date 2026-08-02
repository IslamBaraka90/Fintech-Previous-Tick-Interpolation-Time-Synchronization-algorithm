"""Contract tests for the sampler.

The fixture is the cross-language acceptance anchor: two instruments, a revision that
lands 1.3s after the event it corrects, a gap wide enough to expire, and a request
pair that asks the *same* grid point at two different knowledge times. Its ten
expected rows are asserted verbatim by this suite and by the TypeScript one.
"""

from __future__ import annotations

import pytest
from conftest import EXPECTED, MAX_STALENESS_MS, observations, requests, sample

from fintech_previous_tick import parse_timestamp_us, previous_tick

# --- the shared fixture ------------------------------------------------------- #
def test_every_sample_matches_the_fixture():
    assert sample() == EXPECTED


def test_one_sample_per_instrument_and_request():
    assert len(sample()) == 2 * len(requests())


def test_the_fixture_exercises_every_status():
    assert {row["status"] for row in EXPECTED} == {
        "no_history",
        "not_yet_available",
        "stale",
        "carried",
    }


def test_instruments_come_out_sorted():
    instruments = [row["instrument"] for row in sample()]
    assert instruments == sorted(instruments)


def test_requests_keep_their_input_order():
    grid_times = [row["grid_time"] for row in sample() if row["instrument"] == "A"]
    assert grid_times == [request["grid_time"] for request in requests()]


def test_an_empty_grid_produces_nothing():
    assert sample(reqs=[]) == []


def test_no_observations_means_no_rows():
    assert previous_tick([], requests(), MAX_STALENESS_MS) == []


# --- the two clocks ----------------------------------------------------------- #
def test_the_same_grid_point_answers_differently_at_two_query_times():
    """The heart of the whole algorithm: knowledge time changes the answer."""

    rows = [row for row in sample() if row["instrument"] == "A"]
    early = next(r for r in rows if r["grid_time"].endswith("01.000Z") and r["query_time"].endswith("01.000Z"))
    late = next(r for r in rows if r["grid_time"].endswith("01.000Z") and r["query_time"].endswith("02.000Z"))

    assert early["grid_time"] == late["grid_time"]
    assert early["value"] == 100.0 and early["source_revision"] == 0
    assert late["value"] == 99.8 and late["source_revision"] == 1


def test_a_value_that_has_not_arrived_is_not_used():
    """Instrument B's first event happened at .700 but landed at 1.200."""

    row = next(
        r
        for r in sample()
        if r["instrument"] == "B" and r["query_time"].endswith("01.000Z")
    )
    assert row["status"] == "not_yet_available"
    assert row["value"] is None


def test_no_history_is_distinct_from_not_yet_available():
    """One means nothing has happened; the other means you could not have known."""

    first = [r for r in sample() if r["grid_time"].endswith("00.000Z")]
    assert {r["status"] for r in first} == {"no_history"}
    assert all(r["source_event_time"] is None for r in first)


def test_query_time_may_not_precede_grid_time():
    with pytest.raises(ValueError, match="query_time must not precede grid_time"):
        previous_tick(
            observations(),
            [{"grid_time": "2026-01-02T14:30:02.000Z", "query_time": "2026-01-02T14:30:01.000Z"}],
            MAX_STALENESS_MS,
        )


def test_available_time_may_not_precede_event_time():
    rows = observations(0)
    rows[0]["available_time"] = "2026-01-02T14:30:00.000Z"
    with pytest.raises(ValueError, match="available_time must not precede event_time"):
        previous_tick(rows, requests(), MAX_STALENESS_MS)


def test_duplicate_request_pairs_are_rejected():
    with pytest.raises(ValueError, match="unique"):
        previous_tick(observations(), requests(1, 1), MAX_STALENESS_MS)


def test_the_same_grid_at_a_different_query_time_is_not_a_duplicate():
    assert len(previous_tick(observations(), requests(1, 2), MAX_STALENESS_MS)) == 4


# --- staleness ---------------------------------------------------------------- #
def test_a_value_older_than_the_budget_expires():
    row = next(r for r in sample() if r["status"] == "stale")
    assert row["value"] is None
    assert row["staleness_ms"] > MAX_STALENESS_MS


def test_an_expired_sample_keeps_its_lineage():
    """A null you can explain beats a number you cannot."""

    row = next(r for r in sample() if r["status"] == "stale")
    assert row["source_event_time"] == "2026-01-02T14:30:00.100Z"
    assert row["source_revision"] == 1
    assert row["staleness_ms"] == 1900


def test_a_wider_budget_rescues_the_expired_sample():
    rows = sample(max_staleness_ms=2000)
    assert not [r for r in rows if r["status"] == "stale"]


def test_a_zero_budget_admits_only_exact_hits():
    rows = sample(max_staleness_ms=0)
    assert not [r for r in rows if r["status"] == "carried"]


def test_an_exact_hit_reports_zero_staleness():
    rows = previous_tick(
        observations(0),
        [{"grid_time": "2026-01-02T14:30:00.100Z", "query_time": "2026-01-02T14:30:00.180Z"}],
        0,
    )
    assert rows[0]["status"] == "exact"
    assert rows[0]["staleness_ms"] == 0
    assert rows[0]["value"] == 100.0


def test_staleness_is_measured_from_the_grid_not_the_query():
    """Age is a property of the value, not of when you happened to ask."""

    rows = previous_tick(
        observations(0),
        [{"grid_time": "2026-01-02T14:30:01.100Z", "query_time": "2026-01-02T14:30:09.000Z"}],
        5000,
    )
    assert rows[0]["staleness_ms"] == 1000


@pytest.mark.parametrize("bad", [-1, 1.5, "1500", True, None])
def test_an_invalid_budget_raises(bad):
    with pytest.raises(ValueError, match="max_staleness_ms"):
        previous_tick(observations(), requests(), bad)


# --- revisions ---------------------------------------------------------------- #
def test_a_revision_is_ignored_until_it_arrives():
    rows = previous_tick(
        observations(0, 1),
        [{"grid_time": "2026-01-02T14:30:01.000Z", "query_time": "2026-01-02T14:30:01.399Z"}],
        MAX_STALENESS_MS,
    )
    assert rows[0]["source_revision"] == 0


def test_a_revision_wins_from_its_own_arrival_millisecond():
    rows = previous_tick(
        observations(0, 1),
        [{"grid_time": "2026-01-02T14:30:01.000Z", "query_time": "2026-01-02T14:30:01.400Z"}],
        MAX_STALENESS_MS,
    )
    assert rows[0]["source_revision"] == 1


def test_duplicate_revisions_are_rejected():
    rows = observations(0, 0)
    with pytest.raises(ValueError, match="unique per instrument"):
        previous_tick(rows, requests(), MAX_STALENESS_MS)


def test_a_revision_arriving_before_the_original_is_rejected():
    """Otherwise 'the latest revision available' has no defined winner."""

    rows = observations(0, 1)
    rows[1]["available_time"] = "2026-01-02T14:30:00.150Z"
    with pytest.raises(ValueError, match="higher revisions must have later"):
        previous_tick(rows, requests(), MAX_STALENESS_MS)


def test_a_newer_event_beats_an_older_revision():
    """Ordering is by event first, revision only as the tie-break."""

    rows = previous_tick(
        observations(1, 2),
        [{"grid_time": "2026-01-02T14:30:03.000Z", "query_time": "2026-01-02T14:30:03.000Z"}],
        MAX_STALENESS_MS,
    )
    assert rows[0]["source_event_time"] == "2026-01-02T14:30:02.200Z"


def test_input_order_does_not_change_the_answer():
    forward = previous_tick(observations(), requests(), MAX_STALENESS_MS)
    backward = previous_tick(
        list(reversed(observations())), requests(), MAX_STALENESS_MS
    )
    assert forward == backward


# --- validation --------------------------------------------------------------- #
@pytest.mark.parametrize(
    "field,value",
    [
        ("instrument", ""),
        ("instrument", "   "),
        ("instrument", 7),
        ("revision", -1),
        ("revision", 1.5),
        ("revision", True),
        ("value", "100"),
        ("value", None),
        ("value", float("nan")),
        ("value", float("inf")),
        ("event_time", "2026-01-02T14:30:00"),
        ("event_time", "2026-01-02 14:30:00Z"),
        ("event_time", "not-a-time"),
    ],
)
def test_an_unusable_field_raises(field, value):
    rows = observations(0)
    rows[0][field] = value
    with pytest.raises(ValueError):
        previous_tick(rows, requests(0), MAX_STALENESS_MS)


def test_a_non_mapping_observation_raises():
    with pytest.raises(ValueError, match="mapping"):
        previous_tick(["not-a-row"], requests(0), MAX_STALENESS_MS)


def test_input_rows_are_never_mutated():
    rows = observations()
    before = [dict(row) for row in rows]
    previous_tick(rows, requests(), MAX_STALENESS_MS)
    assert rows == before


# --- timestamps are strict ----------------------------------------------------- #
def test_an_impossible_calendar_date_is_rejected():
    """JavaScript's Date.parse rolls this to March 2. Both ports here refuse it."""

    with pytest.raises(ValueError, match="not a real calendar time"):
        parse_timestamp_us("2026-02-30T00:00:00.000Z")


@pytest.mark.parametrize(
    "timestamp",
    [
        "2026-01-02T14:30:00+00:00",   # offset form, not Z
        "2026-01-02T14:30:00",         # no zone at all
        "2026-01-02T14:30:00.1234567Z",  # beyond microseconds
        "2026-13-02T14:30:00Z",        # month 13
        "2026-01-02T25:30:00Z",        # hour 25
        "",
        None,
        1767363000000,
    ],
)
def test_a_malformed_timestamp_is_rejected(timestamp):
    with pytest.raises(ValueError):
        parse_timestamp_us(timestamp)


@pytest.mark.parametrize(
    "timestamp,expected_us",
    [
        ("1970-01-01T00:00:00Z", 0),
        ("1970-01-01T00:00:00.001Z", 1_000),
        ("1970-01-01T00:00:00.000001Z", 1),
        ("2026-01-02T14:30:00.100Z", 1_767_364_200_100_000),
    ],
)
def test_a_valid_timestamp_parses_to_exact_microseconds(timestamp, expected_us):
    assert parse_timestamp_us(timestamp) == expected_us


def test_sub_millisecond_precision_survives():
    rows = previous_tick(
        [
            {
                "instrument": "A",
                "event_time": "2026-01-02T14:30:00.000500Z",
                "available_time": "2026-01-02T14:30:00.000500Z",
                "revision": 0,
                "value": 1.0,
            }
        ],
        [{"grid_time": "2026-01-02T14:30:00.001500Z", "query_time": "2026-01-02T14:30:01.000Z"}],
        1,
    )
    assert rows[0]["staleness_ms"] == 1.0
