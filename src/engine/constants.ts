import { AC_POWER_MODEL_ID } from '../environment/constants.js';

/** Fixed simulated calculation step (seconds). */
export const STEP_SECONDS = 10;
/** Permanent aggregation interval (seconds); a multiple of STEP_SECONDS. */
export const INTERVAL_SECONDS = 60;
export const STEPS_PER_INTERVAL = INTERVAL_SECONDS / STEP_SECONDS;

export const SPEEDS = [1, 2, 10, 60, 100, 1000] as const;
export type Speed = (typeof SPEEDS)[number];
export const isSpeed = (v: unknown): v is Speed => SPEEDS.includes(v as Speed);
export const DEFAULT_SPEED: Speed = 1;

/** 2026-01-01 00:00 Asia/Kolkata (UTC+05:30), stored as UTC. */
export const INITIAL_SIM_TIME_UTC = '2025-12-31T18:30:00Z';

/** Building timezone offset. Asia/Kolkata has had no DST since 1945. */
export const KOLKATA_OFFSET_SECONDS = 5.5 * 3600;

/** Wall-clock scheduler: tick period and the most steps processed before yielding. */
export const TICK_MS = 50;
export const MAX_STEPS_PER_BATCH = 120;

/**
 * Run configuration stored immutably with every new run (K3–K4). The run's
 * occupancy seed is added at creation (`occupancy_seed`). Synthetic
 * assumptions are labelled; thermal/comfort behaviour is not modelled yet.
 */
export const RUN_CONFIG = {
  mode: 'policy_control',
  layer: 'K3-K4',
  contract_version: '1.0.1',
  step_seconds: STEP_SECONDS,
  interval_seconds: INTERVAL_SECONDS,
  initial_sim_time_utc: INITIAL_SIM_TIME_UTC,
  occupancy: {
    max_total: 20,
    initial_mode: 'from the pinned occupancy policy (seed: manual)',
    initial_manual_total: 0,
    default_scheduled_target: 14,
    scheduled: 'All target occupants arrive at opening and leave at closing; meeting 11:00-12:00 (<=4 to meeting room) and lunch 13:00-14:00 (<=4 to pantry) redistribution.',
    randomness: 'Seeded mulberry32 occupancy stream, independent of the device stream.',
  },
  environment: {
    synthetic: true,
    note: 'Constant synthetic room climate; no thermal model yet.',
    avg_temp_c: 26.0,
    avg_rh_pct: 55.0,
  },
  devices: {
    power_model: 'on => nominal_power_w (whole device/group); off => standby_power_w or 0. quantity is never multiplied in.',
    /**
     * K004-PREP2: AC power model recorded in the immutable run configuration.
     * A run whose stored configuration has no `ac_power_model` is a legacy run
     * and keeps the flat-rated model above. New runs use the environment model
     * for `device_type: "ac"` only; every other device is unchanged.
     */
    ac_power_model: AC_POWER_MODEL_ID,
    ac_power_model_assumptions: {
      module: 'src/environment',
      setpoint_c: 24,
      full_load_delta_c: 6,
      min_on_load_fraction: 0.2,
      occupancy_fraction_per_person: 0.03,
      humidity_affects_power: false,
      room_temperature: 'prescribed external input; no thermal trajectory is simulated',
      nominal: 'whole device/group maximum for the demo model; quantity is never multiplied',
    },
    automatic_control: 'Scheduled devices and lights run while their schedule permits AND the room is occupied or within vacancy grace; schedule closing ends automatic operation; manual-control devices only run by override; always_on devices always run.',
    overrides: 'Persist until cleared; clearing returns to the current policy.',
    refrigerator: 'Constant nominal draw (no compressor cycling).',
    ac: 'Follows its operating schedule only; no temperature/comfort control yet.',
  },
  unmodelled: ['avg_voltage_v', 'avg_current_a', 'AC thermal/comfort behaviour', 'refrigerator cycling'],
} as const;
