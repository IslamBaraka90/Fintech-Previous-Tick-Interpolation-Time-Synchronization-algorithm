/**
 * Tests for the live engine.
 *
 * The load-bearing assertion is "streaming equals batch": with retention unbounded,
 * feeding observations one at a time must reproduce the batch answer exactly. If that
 * ever drifts, the live path and the backtest path have quietly become two different
 * algorithms — which is the failure this repo exists to prevent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { StreamingPreviousTick } from "../src/streaming.ts";
import type { Sample } from "../src/core.ts";
import { MAX_STALENESS_MS, REQUESTS, observations, requests, sample } from "./fixtures.ts";

const ARRIVAL_ORDER = [...observations()].sort((a, b) =>
  a.available_time < b.available_time ? -1 : a.available_time > b.available_time ? 1 : 0,
);

const fed = (
  maxStalenessMs = MAX_STALENESS_MS,
  retentionMs: number | null = null,
  rows?: unknown[],
): StreamingPreviousTick => {
  const engine = new StreamingPreviousTick(maxStalenessMs, retentionMs);
  engine.observeMany(rows ?? ARRIVAL_ORDER);
  return engine;
};

const order = (rows: Sample[]): Sample[] =>
  [...rows].sort((a, b) =>
    `${a.instrument}${a.grid_time}${a.query_time}` <
    `${b.instrument}${b.grid_time}${b.query_time}`
      ? -1
      : 1,
  );

// --- equivalence with the batch function -------------------------------------- //
test("streaming equals batch", () => {
  const engine = fed();
  const streamed = requests().flatMap((request) =>
    engine.sample(request.grid_time, request.query_time),
  );
  assert.deepEqual(order(streamed), order(sample()));
});

test("a fresh engine reports nothing", () => {
  const engine = new StreamingPreviousTick(MAX_STALENESS_MS);
  assert.deepEqual(engine.instruments, []);
  assert.deepEqual(engine.sample(REQUESTS[0]!.grid_time, REQUESTS[0]!.query_time), []);
});

test("the engine tracks its instruments", () => {
  assert.deepEqual(fed().instruments, ["A", "B"]);
});

// --- arrival order is enforced ------------------------------------------------- //
test("out-of-order arrival is rejected", () => {
  const engine = new StreamingPreviousTick(MAX_STALENESS_MS);
  engine.observe(ARRIVAL_ORDER.at(-1));
  assert.throws(
    () => engine.observe(ARRIVAL_ORDER[0]),
    /non-decreasing available_time/,
  );
});

test("simultaneous arrivals are allowed", () => {
  const engine = new StreamingPreviousTick(MAX_STALENESS_MS);
  for (const instrument of ["A", "B"]) {
    engine.observe({
      instrument,
      event_time: "2026-01-02T14:30:00.000Z",
      available_time: "2026-01-02T14:30:00.000Z",
      revision: 0,
      value: 1.0,
    });
  }
  assert.deepEqual(engine.instruments, ["A", "B"]);
});

test("a duplicate revision is rejected live", () => {
  const engine = fed();
  assert.throws(() => engine.observe(observations(2)[0]), /unique per instrument/);
});

test("a revision that arrives too early is rejected live", () => {
  const engine = new StreamingPreviousTick(MAX_STALENESS_MS);
  engine.observe(observations(0)[0]);
  const bad = observations(1)[0]!;
  // Landing in the SAME millisecond as revision 0 — late enough to pass the
  // arrival-order check, so it is the revision rule that has to catch it.
  bad.available_time = "2026-01-02T14:30:00.180Z";
  assert.throws(() => engine.observe(bad), /higher revisions must have later/);
});

// --- retention ----------------------------------------------------------------- //
test("unbounded retention drops nothing", () => {
  const engine = fed();
  assert.equal(engine.dropped, 0);
  assert.equal(engine.retained, ARRIVAL_ORDER.length);
});

test("retention bounds memory", () => {
  const engine = fed(MAX_STALENESS_MS, 500);
  assert.ok(engine.retained < ARRIVAL_ORDER.length);
  assert.ok(engine.dropped > 0);
});

test("retention can turn a carry into no_history", () => {
  const kept = fed().sampleInstrument(
    "B",
    "2026-01-02T14:30:03.000Z",
    "2026-01-02T14:30:03.000Z",
  );
  const pruned = fed(MAX_STALENESS_MS, 0).sampleInstrument(
    "A",
    "2026-01-02T14:30:00.000Z",
    "2026-01-02T14:30:00.000Z",
  );
  assert.equal(kept.status, "carried");
  assert.equal(pruned.status, "no_history");
});

test("a negative retention raises", () => {
  assert.throws(() => new StreamingPreviousTick(MAX_STALENESS_MS, -1), /retention_ms/);
});

test("a negative budget raises", () => {
  assert.throws(() => new StreamingPreviousTick(-1), /max_staleness_ms/);
});

// --- querying ------------------------------------------------------------------ //
test("a query before its grid point raises", () => {
  assert.throws(
    () =>
      fed().sampleInstrument("A", "2026-01-02T14:30:02.000Z", "2026-01-02T14:30:01.000Z"),
    /query_time must not precede grid_time/,
  );
});

test("an unknown instrument reports no_history", () => {
  const row = fed().sampleInstrument(
    "ZZZ",
    "2026-01-02T14:30:03.000Z",
    "2026-01-02T14:30:03.000Z",
  );
  assert.equal(row.status, "no_history");
  assert.equal(row.value, null);
});

test("sampling does not consume state", () => {
  const engine = fed();
  const first = engine.sample("2026-01-02T14:30:03.000Z", "2026-01-02T14:30:03.000Z");
  const second = engine.sample("2026-01-02T14:30:03.000Z", "2026-01-02T14:30:03.000Z");
  assert.deepEqual(first, second);
});

test("a later observation changes a later answer", () => {
  const engine = new StreamingPreviousTick(MAX_STALENESS_MS);
  engine.observe(observations(0)[0]);
  const before = engine.sampleInstrument(
    "A",
    "2026-01-02T14:30:01.000Z",
    "2026-01-02T14:30:02.000Z",
  );
  engine.observe(observations(1)[0]);
  const after = engine.sampleInstrument(
    "A",
    "2026-01-02T14:30:01.000Z",
    "2026-01-02T14:30:02.000Z",
  );
  assert.equal(before.source_revision, 0);
  assert.equal(after.source_revision, 1);
});

// --- checkpoint / restore ------------------------------------------------------ //
test("a checkpoint round-trips", () => {
  const engine = fed();
  const restored = StreamingPreviousTick.restore(engine.checkpoint());
  const grid = "2026-01-02T14:30:03.000Z";
  assert.deepEqual(restored.sample(grid, grid), engine.sample(grid, grid));
});

test("a checkpoint is JSON-safe", () => {
  const state = fed().checkpoint();
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test("a restored engine keeps taking observations", () => {
  const engine = new StreamingPreviousTick(MAX_STALENESS_MS);
  engine.observeMany(ARRIVAL_ORDER.slice(0, 2));
  const restored = StreamingPreviousTick.restore(engine.checkpoint());
  for (const row of ARRIVAL_ORDER.slice(2)) restored.observe(row);
  assert.equal(restored.retained, ARRIVAL_ORDER.length);
});

test("a restored engine keeps its settings", () => {
  const engine = fed(42, 99);
  const state = StreamingPreviousTick.restore(engine.checkpoint()).checkpoint();
  assert.equal(state.max_staleness_ms, 42);
  assert.equal(state.retention_ms, 99);
});

for (const state of [{}, { max_staleness_ms: 1 }, "nope", 7, null] as unknown[]) {
  test(`a malformed checkpoint raises (${JSON.stringify(state)})`, () => {
    assert.throws(() => StreamingPreviousTick.restore(state));
  });
}
