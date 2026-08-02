/**
 * Point-in-time-safe previous-tick sampling.
 *
 * The rule this module enforces is one sentence long: **a sample may only use a value
 * that had already arrived at the moment the sample was taken.** Everything else here
 * exists to make that rule impossible to break by accident.
 *
 * ## Two clocks, never one
 *
 * Every observation carries an `event_time` (when the thing happened in the market)
 * and an `available_time` (when your system could first have known it). A request
 * carries a `grid_time` (the point being sampled) and a `query_time` (the moment the
 * question is being asked). A value is eligible only if `event_time <= grid_time`
 * **and** `available_time <= query_time`.
 *
 * Collapsing those two clocks into one is the single most common way a backtest is
 * quietly ruined: the value is real, the timestamp is real, and it still could not
 * have been known when the strategy claims to have used it. Because both clocks are
 * required arguments here, that mistake cannot be made silently.
 *
 * ## Revisions supersede, but only from their own arrival
 *
 * Feeds correct themselves. A revision of an event does not retroactively replace the
 * original — it becomes the answer only for queries asked after the correction landed.
 * The same `grid_time`, asked at two different `query_time` values, is *supposed* to
 * return two different numbers. That is the point-in-time contract working, not a bug.
 *
 * ## Staleness is expiry, not decoration
 *
 * A carried-forward value is an assumption that nothing happened since. Past some age
 * that assumption stops being reasonable, and this module refuses to pretend
 * otherwise: beyond `maxStalenessMs` the value comes back `null` with status `stale`,
 * lineage intact. A null you can explain is worth more than a number you cannot.
 *
 * ## Timestamps are strict on purpose
 *
 * Only RFC 3339 UTC strings ending in `Z` are accepted, and the calendar date is
 * validated by explicit civil arithmetic rather than `Date.parse`. `Date.parse`
 * silently rolls `2026-02-30` over to March 2 where Python's date parsing rejects it;
 * this port rejects it too, so the same input gives the same answer in either
 * language.
 */

export interface Observation {
  instrument: string;
  event_time: string;
  available_time: string;
  revision: number;
  value: number;
}

export interface GridRequest {
  grid_time: string;
  query_time: string;
}

export type SampleStatus =
  | "no_history"
  | "not_yet_available"
  | "stale"
  | "exact"
  | "carried";

export interface Sample {
  instrument: string;
  grid_time: string;
  query_time: string;
  value: number | null;
  source_event_time: string | null;
  source_available_time: string | null;
  source_revision: number | null;
  staleness_ms: number | null;
  status: SampleStatus;
}

/** RFC 3339 UTC, `Z` only, with up to microsecond precision. */
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?Z$/;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const daysInMonth = (year: number, month: number): number =>
  month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1]!;

/**
 * Days since 1970-01-01 for a proleptic-Gregorian date, by integer arithmetic.
 *
 * Deliberately not `Date.UTC`: that helper maps two-digit years into the 1900s and
 * accepts out-of-range days by rolling them over, both of which would let this port
 * disagree with the Python one.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/**
 * Parse an RFC 3339 UTC timestamp to integer microseconds since the epoch.
 *
 * Strict by design. `2026-02-30T00:00:00Z` is rejected rather than rolled over, which
 * is what keeps this port and the Python one agreeing on the same input.
 */
export function parseTimestampUs(timestamp: unknown, field = "timestamp"): number {
  if (typeof timestamp !== "string") {
    throw new Error(`${field} must be an RFC 3339 UTC string ending in Z`);
  }
  const match = TIMESTAMP.exec(timestamp);
  if (match === null) {
    throw new Error(
      `${field} must be an RFC 3339 UTC string ending in Z ` +
        `(up to microsecond precision), got: ${JSON.stringify(timestamp)}`,
    );
  }

  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map((part) => Number(part)) as [number, number, number, number, number, number];
  const fraction = match[7] ?? "";
  const microsecond = fraction === "" ? 0 : Number(fraction.padEnd(6, "0"));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new Error(
      `${field} is not a real calendar time: ${JSON.stringify(timestamp)}`,
    );
  }

  const days = daysFromCivil(year, month, day);
  return (
    days * 86_400_000_000 +
    (hour * 3600 + minute * 60 + second) * 1_000_000 +
    microsecond
  );
}

