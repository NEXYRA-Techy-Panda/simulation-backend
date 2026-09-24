import type { Database } from '../db/connection.js';
import { INTERVAL_SECONDS, KOLKATA_OFFSET_SECONDS, type RecordingInterval, STEP_SECONDS, isRecordingInterval } from '../engine/constants.js';
import { MAX_OCCUPANTS, type OccupancyMode } from '../engine/occupancy.js';
import { isSeed } from '../engine/rng.js';
import { ApiError } from '../http/errors.js';

/**
 * K005-PREP history-job request validation (contracts/v1/API.md
 * `POST /api/v1/history/jobs`: `{ from, to, interval_seconds }`). `interval_seconds`
 * is 60 (default) or 3600 (K004-FAST1 hourly recording); from/to must lie on
 * local recording boundaries (local minutes / local hours, Asia/Kolkata).
 *
 * Additive fields (documented, not contract changes):
 *  - `month` "YYYY-MM": a local Asia/Kolkata calendar month, instead of from/to.
 *  - `seed`: the run's occupancy seed (0..4294967295); generated and recorded when omitted.
 *  - `occupancy`: `{mode, total}` (manual) or `{mode, target}` (scheduled). The
 *    mode must equal the mode of the occupancy policy revision the run will pin;
 *    only the runtime count is job-specific.
 * Explicitly rejected: `calendar` / `environment` (job-specific values would
 * need a global policy revision or a thermal model that does not exist).
 *
 * Everything is validated before a job row exists, so an invalid request has
 * no side effects.
 */

export const HISTORY_ALLOWED_FIELDS = ['from', 'to', 'interval_seconds', 'month', 'seed', 'occupancy', 'calendar', 'environment'] as const;

/** Bounded workload: at most 31 days (one longest calendar month) per job. */
export const MAX_RANGE_SECONDS = 31 * 86_400;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const toUtc = (epoch: number): string => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export interface HistoryRequest {
  from_utc: string;
  to_utc: string;
  interval_seconds: RecordingInterval;
  month: string | null;
  seed: number;
  seed_source: 'request' | 'generated';
  occupancy: { mode: OccupancyMode; count: number } | null;
  expected_steps: number;
  expected_intervals: number;
}

const bad = (message: string, field: string): ApiError => new ApiError(400, 'VALIDATION_ERROR', message, field);

/** Strict UTC instant: exact `YYYY-MM-DDTHH:MM:SSZ`, a real calendar value, supported years. */
export function parseUtc(value: unknown, field: string): number {
  if (typeof value !== 'string' || !UTC_RE.test(value)) throw bad(`${field} must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ`, field);
  const epoch = Date.parse(value) / 1000;
  if (!Number.isFinite(epoch) || toUtc(epoch) !== value) throw bad(`${field} is not a real calendar instant`, field);
  const year = Number(value.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) throw bad(`${field} must lie in years ${MIN_YEAR}–${MAX_YEAR}`, field);
  return epoch;
}

/**
 * Local (Asia/Kolkata, fixed +05:30, no DST) calendar month → UTC half-open
 * window [first local midnight, next month's first local midnight). The next
 * boundary is computed from the calendar (28/29/30/31 days, December → next
 * January), never assumed.
 */
export function monthWindow(month: unknown): { from: number; to: number } {
  const m = typeof month === 'string' ? MONTH_RE.exec(month) : null;
  if (!m) throw bad('month must be "YYYY-MM"', 'month');
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (year < MIN_YEAR || year >= MAX_YEAR) throw bad(`month must lie in years ${MIN_YEAR}–${MAX_YEAR - 1}`, 'month');
  const next = mon === 12 ? { year: year + 1, mon: 1 } : { year, mon: mon + 1 };
  const localMidnight = (y: number, mo: number): number => Date.UTC(y, mo - 1, 1) / 1000 - KOLKATA_OFFSET_SECONDS;
  return { from: localMidnight(year, mon), to: localMidnight(next.year, next.mon) };
}

/** Pinned occupancy mode a NEW run would adopt (current revision) and the office's room capacity. */
function occupancyContext(db: Database): { mode: OccupancyMode; capacity: number } {
  const row = db.prepare(`SELECT rules FROM current_policy_versions WHERE kind = 'occupancy' ORDER BY policy_id LIMIT 1`)
    .get() as { rules: string } | undefined;
  const mode = (row ? (JSON.parse(row.rules) as { mode?: OccupancyMode }).mode : undefined) ?? 'manual';
  const cap = db.prepare(`SELECT coalesce(sum(r.capacity), 0) AS c FROM rooms r
      WHERE r.building_id = (SELECT building_id FROM buildings ORDER BY building_id LIMIT 1)`).get() as { c: number };
  return { mode, capacity: cap.c };
}

