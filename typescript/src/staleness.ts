/**
 * Choosing the staleness budget, and measuring what the two clocks bought you.
 *
 * The batch sampler answers *what was the value*. This module answers the three
 * questions you actually have to settle before trusting a sampled series.
 *
 * **How much lookahead was I about to buy?** — {@link revisionLookahead}
 * This is the headline. It samples the same grid twice: once honestly, and once the
 * way a naive pipeline does it by reading a revised historical file and ignoring
 * `available_time` entirely. The rows that differ are precisely the rows where a
 * backtest would have used a number nobody had yet. The result is a count and a
 * magnitude rather than an argument — you can put it in a research note.
 *
 * **What budget should `maxStalenessMs` be?** — {@link stalenessBudgetSweep}
 * The budget is usually picked by feel, which means it is picked to make the output
 * look good. The sweep re-samples across candidate budgets and reports how the
 * usable/stale split moves, so the number comes off a curve instead of out of the
 * air. A budget sitting on a cliff edge is one that will behave differently next week.
 *
 * **How healthy is the series I just produced?** — {@link stalenessProfile}
 * Per-instrument status counts, the share of grid points that were actually usable,
 * and the worst carry. An instrument that is 90% `carried` at 40 seconds of age is not
 * really being sampled; it is being invented, and the profile says so.
 *
 * {@link buildGrid} is the small practical helper that generates the request list,
 * including the `lagMs` that models how late your system asks the question.
 */

import {
  type GridRequest,
  type Sample,
  formatTimestampUs,
  lookup,
  parseObservations,
  parseRequests,
  parseTimestampUs,
  previousTick,
  requireNonNegativeInteger,
} from "./core.ts";

/** Stands in for "every revision has arrived", i.e. the revised-file view. */
const ALL_AVAILABLE_US = Number.MAX_SAFE_INTEGER;

const USABLE = ["exact", "carried"] as const;

export interface ProfileStats {
  total: number;
  counts: Record<string, number>;
  usable: number;
  usable_share: number;
  max_staleness_ms: number | null;
  median_staleness_ms: number | null;
}

export interface StalenessProfile {
  instruments: Record<string, ProfileStats>;
  overall: ProfileStats;
}

export type LookaheadKind = "invented_value" | "revision_differs" | "value_differs";

export interface LookaheadRow {
  instrument: string;
  grid_time: string;
  query_time: string;
  point_in_time_value: number | null;
  point_in_time_revision: number | null;
  point_in_time_status: string;
  revised_value: number | null;
  revised_revision: number | null;
  revised_status: string;
  difference: number | null;
  kind: LookaheadKind;
}

export interface LookaheadResult {
  summary: {
    total_samples: number;
    differing: number;
    differing_share: number;
    max_abs_difference: number | null;
  };
  rows: LookaheadRow[];
}

export interface SweepPoint {
  max_staleness_ms: number;
  total: number;
  usable: number;
  usable_share: number;
  stale: number;
  gained_vs_previous: number | null;
}

/**
 * Generate evenly spaced grid requests from `start` to `end` inclusive.
 *
 * `lagMs` is the honest part. Your system does not ask about 09:30:00 at exactly
 * 09:30:00 — it asks a moment later, once the bar has closed and the message has
 * landed. Setting a lag models that, and setting it to zero asserts the stronger
 * claim that you query with no delay at all.
 */
export function buildGrid(
  start: string,
  end: string,
  stepMs: number,
  lagMs = 0,
): GridRequest[] {
  const startUs = parseTimestampUs(start, "start");
  const endUs = parseTimestampUs(end, "end");
  requireNonNegativeInteger(stepMs, "step_ms");
  requireNonNegativeInteger(lagMs, "lag_ms");
  if (stepMs === 0) throw new Error("step_ms must be positive");
  if (endUs < startUs) throw new Error("end must not precede start");

  const stepUs = stepMs * 1000;
  const lagUs = lagMs * 1000;
  const grid: GridRequest[] = [];
  for (let moment = startUs; moment <= endUs; moment += stepUs) {
    grid.push({
      grid_time: formatTimestampUs(moment),
      query_time: formatTimestampUs(moment + lagUs),
    });
  }
  return grid;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

function profileOne(rows: ReadonlyArray<Record<string, unknown>>): ProfileStats {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const status = String(row.status);
    counts[status] = (counts[status] ?? 0) + 1;
  }

  const ages = rows
    .filter(
      (row) =>
        row.staleness_ms !== null &&
        row.staleness_ms !== undefined &&
        (USABLE as readonly string[]).includes(String(row.status)),
    )
    .map((row) => Number(row.staleness_ms));
  const usable = USABLE.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

  return {
    total: rows.length,
    counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))),
    usable,
    usable_share: rows.length ? usable / rows.length : 0,
    max_staleness_ms: ages.length ? Math.max(...ages) : null,
    median_staleness_ms: ages.length ? median(ages) : null,
  };
}

/**
 * Summarise a sampled series per instrument, plus an `overall` roll-up.
 *
 * `usable_share` counts only `exact` and `carried` samples. A `stale` or missing
 * sample is not a value you may use, and folding it into a coverage number would
 * report the opposite of what happened.
 */
