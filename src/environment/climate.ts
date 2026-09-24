import {
  DEFAULT_ROOM_RH_PCT, DEFAULT_ROOM_TEMP_C, RH_PCT_MAX, RH_PCT_MIN, ROOM_CLIMATE_AGGREGATE_FIELDS,
  ROOM_CLIMATE_COMMAND_FIELDS, TEMP_C_MAX, TEMP_C_MIN,
} from './constants.js';
import { EnvironmentInputError, type EnvironmentErrorCode } from './errors.js';

/**
 * Contract-shaped room-climate command (`POST /api/v1/environment`).
 * `temp_c` is the ROOM air temperature; there is no outdoor/ambient field in
 * contract 1.0.1 and this module does not invent one.
 */
export interface RoomClimateCommand {
  room_id: string;
  /** Room air temperature, degrees Celsius. */
  temp_c: number;
  /** Room relative humidity, percent (validated, not used by the AC power formula). */
  rh_pct: number;
}

/**
 * Contract-shaped aggregate room climate carried on room interval summaries
 * and engine state. Also a per-interval ROOM average — never outdoor weather.
 */
export interface RoomClimateAggregate {
  avg_temp_c: number;
  avg_rh_pct: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const describe = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return Array.isArray(value) ? `array(${value.length})` : typeof value;
};

/** Declared as a function so TypeScript treats a call as terminal for narrowing. */
function fail(code: EnvironmentErrorCode, field: string, message: string): never {
  throw new EnvironmentInputError(code, field, message);
}

/** Rejects anything that is not a finite JS number (no string coercion, no NaN/Infinity). */
export function requireFiniteNumber(field: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('INVALID_TYPE', field,
      `${field} must be a finite number; got ${describe(value)}. The value is rejected, never coerced or clamped.`);
  }
  return value;
}

/** Rejects out-of-range values with the accepted bounds; never silently clamps. */
export function requireInRange(field: string, value: unknown, min: number, max: number, unit: string): number {
  const n = requireFiniteNumber(field, value);
  if (n < min || n > max) {
    return fail('OUT_OF_RANGE', field,
      `${field} must be within [${min}, ${max}] ${unit}; got ${n}. The value is rejected, never clamped.`);
  }
  return n;
}

/** Room temperature in °C, bounded by the closed telemetry bounds (-30..60). */
export const requireTempC = (field: string, value: unknown): number =>
  requireInRange(field, value, TEMP_C_MIN, TEMP_C_MAX, '°C');

/** Relative humidity in percent, bounded by the closed telemetry bounds (0..100). */
export const requireRhPct = (field: string, value: unknown): number =>
  requireInRange(field, value, RH_PCT_MIN, RH_PCT_MAX, '%');

const rejectUnknownFields = (record: Record<string, unknown>, allowed: readonly string[], what: string): void => {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail('UNSUPPORTED_FIELD', key,
        `${what} has no field "${key}"; accepted fields are ${allowed.join(', ')}. No field is added to the closed schema.`);
    }
  }
};

/** Validates and normalizes one contract room-climate command. */
export function validateRoomClimateCommand(value: unknown): RoomClimateCommand {
  if (!isRecord(value)) {
    fail('INVALID_TYPE', 'room climate',
      `room climate must be an object with ${ROOM_CLIMATE_COMMAND_FIELDS.join(', ')}; got ${describe(value)}`);
  }
  rejectUnknownFields(value, ROOM_CLIMATE_COMMAND_FIELDS, 'room climate command');
  const { room_id: roomId } = value;
  if (typeof roomId !== 'string' || roomId.trim() === '') {
    fail('INVALID_TYPE', 'room_id', `room_id must be a non-empty string; got ${describe(roomId)}`);
  }
  return {
    room_id: roomId,
    temp_c: requireTempC('temp_c', value.temp_c),
    rh_pct: requireRhPct('rh_pct', value.rh_pct),
  };
}

/** Validates and normalizes one contract aggregate room climate (`avg_temp_c`/`avg_rh_pct`). */
export function validateRoomClimateAggregate(value: unknown): RoomClimateAggregate {
  if (!isRecord(value)) {
    fail('INVALID_TYPE', 'room climate aggregate',
      `room climate aggregate must be an object with ${ROOM_CLIMATE_AGGREGATE_FIELDS.join(', ')}; got ${describe(value)}`);
  }
  rejectUnknownFields(value, ROOM_CLIMATE_AGGREGATE_FIELDS, 'room climate aggregate');
  return {
    avg_temp_c: requireTempC('avg_temp_c', value.avg_temp_c),
    avg_rh_pct: requireRhPct('avg_rh_pct', value.avg_rh_pct),
  };
}

/**
 * The existing synthetic demo climate (engine RUN_CONFIG.environment): 26 °C /
 * 55 % RH. Returned as a fresh object on every call — no shared mutable state.
 */
export function defaultRoomClimate(): { temp_c: number; rh_pct: number } {
  return { temp_c: DEFAULT_ROOM_TEMP_C, rh_pct: DEFAULT_ROOM_RH_PCT };
}

/**
 * Temporary bridge from the engine's stored aggregate climate to the model's
 * room-climate inputs. The engine currently persists only the run's constant
 * synthetic climate, so per-room readings come from the (not yet implemented)
 * `POST /api/v1/environment` route once it exists.
 */
export function roomClimateFromAggregate(aggregate: RoomClimateAggregate): { temp_c: number; rh_pct: number } {
  return { temp_c: aggregate.avg_temp_c, rh_pct: aggregate.avg_rh_pct };
}