/** Render integer microseconds back to the RFC 3339 form this package accepts. */
export function formatTimestampUs(microseconds: number): string {
  const wholeMs = Math.floor(microseconds / 1000);
  const remainder = microseconds - wholeMs * 1000;
  const iso = new Date(wholeMs).toISOString();
  if (remainder === 0) return iso;
  return `${iso.slice(0, -1)}${String(remainder).padStart(3, "0")}Z`;
}

export function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function requireFinite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

/** One validated observation, keyed in integer microseconds. */
export interface ParsedObservation {
  instrument: string;
  event_time: string;
  available_time: string;
  eventUs: number;
  availableUs: number;
  revision: number;
  value: number;
}

export function parseObservation(row: unknown): ParsedObservation {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    throw new Error("each observation must be a mapping");
  }
  const record = row as Record<string, unknown>;

  const instrument = record.instrument;
  if (typeof instrument !== "string" || instrument.trim() === "") {
    throw new Error("instrument must be a non-empty string");
  }
  const eventTime = record.event_time as string;
  const availableTime = record.available_time as string;
  const eventUs = parseTimestampUs(eventTime, "event_time");
  const availableUs = parseTimestampUs(availableTime, "available_time");
  if (availableUs < eventUs) {
    throw new Error("available_time must not precede event_time");
  }

  return {
    instrument,
    event_time: eventTime,
    available_time: availableTime,
    eventUs,
    availableUs,
    revision: requireNonNegativeInteger(record.revision, "revision"),
    value: requireFinite(record.value, "value"),
  };
}

/**
 * A higher revision must arrive strictly later than the one it supersedes.
 *
 * Without this, "the latest revision available at time T" is ambiguous: two revisions
 * of the same event could both be available with no defined winner, and the answer
 * would depend on input ordering rather than on the data.
 */
function checkRevisionArrivalOrder(rows: ParsedObservation[]): void {
  const groups = new Map<number, ParsedObservation[]>();
  for (const row of rows) {
    const group = groups.get(row.eventUs);
    if (group) group.push(row);
    else groups.set(row.eventUs, [row]);
  }
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => a.revision - b.revision);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index - 1]!.availableUs >= ordered[index]!.availableUs) {
        throw new Error("higher revisions must have later available_time values");
      }
    }
  }
}

export function parseObservations(
  observations: Iterable<unknown>,
): Map<string, ParsedObservation[]> {
  const byInstrument = new Map<string, ParsedObservation[]>();
  const seen = new Set<string>();

  for (const row of observations) {
    const parsed = parseObservation(row);
    const key = `${parsed.instrument} ${parsed.eventUs} ${parsed.revision}`;
    if (seen.has(key)) {
      throw new Error("revisions must be unique per instrument and event_time");
    }
    seen.add(key);
    const group = byInstrument.get(parsed.instrument);
    if (group) group.push(parsed);
    else byInstrument.set(parsed.instrument, [parsed]);
  }

  for (const rows of byInstrument.values()) {
    // Newest event first, and within one event newest revision first. The lookup then
    // walks forward and stops at the first row it is allowed to use.
    rows.sort((a, b) => b.eventUs - a.eventUs || b.revision - a.revision);
    checkRevisionArrivalOrder(rows);
  }
  return byInstrument;
}

export interface ParsedRequest {
  grid_time: string;
  query_time: string;
  gridUs: number;
  queryUs: number;
}

export function parseRequests(requests: Iterable<unknown>): ParsedRequest[] {
  const parsed: ParsedRequest[] = [];
  const seen = new Set<string>();

  for (const request of requests) {
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      throw new Error("each request must be a mapping");
    }
    const record = request as Record<string, unknown>;
    const gridTime = record.grid_time as string;
    const queryTime = record.query_time as string;
    const gridUs = parseTimestampUs(gridTime, "grid_time");
    const queryUs = parseTimestampUs(queryTime, "query_time");
    if (queryUs < gridUs) {
      // Asking a question about a grid point *before* that grid point exists is
      // almost always a swapped-argument bug, and silently allowing it would make
      // the as-of guarantee meaningless.
      throw new Error("query_time must not precede grid_time");
    }
    const key = `${gridUs} ${queryUs}`;
    if (seen.has(key)) {
      throw new Error("request (grid_time, query_time) pairs must be unique");
    }
    seen.add(key);
    parsed.push({ grid_time: gridTime, query_time: queryTime, gridUs, queryUs });
  }
  return parsed;
}

