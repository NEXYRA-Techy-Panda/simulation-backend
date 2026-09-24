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
 * K1 manual-demo run configuration (synthetic assumptions, stored immutably
 * with every run). Automatic schedules/occupancy replace parts of this later.
 */
export const MANUAL_DEMO_CONFIG = {
  mode: 'manual_demo',
  contract_version: '1.0.1',
  step_seconds: STEP_SECONDS,
  interval_seconds: INTERVAL_SECONDS,
  initial_sim_time_utc: INITIAL_SIM_TIME_UTC,
  occupancy: { mode: 'manual', initial_per_room: 0 },
  environment: {
    synthetic: true,
    note: 'Constant synthetic room climate; no thermal model in K1.',
    avg_temp_c: 26.0,
    avg_rh_pct: 55.0,
  },
  devices: {
    initial_state: 'Controllable loads start off; always_on devices start on.',
    power_model: 'on => nominal_power_w (whole device/group); off => standby_power_w or 0. quantity is never multiplied in.',
    refrigerator: 'Constant nominal draw (no compressor cycling in K1).',
    clear_override: 'Restores the initial/base state; automatic policy evaluation will replace this in the schedule layer.',
  },
  unmodelled: ['avg_voltage_v', 'avg_current_a', 'AC thermal behaviour', 'refrigerator cycling', 'automatic schedules'],
} as const;
