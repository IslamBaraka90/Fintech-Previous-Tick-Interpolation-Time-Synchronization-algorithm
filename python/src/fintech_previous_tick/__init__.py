"""Point-in-time-safe previous-tick interpolation.

The one interpolation method that is safe to run on live data, because it only ever
carries a value *forward* — it never reaches for a number that had not yet arrived.

Quickstart::

    from fintech_previous_tick import previous_tick

    samples = previous_tick(observations, requests, max_staleness_ms=1500)

See :mod:`fintech_previous_tick.core` for the sampling rule,
:mod:`fintech_previous_tick.streaming` for the live engine, and
:mod:`fintech_previous_tick.staleness` for lookahead measurement and budget choice.

Article: https://thefintechbuilder.com/market-data-engineering/time-synchronization/previous-tick-interpolation/
"""

from .core import (
    EPOCH,
    GridRequest,
    Observation,
    Sample,
    SampleStatus,
    parse_timestamp_us,
    previous_tick,
)
from .staleness import (
    build_grid,
    revision_lookahead,
    staleness_budget_sweep,
    staleness_profile,
)
from .streaming import StreamingPreviousTick

__version__ = "0.1.0"

__all__ = [
    "EPOCH",
    "GridRequest",
    "Observation",
    "Sample",
    "SampleStatus",
    "StreamingPreviousTick",
    "__version__",
    "build_grid",
    "parse_timestamp_us",
    "previous_tick",
    "revision_lookahead",
    "staleness_budget_sweep",
    "staleness_profile",
]
