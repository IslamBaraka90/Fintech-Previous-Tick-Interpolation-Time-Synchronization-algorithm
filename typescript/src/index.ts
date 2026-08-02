/**
 * Point-in-time-safe previous-tick interpolation.
 *
 * The one interpolation method that is safe to run on live data, because it only ever
 * carries a value *forward* — it never reaches for a number that had not yet arrived.
 *
 * ```ts
 * import { previousTick } from "fintech-previous-tick";
 *
 * const samples = previousTick(observations, requests, 1500);
 * ```
 *
 * Article: https://thefintechbuilder.com/market-data-engineering/time-synchronization/previous-tick-interpolation/
 */

export {
  type GridRequest,
  type Observation,
  type Sample,
  type SampleStatus,
  formatTimestampUs,
  parseTimestampUs,
  previousTick,
} from "./core.ts";

export {
  type StreamingCheckpoint,
  StreamingPreviousTick,
} from "./streaming.ts";

export {
  type LookaheadKind,
  type LookaheadResult,
  type LookaheadRow,
  type ProfileStats,
  type StalenessProfile,
  type SweepPoint,
  buildGrid,
  revisionLookahead,
  stalenessBudgetSweep,
  stalenessProfile,
} from "./staleness.ts";
