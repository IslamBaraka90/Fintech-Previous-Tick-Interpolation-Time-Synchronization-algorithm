/** Tests for the grid builder, the health profile, the lookahead measure and the sweep. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { previousTick } from "../src/core.ts";
import {
  buildGrid,
  revisionLookahead,
  stalenessBudgetSweep,
  stalenessProfile,
} from "../src/staleness.ts";
import { MAX_STALENESS_MS, observations, requests, sample } from "./fixtures.ts";

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

// --- buildGrid ----------------------------------------------------------------- //
test("a grid spans its endpoints inclusively", () => {
  const grid = buildGrid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 1000);
  assert.equal(grid.length, 4);
  assert.equal(grid[0]!.grid_time, "2026-01-02T14:30:00.000Z");
  assert.equal(grid.at(-1)!.grid_time, "2026-01-02T14:30:03.000Z");
});

test("a grid without lag queries at the grid point", () => {
  for (const row of buildGrid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:02.000Z", 1000)) {
    assert.equal(row.grid_time, row.query_time);
  }
});

test("a lag pushes the query later", () => {
  const row = buildGrid(
    "2026-01-02T14:30:00.000Z",
    "2026-01-02T14:30:00.000Z",
    1000,
    250,
  )[0]!;
  assert.equal(row.grid_time, "2026-01-02T14:30:00.000Z");
  assert.equal(row.query_time, "2026-01-02T14:30:00.250Z");
});

test("an end off the step stops before it", () => {
  const grid = buildGrid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:02.500Z", 1000);
  assert.equal(grid.at(-1)!.grid_time, "2026-01-02T14:30:02.000Z");
});

test("a single-point grid is allowed", () => {
  assert.equal(
    buildGrid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:00.000Z", 1000).length,
    1,
  );
});

test("a generated grid feeds straight into the sampler", () => {
  const grid = buildGrid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 1000, 100);
  assert.equal(previousTick(observations(), grid, MAX_STALENESS_MS).length, 2 * grid.length);
});

test("sub-millisecond grid points render correctly", () => {
  const grid = buildGrid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:00.002Z", 1);
  assert.deepEqual(
    grid.map((row) => row.grid_time),
    [
      "2026-01-02T14:30:00.000Z",
      "2026-01-02T14:30:00.001Z",
      "2026-01-02T14:30:00.002Z",
    ],
  );
});

for (const args of [
  ["2026-01-02T14:30:03.000Z", "2026-01-02T14:30:00.000Z", 1000],
  ["2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 0],
  ["2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", -1],
  ["not-a-time", "2026-01-02T14:30:03.000Z", 1000],
] as Array<[string, string, number]>) {
  test(`a bad grid request raises (${args[2]})`, () => {
    assert.throws(() => buildGrid(...args));
  });
}

test("a negative lag raises", () => {
  assert.throws(
    () => buildGrid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 1000, -1),
    /lag_ms/,
  );
});

// --- stalenessProfile ----------------------------------------------------------- //
test("the profile covers every instrument", () => {
  assert.deepEqual(Object.keys(stalenessProfile(sample()).instruments).sort(), ["A", "B"]);
});

test("the profile totals agree with the samples", () => {
  const rows = sample();
  const profile = stalenessProfile(rows);
  assert.equal(profile.overall.total, rows.length);
  assert.equal(
    Object.values(profile.instruments).reduce((sum, item) => sum + item.total, 0),
    rows.length,
  );
});

test("usable excludes stale and missing", () => {
  // 10 grid points: 6 carried, 1 stale, 2 no_history, 1 not_yet_available.
  const profile = stalenessProfile(sample()).overall;
  assert.equal(profile.usable, 6);
  assert.equal(profile.counts.stale, 1);
  assert.equal(profile.counts.no_history, 2);
  assert.equal(profile.counts.not_yet_available, 1);
});

test("the usable share is over all grid points", () => {
  assert.ok(close(stalenessProfile(sample()).overall.usable_share, 6 / 10));
});

test("the worst carry is reported", () => {
  assert.equal(stalenessProfile(sample()).instruments.B!.max_staleness_ms, 1100);
});

test("ages come from usable samples only", () => {
  // The expired 1900ms carry must not appear in the age statistics.
  assert.equal(stalenessProfile(sample()).instruments.A!.max_staleness_ms, 900);
});

test("an empty series profiles to zero", () => {
  const profile = stalenessProfile([]).overall;
  assert.equal(profile.total, 0);
  assert.equal(profile.usable_share, 0);
  assert.equal(profile.max_staleness_ms, null);
});

test("the profile rejects foreign rows", () => {
  assert.throws(() => stalenessProfile([{ nope: 1 }]), /previousTick/);
});

// --- revisionLookahead ----------------------------------------------------------- //
test("the lookahead finds the revision a naive backtest would steal", () => {
  const result = revisionLookahead(observations(), requests(), MAX_STALENESS_MS);
  assert.ok(result.summary.differing > 0);
  const kinds = new Set(result.rows.map((row) => row.kind));
  assert.ok(kinds.has("revision_differs") || kinds.has("invented_value"));
});

test("the lookahead names the exact row", () => {
  // Grid 14:30:01 asked at 14:30:01 truthfully returns rev 0; the revised file would
  // have handed over rev 1, which had not arrived yet.
  const result = revisionLookahead(observations(), requests(), MAX_STALENESS_MS);
  const row = result.rows.find(
    (item) =>
      item.instrument === "A" &&
      item.grid_time === "2026-01-02T14:30:01.000Z" &&
      item.query_time === "2026-01-02T14:30:01.000Z",
  )!;
  assert.equal(row.point_in_time_value, 100.0);
  assert.equal(row.point_in_time_revision, 0);
  assert.equal(row.revised_value, 99.8);
  assert.equal(row.revised_revision, 1);
  assert.ok(close(row.difference as number, -0.2));
});

test("a value conjured from nothing is called out", () => {
  // Instrument B at 14:30:01 truthfully has nothing; the revised view has 50.0.
  const result = revisionLookahead(observations(), requests(), MAX_STALENESS_MS);
  const row = result.rows.find(
    (item) => item.instrument === "B" && item.point_in_time_status === "not_yet_available",
  )!;
  assert.equal(row.kind, "invented_value");
  assert.equal(row.revised_value, 50.0);
  assert.equal(row.difference, null);
});

test("the magnitude is reported", () => {
  const result = revisionLookahead(observations(), requests(), MAX_STALENESS_MS);
  assert.ok(close(result.summary.max_abs_difference as number, 0.2));
});

test("the share is over every sample", () => {
  const result = revisionLookahead(observations(), requests(), MAX_STALENESS_MS);
  assert.equal(result.summary.total_samples, sample().length);
  assert.ok(
    close(
      result.summary.differing_share,
      result.summary.differing / result.summary.total_samples,
    ),
  );
});

test("a feed with no revisions and no delay has no lookahead", () => {
  const clean = [
    {
      instrument: "A",
      event_time: "2026-01-02T14:30:00.000Z",
      available_time: "2026-01-02T14:30:00.000Z",
      revision: 0,
      value: 10.0,
    },
  ];
  const result = revisionLookahead(
    clean,
    [{ grid_time: "2026-01-02T14:30:01.000Z", query_time: "2026-01-02T14:30:01.000Z" }],
    5000,
  );
  assert.deepEqual(result.rows, []);
  assert.equal(result.summary.differing, 0);
  assert.equal(result.summary.max_abs_difference, null);
});

test("the honest view never beats the revised one on coverage", () => {
  // Point-in-time can only ever know less than the revised file, never more.
  const honest = stalenessProfile(sample()).overall.usable;
  const revised = revisionLookahead(observations(), requests(), MAX_STALENESS_MS);
  const invented = revised.rows.filter((row) => row.kind === "invented_value");
  assert.ok(honest + invented.length <= sample().length);
});

// --- stalenessBudgetSweep --------------------------------------------------------- //
test("the sweep returns one point per candidate", () => {
  const sweep = stalenessBudgetSweep(observations(), requests(), [0, 500, 1500, 5000]);
  assert.deepEqual(
    sweep.map((point) => point.max_staleness_ms),
    [0, 500, 1500, 5000],
  );
});

test("a wider budget never makes fewer samples usable", () => {
  const usable = stalenessBudgetSweep(
    observations(),
    requests(),
    [0, 250, 500, 1000, 2000, 10_000],
  ).map((point) => point.usable);
  assert.deepEqual(usable, [...usable].sort((a, b) => a - b));
});

test("the sweep marks the cliff", () => {
  const sweep = stalenessBudgetSweep(observations(), requests(), [0, 2000]);
  assert.equal(sweep[0]!.gained_vs_previous, null);
  assert.equal(sweep[1]!.gained_vs_previous, sweep[1]!.usable - sweep[0]!.usable);
});

test("a budget wide enough leaves nothing stale", () => {
  assert.equal(stalenessBudgetSweep(observations(), requests(), [1_000_000])[0]!.stale, 0);
});

test("the sweep agrees with a direct sample", () => {
  const sweep = stalenessBudgetSweep(observations(), requests(), [MAX_STALENESS_MS]);
  const direct = stalenessProfile(sample()).overall;
  assert.equal(sweep[0]!.usable, direct.usable);
  assert.equal(sweep[0]!.total, direct.total);
});

test("an empty candidate list raises", () => {
  assert.throws(
    () => stalenessBudgetSweep(observations(), requests(), []),
    /candidates must not be empty/,
  );
});

for (const bad of [-1, 1.5, "500"] as unknown[]) {
  test(`a bad candidate raises (${String(bad)})`, () => {
    assert.throws(() =>
      stalenessBudgetSweep(observations(), requests(), [bad as number]),
    );
  });
}
