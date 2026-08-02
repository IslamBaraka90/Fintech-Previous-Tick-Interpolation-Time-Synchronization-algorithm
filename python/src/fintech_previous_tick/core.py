"""Point-in-time-safe previous-tick sampling.

The rule this module enforces is one sentence long: **a sample may only use a value
that had already arrived at the moment the sample was taken.** Everything else here
exists to make that rule impossible to break by accident.

Two clocks, never one
---------------------
Every observation carries an ``event_time`` (when the thing happened in the market)
and an ``available_time`` (when your system could first have known it). A request
carries a ``grid_time`` (the point being sampled) and a ``query_time`` (the moment
the question is being asked). A value is eligible only if
``event_time <= grid_time`` **and** ``available_time <= query_time``.

Collapsing those two clocks into one is the single most common way a backtest is
quietly ruined: the value is real, the timestamp is real, and it still could not have
been known when the strategy claims to have used it. Because both clocks are
required arguments here, that mistake cannot be made silently.

Revisions supersede, but only from their own arrival
----------------------------------------------------
Feeds correct themselves. A revision of an event does not retroactively replace the
original — it becomes the answer only for queries asked after the correction landed.
The same ``grid_time``, asked at two different ``query_time`` values, is *supposed*
to return two different numbers. That is the point-in-time contract working, not a
bug.

Staleness is expiry, not decoration
-----------------------------------
A carried-forward value is an assumption that nothing happened since. Past some age
that assumption stops being reasonable, and this module refuses to pretend
otherwise: beyond ``max_staleness_ms`` the value is returned as ``None`` with status
``stale``. The lineage stays visible so you can see *what* expired and how old it
was — a null you can explain is worth more than a number you cannot.

Timestamps are strict on purpose
--------------------------------
Only RFC 3339 UTC strings ending in ``Z`` are accepted, and the calendar date is
validated by round-trip. This matters for cross-language agreement: JavaScript's
``Date.parse`` silently rolls ``2026-02-30`` over to March 2, while Python's date
parsing rejects it. Both ports here reject it, so the same input gives the same
answer in either language.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from math import isfinite
from typing import Any, Iterable, Literal, Mapping, TypedDict

__all__ = [
    "Observation",
    "GridRequest",
    "Sample",
    "SampleStatus",
    "previous_tick",
    "parse_timestamp_us",
    "EPOCH",
]

SampleStatus = Literal["no_history", "not_yet_available", "stale", "exact", "carried"]

#: RFC 3339 UTC, ``Z`` only, with up to microsecond precision.
_TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$"
)

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


class Observation(TypedDict):
    instrument: str
    event_time: str
    available_time: str
    revision: int
    value: float


class GridRequest(TypedDict):
    grid_time: str
    query_time: str


class Sample(TypedDict):
    instrument: str
    grid_time: str
    query_time: str
    value: float | None
    source_event_time: str | None
    source_available_time: str | None
    source_revision: int | None
    staleness_ms: float | None
    status: str


def parse_timestamp_us(timestamp: Any, field: str = "timestamp") -> int:
    """Parse an RFC 3339 UTC timestamp to integer microseconds since the epoch.

    Strict by design. ``2026-02-30T00:00:00Z`` is rejected rather than rolled over,
    which is what keeps this port and the TypeScript one agreeing on the same input.
    """

    if not isinstance(timestamp, str):
        raise ValueError(f"{field} must be an RFC 3339 UTC string ending in Z")
    match = _TIMESTAMP.match(timestamp)
    if match is None:
        raise ValueError(
            f"{field} must be an RFC 3339 UTC string ending in Z "
            f"(up to microsecond precision), got: {timestamp!r}"
        )

    year, month, day, hour, minute, second = (int(part) for part in match.groups()[:6])
    fraction = match.group(7) or ""
    microsecond = int(fraction.ljust(6, "0")) if fraction else 0

    try:
        # datetime rejects an out-of-range day, which is exactly the check that
        # JavaScript's Date.parse skips.
        moment = datetime(
            year, month, day, hour, minute, second, microsecond, tzinfo=timezone.utc
        )
    except ValueError as exc:
        raise ValueError(f"{field} is not a real calendar time: {timestamp!r}") from exc

    delta: timedelta = moment - EPOCH
    return delta.days * 86_400_000_000 + delta.seconds * 1_000_000 + delta.microseconds


def _require_non_negative_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} must be a non-negative integer")
    if value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def _require_finite(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a finite number")
    if not isfinite(value):
        raise ValueError(f"{field} must be a finite number")
    return float(value)


class _ParsedObservation:
    """One validated observation, keyed in integer microseconds."""

    __slots__ = ("instrument", "event_time", "available_time", "event_us",
                 "available_us", "revision", "value")

    def __init__(self, row: Mapping[str, Any]) -> None:
        instrument = row.get("instrument")
        if not isinstance(instrument, str) or not instrument.strip():
            raise ValueError("instrument must be a non-empty string")
        self.instrument = instrument
        self.event_time = row["event_time"]
        self.available_time = row["available_time"]
        self.event_us = parse_timestamp_us(self.event_time, "event_time")
        self.available_us = parse_timestamp_us(self.available_time, "available_time")
        if self.available_us < self.event_us:
            raise ValueError("available_time must not precede event_time")
        self.revision = _require_non_negative_int(row.get("revision"), "revision")
        self.value = _require_finite(row.get("value"), "value")


def _parse_observations(
    observations: Iterable[Mapping[str, Any]],
) -> dict[str, list[_ParsedObservation]]:
    """Validate every observation and group it by instrument, newest event first."""

    by_instrument: dict[str, list[_ParsedObservation]] = {}
    seen: set[tuple[str, int, int]] = set()

    for row in observations:
        if not isinstance(row, Mapping):
            raise ValueError("each observation must be a mapping")
        parsed = _ParsedObservation(row)
        key = (parsed.instrument, parsed.event_us, parsed.revision)
        if key in seen:
            raise ValueError("revisions must be unique per instrument and event_time")
        seen.add(key)
        by_instrument.setdefault(parsed.instrument, []).append(parsed)

    for rows in by_instrument.values():
        # Newest event first, and within one event newest revision first. The lookup
        # then walks forward and stops at the first row it is allowed to use.
        rows.sort(key=lambda row: (-row.event_us, -row.revision))
        _check_revision_arrival_order(rows)

    return by_instrument


def _check_revision_arrival_order(rows: list[_ParsedObservation]) -> None:
    """A higher revision must arrive strictly later than the one it supersedes.

    Without this, "the latest revision available at time T" is ambiguous: two
    revisions of the same event could both be available with no defined winner, and
    the answer would depend on input ordering rather than on the data.
    """

    groups: dict[int, list[_ParsedObservation]] = {}
    for row in rows:
        groups.setdefault(row.event_us, []).append(row)
    for group in groups.values():
        ordered = sorted(group, key=lambda row: row.revision)
        for earlier, later in zip(ordered, ordered[1:]):
            if earlier.available_us >= later.available_us:
                raise ValueError("higher revisions must have later available_time values")


def _parse_requests(
    requests: Iterable[Mapping[str, Any]],
) -> list[tuple[str, str, int, int]]:
    parsed: list[tuple[str, str, int, int]] = []
    seen: set[tuple[int, int]] = set()

    for request in requests:
        if not isinstance(request, Mapping):
            raise ValueError("each request must be a mapping")
        grid_time = request["grid_time"]
        query_time = request["query_time"]
        grid_us = parse_timestamp_us(grid_time, "grid_time")
        query_us = parse_timestamp_us(query_time, "query_time")
        if query_us < grid_us:
            # Asking a question about a grid point *before* that grid point exists
            # is almost always a swapped-argument bug, and silently allowing it
            # would make the as-of guarantee meaningless.
            raise ValueError("query_time must not precede grid_time")
        key = (grid_us, query_us)
        if key in seen:
            raise ValueError("request (grid_time, query_time) pairs must be unique")
        seen.add(key)
        parsed.append((grid_time, query_time, grid_us, query_us))

    return parsed


def _empty_sample(
    instrument: str, grid_time: str, query_time: str, status: str
) -> Sample:
    return {
        "instrument": instrument,
        "grid_time": grid_time,
        "query_time": query_time,
        "value": None,
        "source_event_time": None,
        "source_available_time": None,
        "source_revision": None,
        "staleness_ms": None,
        "status": status,
    }


def _lookup(
    rows: list[_ParsedObservation], grid_us: int, query_us: int
) -> tuple[_ParsedObservation | None, bool]:
    """Find the value in force at ``grid_us`` as known at ``query_us``.

    ``rows`` is pre-sorted newest-event-first, newest-revision-first, so this walks
    forward and stops at the first row that passes both clocks — an early exit
    rather than the two full passes a filter-then-max would cost.

    Returns the chosen row (or ``None``) and whether any row was event-eligible at
    all, which is what separates "nothing has happened yet" from "it has happened
    but you could not have known".
    """

    saw_event_eligible = False
    for row in rows:
        if row.event_us > grid_us:
            continue
        saw_event_eligible = True
        if row.available_us <= query_us:
            return row, True
    return None, saw_event_eligible


def previous_tick(
    observations: Iterable[Mapping[str, Any]],
    requests: Iterable[Mapping[str, Any]],
    max_staleness_ms: int,
) -> list[Sample]:
    """Sample each instrument onto the requested grid, honouring both clocks.

    Args:
        observations: Rows carrying ``instrument``, ``event_time``,
            ``available_time``, ``revision`` and ``value``.
        requests: ``grid_time`` / ``query_time`` pairs to sample.
        max_staleness_ms: How old a carried value may be before it is reported as
            unusable. ``0`` means only an exact hit counts.

    Returns:
        One sample per (instrument, request), instruments in sorted order and
        requests in the order given. Every sample carries its own lineage.
    """

    _require_non_negative_int(max_staleness_ms, "max_staleness_ms")
    max_staleness_us = max_staleness_ms * 1000

    parsed_requests = _parse_requests(requests)
    by_instrument = _parse_observations(observations)

    output: list[Sample] = []
    for instrument in sorted(by_instrument):
        rows = by_instrument[instrument]
        for grid_time, query_time, grid_us, query_us in parsed_requests:
            chosen, saw_event_eligible = _lookup(rows, grid_us, query_us)

            if not saw_event_eligible:
                output.append(
                    _empty_sample(instrument, grid_time, query_time, "no_history")
                )
                continue
            if chosen is None:
                output.append(
                    _empty_sample(instrument, grid_time, query_time, "not_yet_available")
                )
                continue

            staleness_us = grid_us - chosen.event_us
            stale = staleness_us > max_staleness_us
            output.append(
                {
                    "instrument": instrument,
                    "grid_time": grid_time,
                    "query_time": query_time,
                    "value": None if stale else chosen.value,
                    "source_event_time": chosen.event_time,
                    "source_available_time": chosen.available_time,
                    "source_revision": chosen.revision,
                    "staleness_ms": staleness_us / 1000,
                    "status": "stale"
                    if stale
                    else ("exact" if staleness_us == 0 else "carried"),
                }
            )
    return output
