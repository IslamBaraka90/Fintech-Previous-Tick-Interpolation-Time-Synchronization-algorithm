/**
 * Contract tests for the sampler.
 *
 * The fixture is the cross-language acceptance anchor: two instruments, a revision
 * that lands 1.3s after the event it corrects, a gap wide enough to expire, and a
 * request pair that asks the *same* grid point at two different knowledge times. Its
 * ten expected rows are asserted verbatim by this suite and by the Python one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTimestampUs, previousTick, type Observation } from "../src/core.ts";
import { EXPECTED, MAX_STALENESS_MS, observations, requests, sample } from "./fixtures.ts";

// --- the shared fixture ------------------------------------------------------- //
test("every sample matches the fixture", () => {
  assert.deepEqual(sample(), EXPECTED);
});

test("one sample per instrument and request", () => {
  assert.equal(sample().length, 2 * requests().length);
});

test("the fixture exercises every status", () => {
  assert.deepEqual(
    [...new Set(EXPECTED.map((row) => row.status))].sort(),
    ["carried", "no_history", "not_yet_available", "stale"],
  );
});

test("instruments come out sorted", () => {
  const instruments = sample().map((row) => row.instrument);
  assert.deepEqual(instruments, [...instruments].sort());
});

test("requests keep their input order", () => {
  const gridTimes = sample()
    .filter((row) => row.instrument === "A")
    .map((row) => row.grid_time);
  assert.deepEqual(gridTimes, requests().map((request) => request.grid_time));
});

test("an empty grid produces nothing", () => {
  assert.deepEqual(sample(null, []), []);
});

test("no observations means no rows", () => {
  assert.deepEqual(previousTick([], requests(), MAX_STALENESS_MS), []);
});

// --- the two clocks ----------------------------------------------------------- //
test("the same grid point answers differently at two query times", () => {
  const rows = sample().filter((row) => row.instrument === "A");
  const early = rows.find(
    (row) => row.grid_time.endsWith("01.000Z") && row.query_time.endsWith("01.000Z"),
  )!;
  const late = rows.find(
    (row) => row.grid_time.endsWith("01.000Z") && row.query_time.endsWith("02.000Z"),
  )!;

  assert.equal(early.grid_time, late.grid_time);
  assert.equal(early.value, 100.0);
  assert.equal(early.source_revision, 0);
  assert.equal(late.value, 99.8);
  assert.equal(late.source_revision, 1);
});

test("a value that has not arrived is not used", () => {
  const row = sample().find(
    (item) => item.instrument === "B" && item.query_time.endsWith("01.000Z"),
  )!;
  assert.equal(row.status, "not_yet_available");
  assert.equal(row.value, null);
});

test("no_history is distinct from not_yet_available", () => {
  const first = sample().filter((row) => row.grid_time.endsWith("00.000Z"));
  assert.deepEqual([...new Set(first.map((row) => row.status))], ["no_history"]);
  assert.ok(first.every((row) => row.source_event_time === null));
});

test("query_time may not precede grid_time", () => {
  assert.throws(
    () =>
      previousTick(
        observations(),
        [{ grid_time: "2026-01-02T14:30:02.000Z", query_time: "2026-01-02T14:30:01.000Z" }],
        MAX_STALENESS_MS,
      ),
    /query_time must not precede grid_time/,
  );
});

test("available_time may not precede event_time", () => {
  const rows = observations(0);
  rows[0]!.available_time = "2026-01-02T14:30:00.000Z";
  assert.throws(
    () => previousTick(rows, requests(), MAX_STALENESS_MS),
    /available_time must not precede event_time/,
  );
});

test("duplicate request pairs are rejected", () => {
  assert.throws(
    () => previousTick(observations(), requests(1, 1), MAX_STALENESS_MS),
    /unique/,
  );
});

test("the same grid at a different query time is not a duplicate", () => {
  assert.equal(previousTick(observations(), requests(1, 2), MAX_STALENESS_MS).length, 4);
});

// --- staleness ---------------------------------------------------------------- //
test("a value older than the budget expires", () => {
  const row = sample().find((item) => item.status === "stale")!;
  assert.equal(row.value, null);
  assert.ok((row.staleness_ms as number) > MAX_STALENESS_MS);
});

test("an expired sample keeps its lineage", () => {
  const row = sample().find((item) => item.status === "stale")!;
  assert.equal(row.source_event_time, "2026-01-02T14:30:00.100Z");
  assert.equal(row.source_revision, 1);
  assert.equal(row.staleness_ms, 1900);
});

test("a wider budget rescues the expired sample", () => {
  assert.equal(sample(null, null, 2000).filter((row) => row.status === "stale").length, 0);
});

test("a zero budget admits only exact hits", () => {
  assert.equal(sample(null, null, 0).filter((row) => row.status === "carried").length, 0);
});

test("an exact hit reports zero staleness", () => {
  const row = previousTick(
    observations(0),
    [{ grid_time: "2026-01-02T14:30:00.100Z", query_time: "2026-01-02T14:30:00.180Z" }],
    0,
  )[0]!;
  assert.equal(row.status, "exact");
  assert.equal(row.staleness_ms, 0);
  assert.equal(row.value, 100.0);
});

test("staleness is measured from the grid not the query", () => {
  const row = previousTick(
    observations(0),
    [{ grid_time: "2026-01-02T14:30:01.100Z", query_time: "2026-01-02T14:30:09.000Z" }],
    5000,
  )[0]!;
  assert.equal(row.staleness_ms, 1000);
});

for (const bad of [-1, 1.5, "1500", true, null, NaN] as unknown[]) {
  test(`an invalid budget raises (${String(bad)})`, () => {
    assert.throws(
      () => previousTick(observations(), requests(), bad as number),
      /max_staleness_ms/,
    );
  });
}

// --- revisions ---------------------------------------------------------------- //
test("a revision is ignored until it arrives", () => {
  const row = previousTick(
    observations(0, 1),
    [{ grid_time: "2026-01-02T14:30:01.000Z", query_time: "2026-01-02T14:30:01.399Z" }],
    MAX_STALENESS_MS,
  )[0]!;
  assert.equal(row.source_revision, 0);
});

test("a revision wins from its own arrival millisecond", () => {
  const row = previousTick(
    observations(0, 1),
    [{ grid_time: "2026-01-02T14:30:01.000Z", query_time: "2026-01-02T14:30:01.400Z" }],
    MAX_STALENESS_MS,
  )[0]!;
  assert.equal(row.source_revision, 1);
});

test("duplicate revisions are rejected", () => {
  assert.throws(
    () => previousTick(observations(0, 0), requests(), MAX_STALENESS_MS),
    /unique per instrument/,
  );
});

test("a revision arriving before the original is rejected", () => {
  const rows = observations(0, 1);
  rows[1]!.available_time = "2026-01-02T14:30:00.150Z";
  assert.throws(
    () => previousTick(rows, requests(), MAX_STALENESS_MS),
    /higher revisions must have later/,
  );
});

test("a newer event beats an older revision", () => {
  const row = previousTick(
    observations(1, 2),
    [{ grid_time: "2026-01-02T14:30:03.000Z", query_time: "2026-01-02T14:30:03.000Z" }],
    MAX_STALENESS_MS,
  )[0]!;
  assert.equal(row.source_event_time, "2026-01-02T14:30:02.200Z");
});

test("input order does not change the answer", () => {
  const forward = previousTick(observations(), requests(), MAX_STALENESS_MS);
  const backward = previousTick(
    [...observations()].reverse(),
    requests(),
    MAX_STALENESS_MS,
  );
  assert.deepEqual(forward, backward);
});

// --- validation --------------------------------------------------------------- //
for (const [field, value] of [
  ["instrument", ""],
  ["instrument", "   "],
  ["instrument", 7],
  ["revision", -1],
  ["revision", 1.5],
  ["revision", true],
  ["value", "100"],
  ["value", null],
  ["value", NaN],
  ["value", Infinity],
  ["event_time", "2026-01-02T14:30:00"],
  ["event_time", "2026-01-02 14:30:00Z"],
  ["event_time", "not-a-time"],
] as Array<[string, unknown]>) {
  test(`an unusable ${field} raises (${String(value)})`, () => {
    const rows = observations(0) as unknown as Array<Record<string, unknown>>;
    rows[0]![field] = value;
    assert.throws(() =>
      previousTick(rows as unknown as Observation[], requests(0), MAX_STALENESS_MS),
    );
  });
}

for (const bad of ["not-a-row", 7, null, []] as unknown[]) {
  test(`a non-mapping observation raises (${JSON.stringify(bad)})`, () => {
    assert.throws(
      () => previousTick([bad], requests(0), MAX_STALENESS_MS),
      /must be a mapping/,
    );
  });
}

test("input rows are never mutated", () => {
  const rows = observations();
  const before = JSON.stringify(rows);
  previousTick(rows, requests(), MAX_STALENESS_MS);
  assert.equal(JSON.stringify(rows), before);
});

// --- timestamps are strict ----------------------------------------------------- //
test("an impossible calendar date is rejected", () => {
  // Date.parse rolls this to March 2. Both ports here refuse it.
  assert.throws(
    () => parseTimestampUs("2026-02-30T00:00:00.000Z"),
    /not a real calendar time/,
  );
  assert.equal(new Date("2026-02-30T00:00:00.000Z").getUTCMonth(), 2); // proof of the rollover
});

test("a leap day is accepted in a leap year and refused otherwise", () => {
  assert.ok(parseTimestampUs("2024-02-29T00:00:00Z") > 0);
  assert.throws(() => parseTimestampUs("2026-02-29T00:00:00Z"), /not a real calendar time/);
  assert.throws(() => parseTimestampUs("1900-02-29T00:00:00Z"), /not a real calendar time/);
  assert.ok(parseTimestampUs("2000-02-29T00:00:00Z") < 0 === false);
});

for (const timestamp of [
  "2026-01-02T14:30:00+00:00",
  "2026-01-02T14:30:00",
  "2026-01-02T14:30:00.1234567Z",
  "2026-13-02T14:30:00Z",
  "2026-01-02T25:30:00Z",
  "2026-01-00T14:30:00Z",
  "",
  null,
  1767363000000,
] as unknown[]) {
  test(`a malformed timestamp is rejected (${JSON.stringify(timestamp)})`, () => {
    assert.throws(() => parseTimestampUs(timestamp));
  });
}

for (const [timestamp, expected] of [
  ["1970-01-01T00:00:00Z", 0],
  ["1970-01-01T00:00:00.001Z", 1_000],
  ["1970-01-01T00:00:00.000001Z", 1],
  ["2026-01-02T14:30:00.100Z", 1_767_364_200_100_000],
] as Array<[string, number]>) {
  test(`a valid timestamp parses to exact microseconds (${timestamp})`, () => {
    assert.equal(parseTimestampUs(timestamp), expected);
  });
}

test("sub-millisecond precision survives", () => {
  const row = previousTick(
    [
      {
        instrument: "A",
        event_time: "2026-01-02T14:30:00.000500Z",
        available_time: "2026-01-02T14:30:00.000500Z",
        revision: 0,
        value: 1.0,
      },
    ],
    [{ grid_time: "2026-01-02T14:30:00.001500Z", query_time: "2026-01-02T14:30:01.000Z" }],
    1,
  )[0]!;
  assert.equal(row.staleness_ms, 1.0);
});
