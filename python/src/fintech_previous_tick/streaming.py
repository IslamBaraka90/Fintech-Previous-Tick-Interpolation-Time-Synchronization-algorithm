"""A live as-of engine: ingest observations as they arrive, answer grid queries.

:func:`~fintech_previous_tick.core.previous_tick` needs the whole history in hand.
That is right for a backtest and wrong for a running system, where observations
arrive one at a time and the grid is sampled as the clock passes each point.

This engine holds the same contract with two additions that only matter live:

**Arrival order is enforced.** Observations must be fed in non-decreasing
``available_time`` order, because that is the order a real feed delivers them. An
out-of-order feed is a genuine fault — accepting it silently would let the engine
answer a query with a value it should not yet have had.

**Memory is bounded.** A process that runs for months cannot keep every tick.
``retention_ms`` drops observations that are older than the retention window
measured back from the newest event seen. This is a real trade, stated plainly: a
dropped observation can turn a sample that would have been ``carried`` into
``no_history``. Leave ``retention_ms`` at ``None`` and the engine keeps everything,
in which case it returns *exactly* what the batch function returns for the same
data — which is what the test suite asserts.

:meth:`StreamingPreviousTick.checkpoint` and :meth:`restore` round-trip the engine
through plain JSON so a restart resumes mid-session instead of replaying from the
open.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .core import (
    Sample,
    _empty_sample,
    _ParsedObservation,
    _require_non_negative_int,
    parse_timestamp_us,
)

__all__ = ["StreamingPreviousTick"]


class StreamingPreviousTick:
    """Incremental previous-tick sampling with bounded memory.

    Args:
        max_staleness_ms: Same meaning as in the batch function — the age past
            which a carried value is reported unusable.
        retention_ms: How far back to keep observations, measured from the newest
            event seen. ``None`` keeps everything.
    """

    def __init__(
        self, max_staleness_ms: int, retention_ms: int | None = None
    ) -> None:
        _require_non_negative_int(max_staleness_ms, "max_staleness_ms")
        if retention_ms is not None:
            _require_non_negative_int(retention_ms, "retention_ms")
        self._max_staleness_us = max_staleness_ms * 1000
        self._max_staleness_ms = max_staleness_ms
        self._retention_ms = retention_ms
        self._rows: dict[str, list[_ParsedObservation]] = {}
        self._last_available_us: int | None = None
        self._newest_event_us: int | None = None
        self._seen: set[tuple[str, int, int]] = set()
        self._dropped = 0

    # --- ingestion ---------------------------------------------------------- #
    def observe(self, observation: Mapping[str, Any]) -> None:
        """Ingest one observation. Must not arrive before the previous one."""

        if not isinstance(observation, Mapping):
            raise ValueError("each observation must be a mapping")
        parsed = _ParsedObservation(observation)

        if (
            self._last_available_us is not None
            and parsed.available_us < self._last_available_us
        ):
            raise ValueError(
                "observations must arrive in non-decreasing available_time order"
            )
        key = (parsed.instrument, parsed.event_us, parsed.revision)
        if key in self._seen:
            raise ValueError("revisions must be unique per instrument and event_time")

        rows = self._rows.setdefault(parsed.instrument, [])
        for existing in rows:
            if existing.event_us != parsed.event_us:
                continue
            earlier, later = (
                (existing, parsed)
                if existing.revision < parsed.revision
                else (parsed, existing)
            )
            if earlier.available_us >= later.available_us:
                raise ValueError(
                    "higher revisions must have later available_time values"
                )

        self._seen.add(key)
        self._last_available_us = parsed.available_us
        self._newest_event_us = (
            parsed.event_us
            if self._newest_event_us is None
            else max(self._newest_event_us, parsed.event_us)
        )
        # Keep the newest-first ordering the lookup depends on.
        rows.append(parsed)
        rows.sort(key=lambda row: (-row.event_us, -row.revision))
        self._evict()

    def observe_many(self, observations: Iterable[Mapping[str, Any]]) -> None:
        for observation in observations:
            self.observe(observation)

    def _evict(self) -> None:
        if self._retention_ms is None or self._newest_event_us is None:
            return
        horizon = self._newest_event_us - self._retention_ms * 1000
        for instrument, rows in self._rows.items():
            kept = [row for row in rows if row.event_us >= horizon]
            self._dropped += len(rows) - len(kept)
            self._rows[instrument] = kept

    # --- querying ----------------------------------------------------------- #
    def sample_instrument(
        self, instrument: str, grid_time: str, query_time: str
    ) -> Sample:
        """Sample one instrument at one grid point, as known at ``query_time``."""

        grid_us = parse_timestamp_us(grid_time, "grid_time")
        query_us = parse_timestamp_us(query_time, "query_time")
        if query_us < grid_us:
            raise ValueError("query_time must not precede grid_time")

        rows = self._rows.get(instrument, [])
        saw_event_eligible = False
        for row in rows:
            if row.event_us > grid_us:
                continue
            saw_event_eligible = True
            if row.available_us <= query_us:
                staleness_us = grid_us - row.event_us
                stale = staleness_us > self._max_staleness_us
                return {
                    "instrument": instrument,
                    "grid_time": grid_time,
                    "query_time": query_time,
                    "value": None if stale else row.value,
                    "source_event_time": row.event_time,
                    "source_available_time": row.available_time,
                    "source_revision": row.revision,
                    "staleness_ms": staleness_us / 1000,
                    "status": "stale"
                    if stale
                    else ("exact" if staleness_us == 0 else "carried"),
                }

        status = "not_yet_available" if saw_event_eligible else "no_history"
        return _empty_sample(instrument, grid_time, query_time, status)

    def sample(self, grid_time: str, query_time: str) -> list[Sample]:
        """Sample every instrument seen so far, in sorted order."""

        return [
            self.sample_instrument(instrument, grid_time, query_time)
            for instrument in sorted(self._rows)
        ]

    # --- introspection ------------------------------------------------------ #
    @property
    def instruments(self) -> list[str]:
        return sorted(self._rows)

    @property
    def retained(self) -> int:
        """How many observations are currently held."""

        return sum(len(rows) for rows in self._rows.values())

    @property
    def dropped(self) -> int:
        """How many observations retention has discarded. Non-zero means samples
        may report ``no_history`` where the batch function would carry a value."""

        return self._dropped

    # --- persistence -------------------------------------------------------- #
    def checkpoint(self) -> dict[str, Any]:
        """Serialise the engine to plain JSON-safe data."""

        return {
            "max_staleness_ms": self._max_staleness_ms,
            "retention_ms": self._retention_ms,
            "dropped": self._dropped,
            # Serialised in ARRIVAL order, globally across instruments — not grouped
            # by instrument. restore() replays through observe(), which enforces
            # non-decreasing available_time, so a per-instrument grouping would make
            # an engine's own checkpoint unrestorable the moment it held two symbols.
            "observations": [
                {
                    "instrument": row.instrument,
                    "event_time": row.event_time,
                    "available_time": row.available_time,
                    "revision": row.revision,
                    "value": row.value,
                }
                for row in sorted(
                    (row for rows in self._rows.values() for row in rows),
                    key=lambda row: (
                        row.available_us,
                        row.event_us,
                        row.revision,
                        row.instrument,
                    ),
                )
            ],
        }

    @classmethod
    def restore(cls, state: Mapping[str, Any]) -> "StreamingPreviousTick":
        """Rebuild an engine from :meth:`checkpoint` output."""

        if not isinstance(state, Mapping):
            raise ValueError("state must be a mapping from checkpoint()")
        for field in ("max_staleness_ms", "observations"):
            if field not in state:
                raise ValueError(f"state is missing {field}")

        engine = cls(state["max_staleness_ms"], state.get("retention_ms"))
        engine.observe_many(state["observations"])
        engine._dropped = int(state.get("dropped", 0))
        return engine
