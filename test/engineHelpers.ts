import type { Database } from '../src/db/connection.js';
import { addPolicyVersion } from '../src/db/inventory.js';
import { SimulationEngine } from '../src/engine/engine.js';
import type { SchedulerDeps } from '../src/engine/scheduler.js';

export const TEST_LOAD = 'dev-test-load';

/** Adds a controllable 1 kW lighting load (pf 1, no standby) with its own lighting policy. */
export function addTestLoad(db: Database, watts = 1000): void {
  db.prepare(`INSERT INTO devices (device_id, room_id, name, device_type, quantity, nominal_power_w, power_factor,
      always_on, control, controls, created_utc, updated_utc)
      VALUES (?, 'room-meeting', 'Test load', 'lighting', 1, ?, 1.0, 0, 'manual', '["switch"]', 't', 't')`).run(TEST_LOAD, watts);
  db.prepare(`INSERT INTO policies (policy_id, kind, device_id, created_utc) VALUES ('pol-test-load', 'lighting_schedule', ?, 't')`)
    .run(TEST_LOAD);
  addPolicyVersion(db, { policy_id: 'pol-test-load', effective_from_utc: '2000-01-01T00:00:00Z',
    rules: { on_during_hours: true, vacancy_grace_seconds: 300 } });
}

/** Fake monotonic clock + inert timers: the scheduler only runs when a test calls tick(). */
export function fakeClock(): { deps: SchedulerDeps; advanceMs: (ms: number) => void } {
  let now = 0;
  return {
    deps: { now: () => now, setTimeout: () => 0, clearTimeout: () => undefined, setImmediate: () => 0, clearImmediate: () => undefined },
    advanceMs: (ms) => { now += ms; },
  };
}

export function fakeEngine(db: Database): { engine: SimulationEngine; advanceMs: (ms: number) => void } {
  const clock = fakeClock();
  return { engine: new SimulationEngine(db, { schedulerDeps: clock.deps }), advanceMs: clock.advanceMs };
}

/** Drains the scheduler's owed steps (as the real loop would across batches). */
export function drain(engine: SimulationEngine): number {
  let total = 0;
  for (;;) {
    const n = engine.scheduler.tick();
    total += n;
    if (n === 0 && engine.scheduler.backlogSteps === 0) return total;
  }
}

export interface DeviceState { device_id: string; room_id: string; on: boolean; power_w: number; energy_kwh: number; override: unknown }
export interface EngineState {
  status: string; speed: number; run_id: string | null; seq: number | null; sim_time_utc: string | null;
  rooms: {
    room_id: string; occupancy: number; power_w: number; energy_kwh: number;
    /** Prescribed per-room climate (K004-PREP2); null on a legacy run. */
    climate: { temp_c: number; rh_pct: number } | null;
  }[];
  devices: DeviceState[];
  office: { power_w: number; energy_kwh: number } | null;
  partial_interval?: { start_utc: string; covered_seconds: number };
  /** Recorded AC power model id of the active run; null for a legacy run. */
  ac_power_model?: string | null;
}

export const stateOf = (engine: SimulationEngine): EngineState => engine.getState() as unknown as EngineState;
export const deviceOf = (engine: SimulationEngine, id: string): DeviceState => stateOf(engine).devices.find((d) => d.device_id === id)!;

export interface DeviceIntervalRow {
  run_id: string; device_id: string; room_id: string; interval_start_utc: string; interval_end_utc: string;
  interval_seconds: number; avg_power_w: number; max_power_w: number; energy_kwh: number; cumulative_kwh: number;
  avg_voltage_v: number | null; avg_current_a: number | null; power_factor: number; on_fraction: number;
  override_seconds: number; vacant_on_seconds: number; offschedule_on_seconds: number; policy_ref: string; partial: number;
}

export function deviceIntervals(db: Database, runId: string, deviceId?: string): DeviceIntervalRow[] {
  const sql = `SELECT run_id, device_id, room_id, interval_start_utc, interval_end_utc, interval_seconds, avg_power_w,
      max_power_w, energy_kwh, cumulative_kwh, avg_voltage_v, avg_current_a, power_factor, on_fraction, override_seconds,
      vacant_on_seconds, offschedule_on_seconds, policy_ref, partial FROM device_intervals WHERE run_id = ?
      ${deviceId ? 'AND device_id = ?' : ''} ORDER BY device_id, interval_start_utc`;
  const args = deviceId ? [runId, deviceId] : [runId];
  return db.prepare(sql).all(...args) as unknown as DeviceIntervalRow[];
}

/** DB row → contract device-interval object (booleans, absent unmodelled V/I). */
export function toContractDeviceInterval(r: DeviceIntervalRow): Record<string, unknown> {
  const { avg_voltage_v, avg_current_a, partial, ...rest } = r;
  return {
    ...rest, partial: partial === 1,
    ...(avg_voltage_v === null ? {} : { avg_voltage_v }), ...(avg_current_a === null ? {} : { avg_current_a }),
  };
}
