/**
 * Sample a two-instrument feed onto a grid, then measure what honesty cost you.
 *
 * Run:  npm run example
 */

import {
  StreamingPreviousTick,
  buildGrid,
  previousTick,
  revisionLookahead,
  stalenessBudgetSweep,
  stalenessProfile,
  type Observation,
} from "../src/index.ts";

const OBSERVATIONS: Observation[] = [
  // Revision 0 of the 14:30:00.100 print, on the wire 80ms later.
  { instrument: "A", event_time: "2026-01-02T14:30:00.100Z",
    available_time: "2026-01-02T14:30:00.180Z", revision: 0, value: 100.0 },
  // The venue corrects it 1.3 SECONDS later. Anyone sampling before then
  // legitimately saw 100.0, and no honest backtest may pretend otherwise.
  { instrument: "A", event_time: "2026-01-02T14:30:00.100Z",
    available_time: "2026-01-02T14:30:01.400Z", revision: 1, value: 99.8 },
  { instrument: "A", event_time: "2026-01-02T14:30:02.200Z",
    available_time: "2026-01-02T14:30:02.260Z", revision: 0, value: 100.4 },
  { instrument: "B", event_time: "2026-01-02T14:30:00.700Z",
    available_time: "2026-01-02T14:30:01.200Z", revision: 0, value: 50.0 },
  { instrument: "B", event_time: "2026-01-02T14:30:01.900Z",
    available_time: "2026-01-02T14:30:01.950Z", revision: 0, value: 50.2 },
];

const MAX_STALENESS_MS = 1500;

const rule = (title: string) => console.log(`\n${title}\n${"-".repeat(title.length)}`);
const clock = (timestamp: string) => timestamp.slice(-13, -1);
const pad = (value: unknown, width: number) => String(value).padStart(width);

// --- 1. the same grid point, asked twice ----------------------------------- //
rule("1. Knowledge time changes the answer");

for (const query of ["2026-01-02T14:30:01.000Z", "2026-01-02T14:30:02.000Z"]) {
  const row = previousTick(
    OBSERVATIONS,
    [{ grid_time: "2026-01-02T14:30:01.000Z", query_time: query }],
    MAX_STALENESS_MS,
  )[0]!;
  console.log(
    `  grid 14:30:01 asked at ${clock(query)}  ->  ` +
      `value=${row.value}  revision=${row.source_revision}`,
  );
}
console.log("  Same grid point, two answers. That is the point-in-time contract, not a bug.");

// --- 2. a full grid -------------------------------------------------------- //
rule("2. A one-second grid with a 100ms query lag");

const grid = buildGrid("2026-01-02T14:30:00.000Z", "2026-01-02T14:30:03.000Z", 1000, 100);
const samples = previousTick(OBSERVATIONS, grid, MAX_STALENESS_MS);
for (const row of samples) {
  const age = row.staleness_ms === null ? "" : `  age=${row.staleness_ms}ms`;
  console.log(
    `  ${row.instrument}  ${clock(row.grid_time)}  ${pad(row.value, 6)}  ${row.status}${age}`,
  );
}

// --- 3. how healthy is that series? ---------------------------------------- //
rule("3. Coverage, honestly counted");

for (const [instrument, stats] of Object.entries(stalenessProfile(samples).instruments)) {
  console.log(
    `  ${instrument}: ${stats.usable}/${stats.total} usable ` +
      `(${Math.round(stats.usable_share * 100)}%), worst carry ${stats.max_staleness_ms}ms`,
  );
}

// --- 4. the number that belongs in a research note ------------------------- //
rule("4. Lookahead a revised-file backtest would have absorbed");

const lookahead = revisionLookahead(OBSERVATIONS, grid, MAX_STALENESS_MS);
const { summary } = lookahead;
console.log(
  `  ${summary.differing}/${summary.total_samples} samples would differ ` +
    `(${Math.round(summary.differing_share * 100)}%), worst gap ` +
    `${summary.max_abs_difference?.toFixed(4)}`,
);
for (const row of lookahead.rows) {
  console.log(
    `    ${row.instrument} ${clock(row.grid_time)}  honest=${row.point_in_time_value}  ` +
      `revised=${row.revised_value}  [${row.kind}]`,
  );
}

// --- 5. pick the budget off a curve, not out of the air -------------------- //
rule("5. Staleness budget sweep");

for (const point of stalenessBudgetSweep(OBSERVATIONS, grid, [0, 500, 1000, 2000, 5000])) {
  const gained = point.gained_vs_previous === null ? "" : `  (+${point.gained_vs_previous})`;
  console.log(
    `  ${pad(point.max_staleness_ms, 5)}ms  ->  ${point.usable}/${point.total} usable${gained}`,
  );
}

// --- 6. the same thing, live ----------------------------------------------- //
rule("6. The streaming engine agrees with the batch function");

const engine = new StreamingPreviousTick(MAX_STALENESS_MS);
engine.observeMany(
  [...OBSERVATIONS].sort((a, b) => (a.available_time < b.available_time ? -1 : 1)),
);
const live = grid.flatMap((request) => engine.sample(request.grid_time, request.query_time));
const key = (rows: typeof samples) =>
  JSON.stringify([...rows].sort((a, b) => (`${a.instrument}${a.grid_time}` < `${b.instrument}${b.grid_time}` ? -1 : 1)));
console.log(`  identical to the batch result: ${key(live) === key(samples)}`);

const last = grid.at(-1)!;
const resumed = StreamingPreviousTick.restore(JSON.parse(JSON.stringify(engine.checkpoint())));
console.log(
  "  survives a checkpoint round-trip:  " +
    `${JSON.stringify(resumed.sample(last.grid_time, last.query_time)) === JSON.stringify(engine.sample(last.grid_time, last.query_time))}`,
);
