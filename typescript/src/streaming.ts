/**
 * A live as-of engine: ingest observations as they arrive, answer grid queries.
 *
 * `previousTick` needs the whole history in hand. That is right for a backtest and
 * wrong for a running system, where observations arrive one at a time and the grid is
 * sampled as the clock passes each point.
 *
 * This engine holds the same contract with two additions that only matter live:
 *
 * **Arrival order is enforced.** Observations must be fed in non-decreasing
 * `available_time` order, because that is the order a real feed delivers them. An
 * out-of-order feed is a genuine fault — accepting it silently would let the engine
 * answer a query with a value it should not yet have had.
 *
 * **Memory is bounded.** A process that runs for months cannot keep every tick.
 * `retentionMs` drops observations older than the retention window measured back from
 * the newest event seen. This is a real trade, stated plainly: a dropped observation
 * can turn a sample that would have been `carried` into `no_history`. Leave
 * `retentionMs` undefined and the engine keeps everything, in which case it returns
 * *exactly* what the batch function returns for the same data — which is what the
 * test suite asserts.
 *
 * `checkpoint()` and `restore()` round-trip the engine through plain JSON so a restart
 * resumes mid-session instead of replaying from the open.
 */

import {
  type ParsedObservation,
  type Sample,
  emptySample,
  buildSample,
  parseObservation,
  parseTimestampUs,
  requireNonNegativeInteger,
} from "./core.ts";

export interface StreamingCheckpoint {
  max_staleness_ms: number;
  retention_ms: number | null;
  dropped: number;
  observations: Array<{
    instrument: string;
    event_time: string;
    available_time: string;
    revision: number;
    value: number;
  }>;
}

/** Incremental previous-tick sampling with bounded memory. */
export class StreamingPreviousTick {
  readonly #maxStalenessUs: number;
  readonly #maxStalenessMs: number;
  readonly #retentionMs: number | null;
  readonly #rows = new Map<string, ParsedObservation[]>();
  readonly #seen = new Set<string>();
  #lastAvailableUs: number | null = null;
  #newestEventUs: number | null = null;
  #dropped = 0;

  /**
   * @param maxStalenessMs Same meaning as in the batch function — the age past which
   *   a carried value is reported unusable.
   * @param retentionMs How far back to keep observations, measured from the newest
   *   event seen. Omit to keep everything.
   */
  constructor(maxStalenessMs: number, retentionMs: number | null = null) {
    requireNonNegativeInteger(maxStalenessMs, "max_staleness_ms");
    if (retentionMs !== null && retentionMs !== undefined) {
      requireNonNegativeInteger(retentionMs, "retention_ms");
    }
    this.#maxStalenessMs = maxStalenessMs;
    this.#maxStalenessUs = maxStalenessMs * 1000;
    this.#retentionMs = retentionMs ?? null;
  }

