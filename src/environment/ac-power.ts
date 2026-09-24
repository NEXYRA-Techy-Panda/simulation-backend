import { requireFiniteNumber, requireRhPct, requireTempC } from './climate.js';
import {
  DEFAULT_AC_SETPOINT_C, FULL_LOAD_DELTA_C, HUMIDITY_AFFECTS_AC_POWER, MAX_OCCUPANCY_CONTEXT,
  MIN_LOAD_FRACTION, OCCUPANCY_LOAD_FRACTION_PER_PERSON, SUPPORTED_AC_DEVICE_TYPES,
} from './constants.js';
import { EnvironmentInputError } from './errors.js';

/**
 * Minimum device-rating subset the AC model needs; structurally compatible with
 * the inventory `Device` record (src/db/inventory.ts).
 */
export interface AcDeviceRating {
  device_id: string;
  device_type: string;
  /** Member count, recorded for information only — NEVER multiplied into power. */
  quantity: number;
  /** Rating of the WHOLE device or group, in watts. */
  nominal_power_w: number;
  /** Off-state draw in watts; absent means 0 (the demo AC has no standby rating). */
  standby_power_w?: number;
}

/** Explicit, caller-supplied inputs. No wall clock, no RNG, no database, no globals. */
export interface AcPowerInput {
  device: AcDeviceRating;
  /** Device state decided by policy/override elsewhere; the model never decides it. */
  on: boolean;
  /** Prescribed EXTERNAL room temperature in °C (not a modelled trajectory). */
  temp_c: number;
  /** Optional demo setpoint in °C — an internal assumption, not an existing control. */
  setpoint_c?: number;
  /** Optional room humidity in %; validated and echoed, never used by the formula. */
  rh_pct?: number;
  /** Optional occupant count (0–20) used as an internal-gain context term. */
  occupancy?: number;
}

