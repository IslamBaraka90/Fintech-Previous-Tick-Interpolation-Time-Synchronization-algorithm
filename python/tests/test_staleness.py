"""Tests for the grid builder, the health profile, the lookahead measure and the sweep."""

from __future__ import annotations

import pytest
from conftest import MAX_STALENESS_MS, observations, requests, sample

from fintech_previous_tick import (
    build_grid,
    previous_tick,
    revision_lookahead,
    staleness_budget_sweep,
    staleness_profile,
)

# --- build_grid ---------------------------------------------------------------- #
def test_a_grid_spans_its_endpoints_inclusively():
    grid = build_grid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 1000)
    assert len(grid) == 4
    assert grid[0]["grid_time"] == "2026-01-02T14:30:00.000Z"
    assert grid[-1]["grid_time"] == "2026-01-02T14:30:03.000Z"


def test_a_grid_without_lag_queries_at_the_grid_point():
    for row in build_grid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:02.000Z", 1000):
        assert row["grid_time"] == row["query_time"]


def test_a_lag_pushes_the_query_later():
    row = build_grid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:00.000Z", 1000, 250)[0]
    assert row["grid_time"] == "2026-01-02T14:30:00.000Z"
    assert row["query_time"] == "2026-01-02T14:30:00.250Z"


def test_an_end_off_the_step_stops_before_it():
    grid = build_grid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:02.500Z", 1000)
    assert grid[-1]["grid_time"] == "2026-01-02T14:30:02.000Z"


def test_a_single_point_grid_is_allowed():
    assert len(build_grid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:00.000Z", 1000)) == 1


def test_a_generated_grid_feeds_straight_into_the_sampler():
    grid = build_grid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 1000, 100)
    rows = previous_tick(observations(), grid, MAX_STALENESS_MS)
    assert len(rows) == 2 * len(grid)


def test_sub_millisecond_grid_points_render_correctly():
    grid = build_grid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:00.002Z", 1)
    assert [row["grid_time"] for row in grid] == [
        "2026-01-02T14:30:00.000Z",
        "2026-01-02T14:30:00.001Z",
        "2026-01-02T14:30:00.002Z",
    ]


@pytest.mark.parametrize(
    "args",
    [
        ("2026-01-02T14:30:03.000Z", "2026-01-02T14:30:00.000Z", 1000),  # end < start
        ("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 0),     # zero step
        ("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", -1),    # negative step
        ("not-a-time", "2026-01-02T14:30:03.000Z", 1000),
    ],
)
def test_a_bad_grid_request_raises(args):
    with pytest.raises(ValueError):
        build_grid(*args)


def test_a_negative_lag_raises():
    with pytest.raises(ValueError, match="lag_ms"):
        build_grid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 1000, -1)


# --- staleness_profile ---------------------------------------------------------- #
def test_the_profile_covers_every_instrument():
    profile = staleness_profile(sample())
    assert sorted(profile["instruments"]) == ["A", "B"]


def test_the_profile_totals_agree_with_the_samples():
    rows = sample()
    profile = staleness_profile(rows)
    assert profile["overall"]["total"] == len(rows)
    assert sum(p["total"] for p in profile["instruments"].values()) == len(rows)


def test_usable_excludes_stale_and_missing():
    """A stale sample is not a value you may use, and must not flatter coverage."""

    profile = staleness_profile(sample())["overall"]
    # 10 grid points: 6 carried, 1 stale, 2 no_history, 1 not_yet_available.
    assert profile["usable"] == 6
    assert profile["counts"]["stale"] == 1
    assert profile["counts"]["no_history"] == 2
    assert profile["counts"]["not_yet_available"] == 1


def test_the_usable_share_is_over_all_grid_points():
    profile = staleness_profile(sample())["overall"]
    assert profile["usable_share"] == pytest.approx(6 / 10)


def test_the_worst_carry_is_reported():
    profile = staleness_profile(sample())["instruments"]["B"]
    assert profile["max_staleness_ms"] == 1100


def test_ages_come_from_usable_samples_only():
    """The expired 1900ms carry must not appear in the age statistics."""

    profile = staleness_profile(sample())["instruments"]["A"]
    assert profile["max_staleness_ms"] == 900


def test_an_empty_series_profiles_to_zero():
    profile = staleness_profile([])
    assert profile["overall"]["total"] == 0
    assert profile["overall"]["usable_share"] == 0.0
    assert profile["overall"]["max_staleness_ms"] is None


def test_the_profile_rejects_foreign_rows():
    with pytest.raises(ValueError, match="previous_tick"):
        staleness_profile([{"nope": 1}])


# --- revision_lookahead ---------------------------------------------------------- #
def test_the_lookahead_finds_the_revision_a_naive_backtest_would_steal():
    result = revision_lookahead(observations(), requests(), MAX_STALENESS_MS)
    assert result["summary"]["differing"] > 0
    kinds = {row["kind"] for row in result["rows"]}
    assert "revision_differs" in kinds or "invented_value" in kinds


