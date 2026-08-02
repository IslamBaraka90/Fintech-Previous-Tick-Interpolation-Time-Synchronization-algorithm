/** Shared fixture access. The same JSON backs the Python suite. */

import { createRequire } from "node:module";

import { previousTick, type GridRequest, type Observation, type Sample } from "../src/core.ts";

const require = createRequire(import.meta.url);
const FIXTURE = require("./fixtures/fixtures.json") as {
  max_staleness_ms: number;
  observations: Observation[];
  requests: GridRequest[];
  expected: Sample[];
};

export const MAX_STALENESS_MS = FIXTURE.max_staleness_ms;
export const OBSERVATIONS = FIXTURE.observations;
export const REQUESTS = FIXTURE.requests;
export const EXPECTED = FIXTURE.expected;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Deep-copied fixture observations — all, or the given 0-based positions. */
export const observations = (...indexes: number[]): Observation[] =>
  indexes.length === 0
    ? clone(OBSERVATIONS)
    : indexes.map((index) => clone(OBSERVATIONS[index]!));

/** Deep-copied fixture requests — all, or the given 0-based positions. */
export const requests = (...indexes: number[]): GridRequest[] =>
  indexes.length === 0
    ? clone(REQUESTS)
    : indexes.map((index) => clone(REQUESTS[index]!));

export const sample = (
  rows?: unknown[] | null,
  reqs?: unknown[] | null,
  maxStalenessMs?: number,
): Sample[] =>
  previousTick(
    rows ?? observations(),
    reqs ?? requests(),
    maxStalenessMs ?? MAX_STALENESS_MS,
  );