export function emptySample(
  instrument: string,
  gridTime: string,
  queryTime: string,
  status: SampleStatus,
): Sample {
  return {
    instrument,
    grid_time: gridTime,
    query_time: queryTime,
    value: null,
    source_event_time: null,
    source_available_time: null,
    source_revision: null,
    staleness_ms: null,
    status,
  };
}

/**
 * Find the value in force at `gridUs` as known at `queryUs`.
 *
 * `rows` is pre-sorted newest-event-first, newest-revision-first, so this walks
 * forward and stops at the first row that passes both clocks — an early exit rather
 * than the two full passes a filter-then-max would cost.
 *
 * Reports whether any row was event-eligible at all, which is what separates "nothing
 * has happened yet" from "it has happened but you could not have known".
 */
export function lookup(
  rows: readonly ParsedObservation[],
  gridUs: number,
  queryUs: number,
): { chosen: ParsedObservation | null; sawEventEligible: boolean } {
  let sawEventEligible = false;
  for (const row of rows) {
    if (row.eventUs > gridUs) continue;
    sawEventEligible = true;
    if (row.availableUs <= queryUs) return { chosen: row, sawEventEligible: true };
  }
  return { chosen: null, sawEventEligible };
}

export function buildSample(
  instrument: string,
  gridTime: string,
  queryTime: string,
  chosen: ParsedObservation,
  gridUs: number,
  maxStalenessUs: number,
): Sample {
  const stalenessUs = gridUs - chosen.eventUs;
  const stale = stalenessUs > maxStalenessUs;
  return {
    instrument,
    grid_time: gridTime,
    query_time: queryTime,
    value: stale ? null : chosen.value,
    source_event_time: chosen.event_time,
    source_available_time: chosen.available_time,
    source_revision: chosen.revision,
    staleness_ms: stalenessUs / 1000,
    status: stale ? "stale" : stalenessUs === 0 ? "exact" : "carried",
  };
}

/**
 * Sample each instrument onto the requested grid, honouring both clocks.
 *
 * @param observations Rows carrying `instrument`, `event_time`, `available_time`,
 *   `revision` and `value`.
 * @param requests `grid_time` / `query_time` pairs to sample.
 * @param maxStalenessMs How old a carried value may be before it is reported as
 *   unusable. `0` means only an exact hit counts.
 * @returns One sample per (instrument, request), instruments in sorted order and
 *   requests in the order given. Every sample carries its own lineage.
 */
export function previousTick(
  observations: Iterable<unknown>,
  requests: Iterable<unknown>,
  maxStalenessMs: number,
): Sample[] {
  requireNonNegativeInteger(maxStalenessMs, "max_staleness_ms");
  const maxStalenessUs = maxStalenessMs * 1000;

  const parsedRequests = parseRequests(requests);
  const byInstrument = parseObservations(observations);

  const output: Sample[] = [];
  for (const instrument of [...byInstrument.keys()].sort()) {
    const rows = byInstrument.get(instrument)!;
    for (const request of parsedRequests) {
      const { chosen, sawEventEligible } = lookup(rows, request.gridUs, request.queryUs);

      if (!sawEventEligible) {
        output.push(
          emptySample(instrument, request.grid_time, request.query_time, "no_history"),
        );
        continue;
      }
      if (chosen === null) {
        output.push(
          emptySample(
            instrument,
            request.grid_time,
            request.query_time,
            "not_yet_available",
          ),
        );
        continue;
      }
      output.push(
        buildSample(
          instrument,
          request.grid_time,
          request.query_time,
          chosen,
          request.gridUs,
          maxStalenessUs,
        ),
      );
    }
  }
  return output;
}