def test_the_lookahead_names_the_exact_row():
    """Grid 14:30:01 asked at 14:30:01 truthfully returns rev 0; the revised file
    would have handed over rev 1, which had not arrived yet."""

    result = revision_lookahead(observations(), requests(), MAX_STALENESS_MS)
    row = next(
        r
        for r in result["rows"]
        if r["instrument"] == "A"
        and r["grid_time"] == "2026-01-02T14:30:01.000Z"
        and r["query_time"] == "2026-01-02T14:30:01.000Z"
    )
    assert row["point_in_time_value"] == 100.0
    assert row["point_in_time_revision"] == 0
    assert row["revised_value"] == 99.8
    assert row["revised_revision"] == 1
    assert row["difference"] == pytest.approx(-0.2)


def test_a_value_conjured_from_nothing_is_called_out():
    """Instrument B at 14:30:01 truthfully has nothing; the revised view has 50.0."""

    result = revision_lookahead(observations(), requests(), MAX_STALENESS_MS)
    row = next(
        r
        for r in result["rows"]
        if r["instrument"] == "B" and r["point_in_time_status"] == "not_yet_available"
    )
    assert row["kind"] == "invented_value"
    assert row["revised_value"] == 50.0
    assert row["difference"] is None


def test_the_magnitude_is_reported():
    result = revision_lookahead(observations(), requests(), MAX_STALENESS_MS)
    assert result["summary"]["max_abs_difference"] == pytest.approx(0.2)


def test_the_share_is_over_every_sample():
    result = revision_lookahead(observations(), requests(), MAX_STALENESS_MS)
    total = result["summary"]["total_samples"]
    assert total == len(sample())
    assert result["summary"]["differing_share"] == pytest.approx(
        result["summary"]["differing"] / total
    )


def test_a_feed_with_no_revisions_and_no_delay_has_no_lookahead():
    clean = [
        {
            "instrument": "A",
            "event_time": "2026-01-02T14:30:00.000Z",
            "available_time": "2026-01-02T14:30:00.000Z",
            "revision": 0,
            "value": 10.0,
        }
    ]
    result = revision_lookahead(
        clean,
        [{"grid_time": "2026-01-02T14:30:01.000Z", "query_time": "2026-01-02T14:30:01.000Z"}],
        5000,
    )
    assert result["rows"] == []
    assert result["summary"]["differing"] == 0
    assert result["summary"]["max_abs_difference"] is None


def test_the_honest_view_never_beats_the_revised_one_on_coverage():
    """Point-in-time can only ever know less than the revised file, never more."""

    honest = staleness_profile(sample())["overall"]["usable"]
    revised = revision_lookahead(observations(), requests(), MAX_STALENESS_MS)
    invented = [r for r in revised["rows"] if r["kind"] == "invented_value"]
    assert honest + len(invented) <= len(sample())


# --- staleness_budget_sweep ------------------------------------------------------ #
def test_the_sweep_returns_one_point_per_candidate():
    sweep = staleness_budget_sweep(observations(), requests(), [0, 500, 1500, 5000])
    assert [point["max_staleness_ms"] for point in sweep] == [0, 500, 1500, 5000]


def test_a_wider_budget_never_makes_fewer_samples_usable():
    sweep = staleness_budget_sweep(observations(), requests(), [0, 250, 500, 1000, 2000, 10_000])
    usable = [point["usable"] for point in sweep]
    assert usable == sorted(usable)


def test_the_sweep_marks_the_cliff():
    sweep = staleness_budget_sweep(observations(), requests(), [0, 2000])
    assert sweep[0]["gained_vs_previous"] is None
    assert sweep[1]["gained_vs_previous"] == sweep[1]["usable"] - sweep[0]["usable"]


def test_a_budget_wide_enough_leaves_nothing_stale():
    sweep = staleness_budget_sweep(observations(), requests(), [1_000_000])
    assert sweep[0]["stale"] == 0


def test_the_sweep_agrees_with_a_direct_sample():
    sweep = staleness_budget_sweep(observations(), requests(), [MAX_STALENESS_MS])
    direct = staleness_profile(sample())["overall"]
    assert sweep[0]["usable"] == direct["usable"]
    assert sweep[0]["total"] == direct["total"]


def test_an_empty_candidate_list_raises():
    with pytest.raises(ValueError, match="candidates must not be empty"):
        staleness_budget_sweep(observations(), requests(), [])


@pytest.mark.parametrize("bad", [-1, 1.5, "500"])
def test_a_bad_candidate_raises(bad):
    with pytest.raises(ValueError):
        staleness_budget_sweep(observations(), requests(), [bad])
