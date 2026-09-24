/**
 * K004-PREP environment constants — feature branch `kishore/k004-environment-prep`.
 *
 * NOT connected to the engine, not deployed. Every value below is either an
 * existing contract/engine value (with its source) or an explicitly labelled
 * synthetic demo assumption. Nothing here is calibrated building physics.
 */

/**
 * Room-climate command fields, exactly as contract 1.0.1 API.md defines them for
 * `POST /api/v1/environment`: `{ "room_id", "temp_c": 26.5, "rh_pct": 55 }`.
 * The command is closed: no other field name is accepted (no setpoint field,
 * no outdoor/ambient field exists in the contract).
 */
export const ROOM_CLIMATE_COMMAND_FIELDS = ['room_id', 'temp_c', 'rh_pct'] as const;

/**
 * Aggregate climate fields, exactly as contract 1.0.1 defines them on room
 * interval summaries / engine state: `avg_temp_c` and `avg_rh_pct`
 * (CONTRACT.md §"room interval", CSV_COLUMNS.md `room_temp_c`/`room_rh_pct`).
 * These are per-interval room averages, not outdoor weather.
 */
export const ROOM_CLIMATE_AGGREGATE_FIELDS = ['avg_temp_c', 'avg_rh_pct'] as const;

/**
 * Closed telemetry bounds copied from the contract and the SQLite schema:
 * dataset.schema.json `avg_temp_c` minimum -30 / maximum 60 and `avg_rh_pct`
 * minimum 0 / maximum 100; migration 001 has the same CHECK constraints.
 */
export const TEMP_C_MIN = -30;
export const TEMP_C_MAX = 60;
export const RH_PCT_MIN = 0;
export const RH_PCT_MAX = 100;

/**
 * Existing synthetic demo climate (engine RUN_CONFIG.environment.avg_temp_c /
 * avg_rh_pct, documented as "constant synthetic room climate; no thermal model
 * yet"). Used as the model default when no explicit reading is supplied.
 */
export const DEFAULT_ROOM_TEMP_C = 26.0;
export const DEFAULT_ROOM_RH_PCT = 55.0;

/**
 * DEMO ASSUMPTIONS for the simplified AC demand model — NOT contract values and
 * NOT existing simulator controls. The simulator currently has no setpoint and
 * no temperature-based AC control (AC follows its schedule only).
 */
/** Target cooling temperature used to derive demand; internal demo assumption. */
export const DEFAULT_AC_SETPOINT_C = 24.0;
/** Temperature excess above the setpoint at which the demo model reaches full demand. */
export const FULL_LOAD_DELTA_C = 6.0;
/** Demo part-load floor: a running AC never drops below this fraction of nominal. */
export const MIN_LOAD_FRACTION = 0.2;
/** Demo internal-gain term: demand contributed per occupant, as a fraction of nominal. */
export const OCCUPANCY_LOAD_FRACTION_PER_PERSON = 0.03;
/** Occupancy context bound, matching the simulator's documented 0–20 occupants. */
export const MAX_OCCUPANCY_CONTEXT = 20;

/**
 * Stable identifier of this AC power model. It is recorded in the immutable
 * run configuration of every run created with it; a run whose configuration
 * has no id is a legacy run and keeps the flat-rated model. Bump this string
 * (e.g. `ac-demand-v2`) if any assumption below changes, so two runs can never
 * claim the same model while meaning different energy.
 */
export const AC_POWER_MODEL_ID = 'ac-demand-v1';

/** Only this device type may be routed through the AC model. */
export const SUPPORTED_AC_DEVICE_TYPES = ['ac'] as const;

/**
 * The demo formula ignores humidity: `rh_pct` is validated and reported back,
 * but relative humidity has no term in the power calculation. Do not claim
 * humidity sensitivity for this model.
 */
export const HUMIDITY_AFFECTS_AC_POWER = false;

/**
 * This module prescribes room temperature as an EXTERNAL input; it does not
 * model a room temperature trajectory. Cooling-down dynamics are deliberately
 * out of scope (see docs/K004_ENVIRONMENT_PREP_EVIDENCE.md).
 */
export const MODELS_ROOM_TEMPERATURE_TRAJECTORY = false;
