"""Choosing the staleness budget, and measuring what the two clocks bought you.

The batch sampler answers *what was the value*. This module answers the three
questions you actually have to settle before trusting a sampled series.

**How much lookahead was I about to buy?** — :func:`revision_lookahead`
This is the headline. It samples the same grid twice: once honestly, and once the
way a naive pipeline does it by reading a revised historical file and ignoring
``available_time`` entirely. The rows that differ are precisely the rows where a
backtest would have used a number nobody had yet. The result is a count and a
magnitude rather than an argument — you can put it in a research note.

**What budget should ``max_staleness_ms`` be?** — :func:`staleness_budget_sweep`
The budget is usually picked by feel, which means it is picked to make the output
look good. The sweep re-samples across candidate budgets and reports how the
usable/stale split moves, so the number comes off a curve instead of out of the air.
A budget sitting on a cliff edge is a budget that will behave differently next week.

**How healthy is the series I just produced?** — :func:`staleness_profile`
Per-instrument status counts, the share of grid points that were actually usable,
and the worst carry. An instrument that is 90% ``carried`` at 40 seconds of age is
not really being sampled; it is being invented, and the profile says so.

:func:`build_grid` is the small practical helper that generates the request list,
including the ``lag_ms`` that models how late your system asks the question.
"""

from __future__ import annotations

from statistics import median
from typing import Any, Iterable, Mapping

from .core import (
    GridRequest,
    Sample,
    _lookup,
    _parse_observations,
    _parse_requests,
    _require_non_negative_int,
    parse_timestamp_us,
    previous_tick,
)

__all__ = [
    "build_grid",
    "staleness_profile",
    "revision_lookahead",
    "staleness_budget_sweep",
]

#: Stands in for "every revision has arrived", i.e. the revised-file view.
_ALL_AVAILABLE_US = 2**62

_USABLE = ("exact", "carried")


def _format_us(microseconds: int) -> str:
    """Render integer microseconds back to the RFC 3339 form this package accepts."""

    from datetime import timedelta

    from .core import EPOCH

    moment = EPOCH + timedelta(microseconds=microseconds)
    if moment.microsecond % 1000 == 0:
        return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond:06d}Z"


def build_grid(
    start: str, end: str, step_ms: int, lag_ms: int = 0
) -> list[GridRequest]:
    """Generate evenly spaced grid requests from ``start`` to ``end`` inclusive.

    ``lag_ms`` is the honest part. Your system does not ask about 09:30:00 at
    exactly 09:30:00 — it asks a moment later, once the bar has closed and the
    message has landed. Setting a lag models that, and setting it to zero asserts
    the stronger claim that you query with no delay at all.

    Args:
        start: First grid point, RFC 3339 UTC.
        end: Last grid point, inclusive if it falls on a step.
        step_ms: Spacing between grid points, strictly positive.
        lag_ms: Added to each grid point to form its ``query_time``.
    """

    start_us = parse_timestamp_us(start, "start")
    end_us = parse_timestamp_us(end, "end")
    _require_non_negative_int(step_ms, "step_ms")
    _require_non_negative_int(lag_ms, "lag_ms")
    if step_ms == 0:
        raise ValueError("step_ms must be positive")
    if end_us < start_us:
        raise ValueError("end must not precede start")

    step_us = step_ms * 1000
    lag_us = lag_ms * 1000
    return [
        {
            "grid_time": _format_us(moment),
            "query_time": _format_us(moment + lag_us),
        }
        for moment in range(start_us, end_us + 1, step_us)
    ]