/** Deterministic explanation of one modelled value (for evidence, tests and future UI). */
export interface AcPowerResult {
  device_id: string;
  on: boolean;
  power_w: number;
  /** 0..1 demand fraction before the part-load floor is applied. */
  demand_fraction: number;
  temp_c: number;
  setpoint_c: number;
  rh_pct: number | null;
  occupancy: number;
  /** Documented modelled bounds: running power never leaves [min_power_w, max_power_w]. */
  min_power_w: number;
  max_power_w: number;
  /** Always false in this demo model. */
  humidity_affects_power: false;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Declared as a function so TypeScript treats a call as terminal for narrowing. */
function fail(code: 'INVALID_TYPE' | 'OUT_OF_RANGE' | 'UNSUPPORTED_DEVICE', field: string, message: string): never {
  throw new EnvironmentInputError(code, field, message);
}

const deviceName = (device: AcDeviceRating): string =>
  typeof device.device_id === 'string' && device.device_id !== '' ? device.device_id : '<unnamed device>';

/**
 * Rejects any device that must not be routed through the AC model (refrigerator,
 * lighting, fans, computers, workstation groups, projectors, microwaves, …) and
 * returns the validated rating. Standby above nominal is rejected as an
 * inconsistent rating rather than silently accepted.
 */
export function assertSupportedAcDevice(device: AcDeviceRating): AcDeviceRating {
  if (typeof device !== 'object' || device === null) {
    fail('INVALID_TYPE', 'device', 'device must be an inventory device object with device_type "ac"');
  }
  if (typeof device.device_id !== 'string' || device.device_id.trim() === '') {
    fail('INVALID_TYPE', 'device_id', 'device_id must be a non-empty string');
  }
  const { device_type: deviceType } = device;
  if (typeof deviceType !== 'string' || !SUPPORTED_AC_DEVICE_TYPES.includes(deviceType as 'ac')) {
    fail('UNSUPPORTED_DEVICE', 'device_type',
      `device "${deviceName(device)}" has device_type ${JSON.stringify(deviceType)}; the AC model supports only `
      + `${SUPPORTED_AC_DEVICE_TYPES.join(', ')}.Always-on and non-AC devices (refrigerator, lighting, fans, `
      + 'computers, projectors, microwaves) must keep their existing power behaviour.');
  }
  const quantity = requireFiniteNumber('quantity', device.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) {
    fail('OUT_OF_RANGE', 'quantity', `quantity must be an integer >= 1; got ${quantity}`);
  }
  const nominal = requireFiniteNumber('nominal_power_w', device.nominal_power_w);
  if (nominal < 0) {
    fail('OUT_OF_RANGE', 'nominal_power_w', `nominal_power_w must be >= 0 W; got ${nominal}`);
  }
  if (device.standby_power_w !== undefined) {
    const standby = requireFiniteNumber('standby_power_w', device.standby_power_w);
    if (standby < 0 || standby > nominal) {
      fail('OUT_OF_RANGE', 'standby_power_w',
        `standby_power_w must be within [0, nominal_power_w=${nominal}] W; got ${standby}`);
    }
  }
  return device;
}

/** Occupancy is optional context, bounded by the simulator's documented 0–20 occupants. */
function requireOccupancy(value: unknown): number {
  const n = requireFiniteNumber('occupancy', value);
  if (!Number.isInteger(n) || n < 0 || n > MAX_OCCUPANCY_CONTEXT) {
    fail('OUT_OF_RANGE', 'occupancy',
      `occupancy must be an integer within [0, ${MAX_OCCUPANCY_CONTEXT}]; got ${n}`);
  }
  return n;
}

/**
 * Pure demand fraction in 0..1 for room temperature above the demo setpoint plus
 * an optional occupant internal-gain term. Humidity has no term here.
 * Non-decreasing in both `temp_c` and `occupancy` for fixed other inputs.
 */
export function coolingDemandFraction(input: { temp_c: number; setpoint_c?: number; occupancy?: number }): number {
  const tempC = requireTempC('temp_c', input.temp_c);
  const setpointC = input.setpoint_c === undefined
    ? DEFAULT_AC_SETPOINT_C
    : requireTempC('setpoint_c', input.setpoint_c);
  const occupancy = input.occupancy === undefined ? 0 : requireOccupancy(input.occupancy);
  const temperatureTerm = clamp01((tempC - setpointC) / FULL_LOAD_DELTA_C);
  const occupancyTerm = clamp01(occupancy * OCCUPANCY_LOAD_FRACTION_PER_PERSON);
  return clamp01(temperatureTerm + occupancyTerm);
}

/** Documented modelled power bounds for one supported AC device, in watts. */
export function acPowerBoundsW(device: AcDeviceRating): { standby_power_w: number; min_on_power_w: number; max_power_w: number } {
  const rating = assertSupportedAcDevice(device);
  return {
    standby_power_w: rating.standby_power_w ?? 0,
    min_on_power_w: rating.nominal_power_w * MIN_LOAD_FRACTION,
    max_power_w: rating.nominal_power_w,
  };
}

/**
 * Simplified, deterministic AC power model (demo behaviour, not calibrated
 * physics). Off uses the device standby rating; on scales between the demo
 * part-load floor and the whole-device nominal rating:
 *
 *   demand = clamp01(max(0, temp_c - setpoint_c) / 6 °C + occupancy x 0.03)
 *   power  = nominal_power_w x (0.2 + 0.8 x demand)
 *
 * `quantity` is never multiplied in: `nominal_power_w` already rates the whole
 * device/group. The demo model deliberately defines `nominal_power_w` as the
 * modelled maximum — a limitation of this model, not a physical claim. kWh is
 * NOT computed here; the engine integrates W over simulated elapsed time.
 */
export function acPowerDetail(input: AcPowerInput): AcPowerResult {
  const rating = assertSupportedAcDevice(input.device);
  if (typeof input.on !== 'boolean') {
    fail('INVALID_TYPE', 'on', `on must be a boolean device state; got ${String(input.on)}`);
  }
  const tempC = requireTempC('temp_c', input.temp_c);
  const setpointC = input.setpoint_c === undefined
    ? DEFAULT_AC_SETPOINT_C
    : requireTempC('setpoint_c', input.setpoint_c);
  // Humidity is validated (and therefore never silently ignored input garbage),
  // but it has no term in the formula: HUMIDITY_AFFECTS_AC_POWER is false.
  const rhPct = input.rh_pct === undefined ? null : requireRhPct('rh_pct', input.rh_pct);
  const occupancy = input.occupancy === undefined ? 0 : requireOccupancy(input.occupancy);

  const demand = coolingDemandFraction({ temp_c: tempC, setpoint_c: setpointC, occupancy });
  const powerW = input.on
    ? rating.nominal_power_w * (MIN_LOAD_FRACTION + (1 - MIN_LOAD_FRACTION) * demand)
    : (rating.standby_power_w ?? 0);

  return {
    device_id: rating.device_id,
    on: input.on,
    power_w: powerW,
    demand_fraction: demand,
    temp_c: tempC,
    setpoint_c: setpointC,
    rh_pct: rhPct,
    occupancy,
    min_power_w: rating.nominal_power_w * MIN_LOAD_FRACTION,
    max_power_w: rating.nominal_power_w,
    humidity_affects_power: HUMIDITY_AFFECTS_AC_POWER,
  };
}

/** Finite, non-negative modelled AC power in watts for the supplied explicit state. */
export function acPowerW(input: AcPowerInput): number {
  return acPowerDetail(input).power_w;
}
