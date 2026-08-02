# Fintech Previous-Tick Interpolation — Time Synchronization Algorithm

> A canonical, well-specified, **cross-language (Python + TypeScript)** reference
> implementation of point-in-time-safe previous-tick sampling — the one interpolation
> method that is safe to run on live data, because it only ever carries a value
> *forward*. Every observation carries **two clocks** (`event_time` and
> `available_time`) and every request carries two more (`grid_time` and `query_time`),
> so the mistake that quietly ruins backtests — using a number before anybody had it —
> cannot be made silently. Carried values **expire** instead of pretending to be fresh,
> a `staleness` surface **measures the lookahead** a revised-file backtest would have
> absorbed, and a streaming engine gives you the identical answer live.

<p>
  <img alt="Python" src="https://img.shields.io/badge/python-3.10%2B-blue">
  <img alt="TypeScript" src="https://img.shields.io/badge/typescript-5.7%2B-3178c6">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="Tests" src="https://img.shields.io/badge/tests-120%20py%20%2F%20127%20ts-brightgreen">
</p>

**📖 Full article (canonical):** **[Previous-Tick Interpolation — The Fintech Builder](https://thefintechbuilder.com/market-data-engineering/time-synchronization/previous-tick-interpolation/)**

This repository is the runnable, production-oriented companion to that article.
The article teaches the concept; this repo is the code you install and build on.

🧭 **Browse all algorithms:** [Awesome FinTech Algorithms](https://github.com/IslamBaraka90/Fintech-Algorithms-Awesome) — the full index of the library.
🗂️ **This algorithm's domain:** [Market Data Engineering](https://thefintechbuilder.com/domains/market-data-engineering/) › **Time Synchronization**
📥 **Just want to call it?** It also ships in the [`fintech-algorithms`](https://www.npmjs.com/package/fintech-algorithms) npm package — see [Two ways to use this](#two-ways-to-use-this).

| | |
|---|---|
| **Catalog topic** | `D01-F03-A01` |
| **Domain** | D01 — Market Data Engineering |
| **Family** | D01-F03 — Time Synchronization |
| **Difficulty** | 2 / 5 |
| **Languages** | Python, TypeScript |
| **Opens** | the D01-F03 family — A01 of A01…A05 |

---

## Table of contents

- [Why two clocks](#why-two-clocks)
- [What it returns](#what-it-returns)
- [Revisions supersede, but only from their own arrival](#revisions-supersede-but-only-from-their-own-arrival)
- [Staleness is expiry, not decoration](#staleness-is-expiry-not-decoration)
- [Two ways to use this](#two-ways-to-use-this)
- [Install](#install)
- [Quickstart](#quickstart)
- [Worked example (exact)](#worked-example-exact)
- [Staleness: lookahead, budget, coverage](#staleness-lookahead-budget-coverage)
- [Streaming](#streaming)
- [Row shapes](#row-shapes)
- [API reference](#api-reference)
- [Edge cases & limitations](#edge-cases--limitations)
- [Testing](#testing)
- [Related algorithms](#related-algorithms)
- [License](#license)

---

## Why two clocks

Most sampling code has one timestamp per row and one timestamp per query. That is
enough to be wrong in a way that is almost impossible to see.

A trade printed at 14:30:00.100 might not reach your system until 14:30:00.180. A
correction to that same print might not land until 14:30:01.400 — **1.3 seconds
later**. If your sampler only knows *when things happened* and not *when you learned
them*, it will happily hand a 14:30:01 grid point the corrected value, and your
backtest will have traded on a number that did not exist yet. The value is real. The
timestamp is real. The result is still fiction.

So every observation here carries:

| Field | Meaning |
|---|---|
| `event_time` | when it happened in the market |
| `available_time` | when your system could first have known it |

and every request carries:

| Field | Meaning |
|---|---|
| `grid_time` | the point being sampled |
| `query_time` | the moment the question is being asked |

A value is eligible only if `event_time <= grid_time` **and**
`available_time <= query_time`. Both are required arguments — there is no
single-clock convenience overload, because that overload is the bug.

---

## What it returns

One sample per (instrument, request), each carrying its own lineage:

| `status` | Meaning |
|---|---|
| `exact` | a value landed exactly on the grid point |
| `carried` | the last known value, carried forward, within budget |
| `stale` | a value existed but is older than `max_staleness_ms` — returned as `null` |
| `not_yet_available` | it had happened, but you could not have known it yet |
| `no_history` | nothing had happened for this instrument yet |

`not_yet_available` and `no_history` are deliberately **not** merged. One means the
market was silent; the other means your pipeline was behind. Those call for opposite
fixes, and a single `null` would hide which one you have.

---

## Revisions supersede, but only from their own arrival

Feeds correct themselves. A revision does not retroactively replace the original — it
becomes the answer only for queries asked *after* the correction landed.

The consequence surprises people, so it is worth stating plainly: **the same
`grid_time`, asked at two different `query_time` values, is supposed to return two
different numbers.**

```
grid 14:30:01 asked at 14:30:01.000  ->  value=100.0  revision=0
grid 14:30:01 asked at 14:30:02.000  ->  value=99.8   revision=1
```

That is the point-in-time contract working. Code that returns 99.8 for both is not
more consistent — it is leaking the future into the past.

A revision must also arrive **strictly later** than the one it supersedes, and this is
enforced. Otherwise "the latest revision available at time T" has no defined winner,
and the answer would depend on input ordering rather than on the data.

---

## Staleness is expiry, not decoration

A carried-forward value is an assumption that nothing has happened since. Past some
age that assumption stops being reasonable, and this module refuses to pretend
otherwise: beyond `max_staleness_ms` the value comes back `null` with status `stale`.

The lineage stays visible — you still see *what* expired, how old it was, and which
revision it came from. **A null you can explain is worth more than a number you
cannot.**

---

## Two ways to use this

**📥 The fast path — one call, TypeScript only:**

```bash
npm install fintech-algorithms
```

```ts
import { previousTick } from "fintech-algorithms/market-data-engineering/time-synchronization/previous-tick-interpolation";
```

That package is the breadth option: 271 algorithms, one install, the tutorial-level
kernel for each.

**🔬 This repo — the depth option.** Python *and* TypeScript, the streaming engine,
the `staleness` surface (lookahead measurement, budget sweeps, coverage profiling),
microsecond-precision timestamps, strict calendar validation, and 247 tests pinning
both languages to one shared fixture. Use it when previous-tick sampling is load
bearing rather than incidental.

---

## Install

**Python** (3.10+, no dependencies):

```bash
git clone https://github.com/IslamBaraka90/Fintech-Previous-Tick-Interpolation-Time-Synchronization-algorithm.git
cd Fintech-Previous-Tick-Interpolation-Time-Synchronization-algorithm/python
pip install -e ".[dev]"
```

**TypeScript** (Node 20+, no runtime dependencies):

```bash
cd Fintech-Previous-Tick-Interpolation-Time-Synchronization-algorithm/typescript
npm install
npm run build
```

---

## Quickstart

**Python**

```python
from fintech_previous_tick import build_grid, previous_tick

observations = [
    {"instrument": "A", "event_time": "2026-01-02T14:30:00.100Z",
     "available_time": "2026-01-02T14:30:00.180Z", "revision": 0, "value": 100.0},
    {"instrument": "A", "event_time": "2026-01-02T14:30:02.200Z",
     "available_time": "2026-01-02T14:30:02.260Z", "revision": 0, "value": 100.4},
]

grid = build_grid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z",
                  step_ms=1000, lag_ms=100)

for row in previous_tick(observations, grid, max_staleness_ms=1500):
    print(row["grid_time"], row["value"], row["status"])
```

**TypeScript**

```ts
import { buildGrid, previousTick } from "fintech-previous-tick";

const grid = buildGrid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 1000, 100);

for (const row of previousTick(observations, grid, 1500)) {
  console.log(row.grid_time, row.value, row.status);
}
```

`build_grid`'s `lag_ms` is the honest part: your system does not ask about 09:30:00 at
exactly 09:30:00. Setting it to zero asserts the stronger claim that you query with no
delay at all.

---

## Worked example (exact)

Five observations across two instruments, `max_staleness_ms = 1500`. These values are
asserted verbatim by both test suites from one shared JSON fixture.

**Observations**

| instrument | event_time | available_time | rev | value |
|---|---|---|---|---|
| A | 14:30:00.100 | 14:30:00.180 | 0 | 100.0 |
| A | 14:30:00.100 | 14:30:01.400 | 1 | 99.8 |
| A | 14:30:02.200 | 14:30:02.260 | 0 | 100.4 |
| B | 14:30:00.700 | 14:30:01.200 | 0 | 50.0 |
| B | 14:30:01.900 | 14:30:01.950 | 0 | 50.2 |

**Samples**

| instrument | grid | query | value | rev | age (ms) | status |
|---|---|---|---|---|---|---|
| A | 14:30:00 | 14:30:00 | — | — | — | `no_history` |
| A | 14:30:01 | 14:30:01 | 100.0 | 0 | 900 | `carried` |
| A | 14:30:01 | 14:30:02 | **99.8** | **1** | 900 | `carried` |
| A | 14:30:02 | 14:30:02 | — | 1 | 1900 | `stale` |
| A | 14:30:03 | 14:30:03 | 100.4 | 0 | 800 | `carried` |
| B | 14:30:00 | 14:30:00 | — | — | — | `no_history` |
| B | 14:30:01 | 14:30:01 | — | — | — | `not_yet_available` |
| B | 14:30:01 | 14:30:02 | 50.0 | 0 | 300 | `carried` |
| B | 14:30:02 | 14:30:02 | 50.2 | 0 | 100 | `carried` |
| B | 14:30:03 | 14:30:03 | 50.2 | 0 | 1100 | `carried` |

Three rows carry the whole lesson:

- **Rows 2 and 3** are the same grid point at two knowledge times, and they differ.
- **Row 4** expired: the newest thing A had was 1.9s old, over the 1.5s budget, so the
  value is `null` — but revision 1 is still named as the source.
- **Row 7** is `not_yet_available`, not `no_history`: B's 14:30:00.700 print had
  happened, it just had not reached you by 14:30:01.

---

## Staleness: lookahead, budget, coverage

This is the surface that does not fit in a tutorial, and the reason to install the
repo rather than copy the snippet.

### `revision_lookahead` — the number that belongs in a research note

It samples the same grid twice: once honestly, and once the way a naive pipeline does
it by reading a revised historical file and ignoring `available_time`. Every row where
the two disagree is a row a backtest would have taken from information nobody had.

```
2/8 samples would differ (25%), worst gap 0.2000
  A 14:30:01.000  honest=100.0  revised=99.8  [revision_differs]
  B 14:30:01.000  honest=None   revised=50.0  [invented_value]
```

`invented_value` is the shape to be frightened of: the honest view had **nothing**,
and the revised file supplied a number. That is not a small numeric difference — it is
a data point conjured out of nowhere.

### `staleness_budget_sweep` — pick the budget off a curve

The budget is usually chosen by feel, which means it is chosen to make the output look
good. The sweep re-samples across candidates and reports how the usable/stale split
moves:

```
    0ms  ->  0/8 usable
  500ms  ->  1/8 usable  (+1)
 1000ms  ->  3/8 usable  (+2)
 2000ms  ->  5/8 usable  (+2)
 5000ms  ->  5/8 usable  (+0)
```

Read it for a **flat stretch** and pick from the middle. A budget on a steep segment is
one where a small change in feed latency moves many samples between usable and
unusable — which is how a series that backtested cleanly starts behaving differently
in production.

### `staleness_profile` — coverage, honestly counted

Per-instrument status counts, worst carry, median carry, and a `usable_share` that
counts **only** `exact` and `carried`. A stale sample is not a value you may use, and
folding it into a coverage number would report the opposite of what happened.

---

## Streaming

`StreamingPreviousTick` ingests observations one at a time and answers grid queries as
the clock passes each point. Two additions that only matter live:

**Arrival order is enforced.** Observations must arrive in non-decreasing
`available_time` order, because that is how a real feed delivers them. Accepting an
out-of-order feed silently would let the engine answer with a value it should not yet
have had.

**Memory is bounded.** `retention_ms` drops observations older than the window,
measured back from the newest event. The cost is stated rather than hidden: a dropped
observation can turn a `carried` sample into `no_history`, and `engine.dropped` tells
you it happened.

With retention unbounded the engine returns **exactly** what the batch function
returns for the same data — asserted by the test suite in both languages, because the
moment the live path and the backtest path disagree you have two different algorithms.

```python
engine = StreamingPreviousTick(max_staleness_ms=1500)
engine.observe_many(feed)                       # in arrival order
engine.sample("2026-01-02T14:30:03.000Z", "2026-01-02T14:30:03.000Z")

state = engine.checkpoint()                     # plain JSON
resumed = StreamingPreviousTick.restore(state)  # resume mid-session
```

---

## Row shapes

**Observation**

| Field | Type | Notes |
|---|---|---|
| `instrument` | `str` | non-empty |
| `event_time` | `str` | RFC 3339 UTC, `Z` only, up to microsecond precision |
| `available_time` | `str` | must not precede `event_time` |
| `revision` | `int` | ≥ 0; higher revisions must arrive strictly later |
| `value` | `float` | finite |

**Request**

| Field | Type | Notes |
|---|---|---|
| `grid_time` | `str` | the point being sampled |
| `query_time` | `str` | must not precede `grid_time` |

**Sample** — `instrument`, `grid_time`, `query_time`, `value`, `source_event_time`,
`source_available_time`, `source_revision`, `staleness_ms`, `status`.

Timestamps are strict on purpose. Only `Z`-suffixed RFC 3339 is accepted, and the
calendar date is validated by explicit civil arithmetic — **not** `Date.parse`, which
silently rolls `2026-02-30` over to March 2 where Python's date parsing rejects it.
Both ports here reject it, so the same input gives the same answer in either language.

---

## API reference

| Python | TypeScript | Purpose |
|---|---|---|
| `previous_tick(observations, requests, max_staleness_ms)` | `previousTick(...)` | Batch as-of sampling |
| `build_grid(start, end, step_ms, lag_ms=0)` | `buildGrid(...)` | Generate grid requests |
| `staleness_profile(samples)` | `stalenessProfile(...)` | Per-instrument coverage and ages |
| `revision_lookahead(observations, requests, max_staleness_ms)` | `revisionLookahead(...)` | Lookahead a revised-file backtest absorbs |
| `staleness_budget_sweep(observations, requests, candidates)` | `stalenessBudgetSweep(...)` | Usable/stale split across budgets |
| `StreamingPreviousTick(max_staleness_ms, retention_ms=None)` | `new StreamingPreviousTick(...)` | Live engine |
| `.observe(row)` / `.observe_many(rows)` | `.observe(row)` / `.observeMany(rows)` | Ingest |
| `.sample(grid, query)` / `.sample_instrument(...)` | `.sample(...)` / `.sampleInstrument(...)` | Query |
| `.checkpoint()` / `.restore(state)` | `.checkpoint()` / `.restore(state)` | Persist and resume |
| `parse_timestamp_us(timestamp)` | `parseTimestampUs(...)` | Strict RFC 3339 → microseconds |

---

## Edge cases & limitations

- **This algorithm carries values forward, never backward.** It is safe on live data
  precisely because it cannot interpolate *toward* a future point. If you need a value
  between two observations, that is [linear quote interpolation](https://thefintechbuilder.com/market-data-engineering/time-synchronization/linear-quote-interpolation/) — and it is **not** safe on live data.
- **A carried value is an assumption, not an observation.** An instrument that is 90%
  `carried` at 40 seconds of age is not being sampled; it is being invented. The
  profile will tell you, but it cannot decide for you.
- **`max_staleness_ms` is a policy, not a fact.** Two desks will pick different
  numbers for the same feed and both can be right. Run the sweep.
- **Retention trades memory for coverage.** With `retention_ms` set, a sample that
  would have been `carried` can come back `no_history`. Check `engine.dropped`.
- **Timestamps must be UTC with a `Z` suffix.** Offset forms like `+00:00` are
  rejected rather than normalised, so a mixed-zone feed fails loudly at the boundary
  instead of quietly an hour off.
- **Precision is microseconds.** Timestamps with more than six fractional digits are
  rejected rather than silently truncated.
- **Cross-instrument alignment is not attempted here.** Sampling two instruments onto
  one grid does not make their returns comparable — see [asynchronous return alignment](https://thefintechbuilder.com/market-data-engineering/time-synchronization/asynchronous-return-alignment/).

---

## Testing

```bash
cd python && pytest -q          # 120 tests
cd typescript && npm test       # 127 tests
```

Both suites read the **same** `fixtures.json`. The ten expected rows in the
[worked example](#worked-example-exact) are asserted verbatim in each language, which
is what makes the cross-language parity claim mean something rather than being a
statement of intent.

The suites also pin the behaviours most likely to drift:

- streaming with unbounded retention **equals** the batch result, row for row;
- `2026-02-30` is rejected in both languages (with a test proving JavaScript's
  `Date.parse` would have rolled it to March 2);
- `2024-02-29` is accepted, `2026-02-29` and `1900-02-29` are not;
- input rows are never mutated, and input order never changes the answer.

---

## Related algorithms

**Same family — D01-F03 Time Synchronization**

- **[Linear Quote Interpolation](https://github.com/IslamBaraka90/Fintech-Linear-Quote-Interpolation-Time-Synchronization-algorithm)** — the interpolation that *is* lookahead, and where it is legitimately used.
- **[Refresh-Time Sampling](https://github.com/IslamBaraka90/Fintech-Refresh-Time-Sampling-Time-Synchronization-algorithm)** — sampling on a barrier defined by the data instead of the clock.
- Exchange Calendar Alignment · Asynchronous Return Alignment *(articles live; repos pending)*

**Upstream — D01-F02 Cleaning and Validation**

- **[Stale Quote Detector](https://github.com/IslamBaraka90/Fintech-Stale-Quote-Detector-Data-Quality-algorithm)** — the same staleness question, asked of the raw feed rather than the grid.
- **[Crossed/Locked Market Detector](https://github.com/IslamBaraka90/Fintech-Crossed-Locked-Market-Detector-Data-Quality-algorithm)** · **[Duplicate Trade Resolver](https://github.com/IslamBaraka90/Fintech-Duplicate-Trade-Resolver-Data-Quality-algorithm)** · **[OHLC Consistency Validator](https://github.com/IslamBaraka90/Fintech-OHLC-Consistency-Validator-Data-Quality-algorithm)**

🧭 **[Browse all algorithms →](https://github.com/IslamBaraka90/Fintech-Algorithms-Awesome)**

---

## License

MIT — see [LICENSE](LICENSE).

The synthetic fixture data is CC0-1.0. No market data is redistributed.