def staleness_profile(samples: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Summarise a sampled series per instrument, plus an ``overall`` roll-up.

    ``usable_share`` counts only ``exact`` and ``carried`` samples. A ``stale`` or
    missing sample is not a value you may use, and folding it into a coverage number
    would report the opposite of what happened.
    """

    rows = list(samples)
    for index, row in enumerate(rows):
        if not isinstance(row, Mapping) or "status" not in row or "instrument" not in row:
            raise ValueError(f"samples[{index}] must come from previous_tick()")

    by_instrument: dict[str, list[Mapping[str, Any]]] = {}
    for row in rows:
        by_instrument.setdefault(str(row["instrument"]), []).append(row)

    per_instrument = {
        instrument: _profile_one(group)
        for instrument, group in sorted(by_instrument.items())
    }
    return {
        "instruments": per_instrument,
        "overall": _profile_one(rows) if rows else _profile_one([]),
    }


def _profile_one(rows: list[Mapping[str, Any]]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    for row in rows:
        status = str(row["status"])
        counts[status] = counts.get(status, 0) + 1

    ages = [
        float(row["staleness_ms"])
        for row in rows
        if row.get("staleness_ms") is not None and row["status"] in _USABLE
    ]
    usable = sum(counts.get(status, 0) for status in _USABLE)

    return {
        "total": len(rows),
        "counts": dict(sorted(counts.items())),
        "usable": usable,
        "usable_share": (usable / len(rows)) if rows else 0.0,
        "max_staleness_ms": max(ages) if ages else None,
        "median_staleness_ms": median(ages) if ages else None,
    }


def revision_lookahead(
    observations: Iterable[Mapping[str, Any]],
    requests: Iterable[Mapping[str, Any]],
    max_staleness_ms: int,
) -> dict[str, Any]:
    """Measure the lookahead a revised-file backtest would have absorbed.

    Two samplings of the same grid:

    * **point-in-time** — the honest one, respecting ``available_time``.
    * **revised** — what you get from a corrected historical file, where every
      revision looks like it was always there.

    Every row where the two disagree is a row a naive backtest would have gotten
    from information that did not exist yet. ``max_abs_difference`` is the largest
    such gap in value terms.

    Returns:
        A mapping with ``summary`` and the differing ``rows``. An empty ``rows``
        means the revised file and the live feed would have agreed everywhere —
        worth knowing, and not something to assume.
    """

    _require_non_negative_int(max_staleness_ms, "max_staleness_ms")
    max_staleness_us = max_staleness_ms * 1000

    honest = previous_tick(observations, requests, max_staleness_ms)
    parsed_requests = _parse_requests(requests)
    by_instrument = _parse_observations(observations)

    revised_by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    for instrument in sorted(by_instrument):
        rows = by_instrument[instrument]
        for grid_time, query_time, grid_us, _query_us in parsed_requests:
            chosen, saw = _lookup(rows, grid_us, _ALL_AVAILABLE_US)
            if chosen is None:
                revised_by_key[(instrument, grid_time, query_time)] = {
                    "value": None,
                    "revision": None,
                    "status": "not_yet_available" if saw else "no_history",
                }
                continue
            staleness_us = grid_us - chosen.event_us
            stale = staleness_us > max_staleness_us
            revised_by_key[(instrument, grid_time, query_time)] = {
                "value": None if stale else chosen.value,
                "revision": chosen.revision,
                "status": "stale"
                if stale
                else ("exact" if staleness_us == 0 else "carried"),
            }

    differing: list[dict[str, Any]] = []
    max_gap = 0.0
    for sample in honest:
        key = (sample["instrument"], sample["grid_time"], sample["query_time"])
        revised = revised_by_key[key]
        same_value = sample["value"] == revised["value"]
        same_revision = sample["source_revision"] == revised["revision"]
        if same_value and same_revision:
            continue

        difference = (
            revised["value"] - sample["value"]
            if sample["value"] is not None and revised["value"] is not None
            else None
        )
        if difference is not None:
            max_gap = max(max_gap, abs(difference))

        differing.append(
            {
                "instrument": sample["instrument"],
                "grid_time": sample["grid_time"],
                "query_time": sample["query_time"],
                "point_in_time_value": sample["value"],
                "point_in_time_revision": sample["source_revision"],
                "point_in_time_status": sample["status"],
                "revised_value": revised["value"],
                "revised_revision": revised["revision"],
                "revised_status": revised["status"],
                "difference": difference,
                "kind": _lookahead_kind(sample, revised),
            }
        )

    total = len(honest)
    return {
        "summary": {
            "total_samples": total,
            "differing": len(differing),
            "differing_share": (len(differing) / total) if total else 0.0,
            "max_abs_difference": max_gap if differing else None,
        },
        "rows": differing,
    }


def _lookahead_kind(sample: Mapping[str, Any], revised: Mapping[str, Any]) -> str:
    """Name *why* the two views parted, which decides how much it should worry you."""

    if sample["value"] is None and revised["value"] is not None:
        # The honest view had nothing; the revised file supplied a number. This is
        # the dangerous shape — the backtest gains a data point out of nowhere.
        return "invented_value"
    if sample["source_revision"] != revised["revision"]:
        return "revision_differs"
    return "value_differs"


def staleness_budget_sweep(
    observations: Iterable[Mapping[str, Any]],
    requests: Iterable[Mapping[str, Any]],
    candidates: Iterable[int],
) -> list[dict[str, Any]]:
    """Re-sample across candidate ``max_staleness_ms`` values and report the split.

    Read the resulting curve for a flat stretch and pick from the middle of it. A
    budget chosen on a steep segment is one where a small change in feed latency
    moves a lot of samples between usable and unusable, which is how a series that
    backtested cleanly starts behaving differently in production.
    """

    candidate_list = list(candidates)
    if not candidate_list:
        raise ValueError("candidates must not be empty")

    observation_list = list(observations)
    request_list = list(requests)

    sweep: list[dict[str, Any]] = []
    previous_usable: int | None = None
    for candidate in candidate_list:
        _require_non_negative_int(candidate, "candidate")
        samples = previous_tick(observation_list, request_list, candidate)
        profile = staleness_profile(samples)["overall"]
        usable = profile["usable"]
        sweep.append(
            {
                "max_staleness_ms": candidate,
                "total": profile["total"],
                "usable": usable,
                "usable_share": profile["usable_share"],
                "stale": profile["counts"].get("stale", 0),
                # How many samples this candidate rescued relative to the previous
                # one. A large jump marks a cliff you should not be standing on.
                "gained_vs_previous": None
                if previous_usable is None
                else usable - previous_usable,
            }
        )
        previous_usable = usable
    return sweep