export function stalenessProfile(samples: Iterable<unknown>): StalenessProfile {
  const rows = [...samples] as Array<Record<string, unknown>>;
  rows.forEach((row, index) => {
    if (
      row === null ||
      typeof row !== "object" ||
      !("status" in row) ||
      !("instrument" in row)
    ) {
      throw new Error(`samples[${index}] must come from previousTick()`);
    }
  });

  const byInstrument = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const instrument = String(row.instrument);
    const group = byInstrument.get(instrument);
    if (group) group.push(row);
    else byInstrument.set(instrument, [row]);
  }

  const instruments: Record<string, ProfileStats> = {};
  for (const instrument of [...byInstrument.keys()].sort()) {
    instruments[instrument] = profileOne(byInstrument.get(instrument)!);
  }

  return { instruments, overall: profileOne(rows) };
}

function lookaheadKind(
  sample: Sample,
  revised: { value: number | null; revision: number | null },
): LookaheadKind {
  if (sample.value === null && revised.value !== null) {
    // The honest view had nothing; the revised file supplied a number. This is the
    // dangerous shape — the backtest gains a data point out of nowhere.
    return "invented_value";
  }
  if (sample.source_revision !== revised.revision) return "revision_differs";
  return "value_differs";
}

/**
 * Measure the lookahead a revised-file backtest would have absorbed.
 *
 * Two samplings of the same grid: **point-in-time** (honest, respecting
 * `available_time`) and **revised** (what a corrected historical file gives you, where
 * every revision looks like it was always there). Every row where the two disagree is
 * a row a naive backtest would have gotten from information that did not exist yet.
 *
 * An empty `rows` means the revised file and the live feed would have agreed
 * everywhere — worth knowing, and not something to assume.
 */
export function revisionLookahead(
  observations: Iterable<unknown>,
  requests: Iterable<unknown>,
  maxStalenessMs: number,
): LookaheadResult {
  requireNonNegativeInteger(maxStalenessMs, "max_staleness_ms");
  const maxStalenessUs = maxStalenessMs * 1000;

  const observationList = [...observations];
  const requestList = [...requests];

  const honest = previousTick(observationList, requestList, maxStalenessMs);
  const parsedRequests = parseRequests(requestList);
  const byInstrument = parseObservations(observationList);

  const revisedByKey = new Map<
    string,
    { value: number | null; revision: number | null; status: string }
  >();
  for (const instrument of [...byInstrument.keys()].sort()) {
    const rows = byInstrument.get(instrument)!;
    for (const request of parsedRequests) {
      const key = `${instrument} ${request.grid_time} ${request.query_time}`;
      const { chosen, sawEventEligible } = lookup(
        rows,
        request.gridUs,
        ALL_AVAILABLE_US,
      );
      if (chosen === null) {
        revisedByKey.set(key, {
          value: null,
          revision: null,
          status: sawEventEligible ? "not_yet_available" : "no_history",
        });
        continue;
      }
      const stalenessUs = request.gridUs - chosen.eventUs;
      const stale = stalenessUs > maxStalenessUs;
      revisedByKey.set(key, {
        value: stale ? null : chosen.value,
        revision: chosen.revision,
        status: stale ? "stale" : stalenessUs === 0 ? "exact" : "carried",
      });
    }
  }

  const differing: LookaheadRow[] = [];
  let maxGap = 0;
  for (const sample of honest) {
    const key = `${sample.instrument} ${sample.grid_time} ${sample.query_time}`;
    const revised = revisedByKey.get(key)!;
    if (
      sample.value === revised.value &&
      sample.source_revision === revised.revision
    ) {
      continue;
    }

    const difference =
      sample.value !== null && revised.value !== null
        ? revised.value - sample.value
        : null;
    if (difference !== null) maxGap = Math.max(maxGap, Math.abs(difference));

    differing.push({
      instrument: sample.instrument,
      grid_time: sample.grid_time,
      query_time: sample.query_time,
      point_in_time_value: sample.value,
      point_in_time_revision: sample.source_revision,
      point_in_time_status: sample.status,
      revised_value: revised.value,
      revised_revision: revised.revision,
      revised_status: revised.status,
      difference,
      kind: lookaheadKind(sample, revised),
    });
  }

  return {
    summary: {
      total_samples: honest.length,
      differing: differing.length,
      differing_share: honest.length ? differing.length / honest.length : 0,
      max_abs_difference: differing.length ? maxGap : null,
    },
    rows: differing,
  };
}

/**
 * Re-sample across candidate `maxStalenessMs` values and report the split.
 *
 * Read the resulting curve for a flat stretch and pick from the middle of it. A budget
 * chosen on a steep segment is one where a small change in feed latency moves a lot of
 * samples between usable and unusable, which is how a series that backtested cleanly
 * starts behaving differently in production.
 */
export function stalenessBudgetSweep(
  observations: Iterable<unknown>,
  requests: Iterable<unknown>,
  candidates: Iterable<number>,
): SweepPoint[] {
  const candidateList = [...candidates];
  if (candidateList.length === 0) throw new Error("candidates must not be empty");

  const observationList = [...observations];
  const requestList = [...requests];

  const sweep: SweepPoint[] = [];
  let previousUsable: number | null = null;
  for (const candidate of candidateList) {
    requireNonNegativeInteger(candidate, "candidate");
    const samples: Sample[] = previousTick(observationList, requestList, candidate);
    const profile = stalenessProfile(samples).overall;
    sweep.push({
      max_staleness_ms: candidate,
      total: profile.total,
      usable: profile.usable,
      usable_share: profile.usable_share,
      stale: profile.counts.stale ?? 0,
      // How many samples this candidate rescued relative to the previous one. A large
      // jump marks a cliff you should not be standing on.
      gained_vs_previous: previousUsable === null ? null : profile.usable - previousUsable,
    });
    previousUsable = profile.usable;
  }
  return sweep;
}