  // --- ingestion ---------------------------------------------------------- //
  /** Ingest one observation. Must not arrive before the previous one. */
  observe(observation: unknown): void {
    const parsed = parseObservation(observation);

    if (this.#lastAvailableUs !== null && parsed.availableUs < this.#lastAvailableUs) {
      throw new Error(
        "observations must arrive in non-decreasing available_time order",
      );
    }
    const key = `${parsed.instrument} ${parsed.eventUs} ${parsed.revision}`;
    if (this.#seen.has(key)) {
      throw new Error("revisions must be unique per instrument and event_time");
    }

    const rows = this.#rows.get(parsed.instrument) ?? [];
    for (const existing of rows) {
      if (existing.eventUs !== parsed.eventUs) continue;
      const [earlier, later] =
        existing.revision < parsed.revision ? [existing, parsed] : [parsed, existing];
      if (earlier.availableUs >= later.availableUs) {
        throw new Error("higher revisions must have later available_time values");
      }
    }

    this.#seen.add(key);
    this.#lastAvailableUs = parsed.availableUs;
    this.#newestEventUs =
      this.#newestEventUs === null
        ? parsed.eventUs
        : Math.max(this.#newestEventUs, parsed.eventUs);

    rows.push(parsed);
    // Keep the newest-first ordering the lookup depends on.
    rows.sort((a, b) => b.eventUs - a.eventUs || b.revision - a.revision);
    this.#rows.set(parsed.instrument, rows);
    this.#evict();
  }

  observeMany(observations: Iterable<unknown>): void {
    for (const observation of observations) this.observe(observation);
  }

  #evict(): void {
    if (this.#retentionMs === null || this.#newestEventUs === null) return;
    const horizon = this.#newestEventUs - this.#retentionMs * 1000;
    for (const [instrument, rows] of this.#rows) {
      const kept = rows.filter((row) => row.eventUs >= horizon);
      this.#dropped += rows.length - kept.length;
      this.#rows.set(instrument, kept);
    }
  }

  // --- querying ----------------------------------------------------------- //
  /** Sample one instrument at one grid point, as known at `queryTime`. */
  sampleInstrument(instrument: string, gridTime: string, queryTime: string): Sample {
    const gridUs = parseTimestampUs(gridTime, "grid_time");
    const queryUs = parseTimestampUs(queryTime, "query_time");
    if (queryUs < gridUs) throw new Error("query_time must not precede grid_time");

    const rows = this.#rows.get(instrument) ?? [];
    let sawEventEligible = false;
    for (const row of rows) {
      if (row.eventUs > gridUs) continue;
      sawEventEligible = true;
      if (row.availableUs <= queryUs) {
        return buildSample(
          instrument,
          gridTime,
          queryTime,
          row,
          gridUs,
          this.#maxStalenessUs,
        );
      }
    }
    return emptySample(
      instrument,
      gridTime,
      queryTime,
      sawEventEligible ? "not_yet_available" : "no_history",
    );
  }

  /** Sample every instrument seen so far, in sorted order. */
  sample(gridTime: string, queryTime: string): Sample[] {
    return [...this.#rows.keys()]
      .sort()
      .map((instrument) => this.sampleInstrument(instrument, gridTime, queryTime));
  }

  // --- introspection ------------------------------------------------------ //
  get instruments(): string[] {
    return [...this.#rows.keys()].sort();
  }

  /** How many observations are currently held. */
  get retained(): number {
    let total = 0;
    for (const rows of this.#rows.values()) total += rows.length;
    return total;
  }

  /**
   * How many observations retention has discarded. Non-zero means samples may report
   * `no_history` where the batch function would carry a value.
   */
  get dropped(): number {
    return this.#dropped;
  }

  // --- persistence -------------------------------------------------------- //
  /** Serialise the engine to plain JSON-safe data. */
  checkpoint(): StreamingCheckpoint {
    // Serialised in ARRIVAL order, globally across instruments — not grouped by
    // instrument. restore() replays through observe(), which enforces non-decreasing
    // available_time, so a per-instrument grouping would make an engine's own
    // checkpoint unrestorable the moment it held two symbols.
    const all: ParsedObservation[] = [];
    for (const rows of this.#rows.values()) all.push(...rows);
    all.sort(
      (a, b) =>
        a.availableUs - b.availableUs ||
        a.eventUs - b.eventUs ||
        a.revision - b.revision ||
        (a.instrument < b.instrument ? -1 : a.instrument > b.instrument ? 1 : 0),
    );

    return {
      max_staleness_ms: this.#maxStalenessMs,
      retention_ms: this.#retentionMs,
      dropped: this.#dropped,
      observations: all.map((row) => ({
        instrument: row.instrument,
        event_time: row.event_time,
        available_time: row.available_time,
        revision: row.revision,
        value: row.value,
      })),
    };
  }

  /** Rebuild an engine from `checkpoint()` output. */
  static restore(state: unknown): StreamingPreviousTick {
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("state must be a mapping from checkpoint()");
    }
    const record = state as Record<string, unknown>;
    for (const field of ["max_staleness_ms", "observations"]) {
      if (!(field in record)) throw new Error(`state is missing ${field}`);
    }

    const engine = new StreamingPreviousTick(
      record.max_staleness_ms as number,
      (record.retention_ms as number | null) ?? null,
    );
    engine.observeMany(record.observations as Iterable<unknown>);
    engine.#dropped = Number(record.dropped ?? 0);
    return engine;
  }
}