export function validateHistoryRequest(db: Database, body: Record<string, unknown>, randomSeed: () => number): HistoryRequest {
  if (body.calendar !== undefined) {
    throw bad('job-specific calendar is not supported: office hours are a global policy revision; the run uses the current revision', 'calendar');
  }
  if (body.environment !== undefined) {
    throw bad('job-specific environment is not supported: the committed engine uses a constant synthetic room climate', 'environment');
  }
  if (body.interval_seconds !== undefined && !isRecordingInterval(body.interval_seconds)) {
    throw bad('interval_seconds must be 60 or 3600', 'interval_seconds');
  }
  const interval: RecordingInterval = (body.interval_seconds as RecordingInterval | undefined) ?? INTERVAL_SECONDS;
  const aligned = (epoch: number): boolean => (epoch + KOLKATA_OFFSET_SECONDS) % interval === 0;
  const unit = interval === INTERVAL_SECONDS ? 'minute' : 'local hour (UTC hh:30)';

  let from: number;
  let to: number;
  let month: string | null = null;
  if (body.month !== undefined) {
    if (body.from !== undefined || body.to !== undefined) throw bad('give either month or from/to, not both', 'month');
    ({ from, to } = monthWindow(body.month));
    month = body.month as string;
  } else {
    if (body.from === undefined) throw bad('from is required (or month)', 'from');
    if (body.to === undefined) throw bad('to is required (or month)', 'to');
    from = parseUtc(body.from, 'from');
    to = parseUtc(body.to, 'to');
    if (!aligned(from)) throw bad(`from must be on a ${unit} boundary`, 'from');
    if (!aligned(to)) throw bad(`to must be on a ${unit} boundary`, 'to');
    if (to <= from) throw bad('to must be after from (half-open window [from, to))', 'to');
  }
  if (to - from > MAX_RANGE_SECONDS) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'window exceeds 31 days; split it into several jobs', 'to');

  let seed: number;
  let seedSource: 'request' | 'generated';
  if (body.seed !== undefined) {
    if (!isSeed(body.seed)) throw bad('seed must be an integer from 0 to 4294967295', 'seed');
    seed = body.seed;
    seedSource = 'request';
  } else {
    seed = randomSeed();
    seedSource = 'generated';
  }

  const building = db.prepare('SELECT building_id FROM buildings ORDER BY building_id LIMIT 1').get();
  if (!building) throw new ApiError(409, 'CONFLICT', 'Inventory is not seeded; run npm run db:seed');

  let occupancy: HistoryRequest['occupancy'] = null;
  if (body.occupancy !== undefined) {
    const o = body.occupancy as Record<string, unknown>;
    if (typeof o !== 'object' || o === null || Array.isArray(o)) throw bad('occupancy must be an object', 'occupancy');
    for (const k of Object.keys(o)) if (!['mode', 'total', 'target'].includes(k)) throw bad(`Unknown field "occupancy.${k}"`, `occupancy.${k}`);
    if (o.mode !== 'manual' && o.mode !== 'scheduled') throw bad('occupancy.mode must be "manual" or "scheduled"', 'occupancy.mode');
    const ctx = occupancyContext(db);
    if (o.mode !== ctx.mode) {
      throw new ApiError(409, 'CONFLICT',
        `occupancy.mode "${o.mode}" differs from the current occupancy policy revision ("${ctx.mode}"); a job-specific mode would mint a global revision and is not supported`,
        'occupancy.mode');
    }
    const field = o.mode === 'manual' ? 'total' : 'target';
    const other = o.mode === 'manual' ? 'target' : 'total';
    if (o[other] !== undefined) throw bad(`occupancy.${other} does not apply to ${o.mode} mode`, `occupancy.${other}`);
    const n = o[field];
    if (n === undefined) throw bad(`occupancy.${field} is required for ${o.mode} mode`, `occupancy.${field}`);
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > MAX_OCCUPANTS) {
      throw bad(`occupancy.${field} must be an integer from 0 to ${MAX_OCCUPANTS}`, `occupancy.${field}`);
    }
    if ((n as number) > ctx.capacity) throw new ApiError(409, 'CONFLICT', `occupancy.${field} exceeds total room capacity ${ctx.capacity}`, `occupancy.${field}`);
    occupancy = { mode: o.mode, count: n as number };
  }

  return {
    from_utc: toUtc(from), to_utc: toUtc(to), interval_seconds: interval, month, seed, seed_source: seedSource, occupancy,
    expected_steps: (to - from) / STEP_SECONDS, expected_intervals: (to - from) / interval,
  };
}
