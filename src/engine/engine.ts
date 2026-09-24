import { randomUUID } from 'node:crypto';
import { utcNow } from '../db/clock.js';
import { type Database, transaction } from '../db/connection.js';
import { createRun } from '../db/runs.js';
import { ApiError } from '../http/errors.js';
import {
  DEFAULT_SPEED, INITIAL_SIM_TIME_UTC, INTERVAL_SECONDS, MANUAL_DEMO_CONFIG, type Speed, STEP_SECONDS, isSpeed,
} from './constants.js';
import { type OfficeHoursRules, type ScheduleWindow, scheduleWindowFor } from './schedule.js';
import { type SchedulerDeps, type SchedulerOptions, WallClockScheduler } from './scheduler.js';

export type Lifecycle = 'not_initialized' | 'paused' | 'running';

/** Lifecycle/command errors carry their contract status and code. */
export class EngineError extends ApiError {}

export type DeviceCommand = { kind: 'set'; on: boolean } | { kind: 'clear' };

interface DeviceRuntime {
  device_id: string;
  room_id: string;
  device_type: string;
  controls: string[];
  nominal_power_w: number;
  standby_power_w: number | null;
  power_factor: number;
  always_on: boolean;
  policy_id: string;
  policy_version: number;
  expectedOn: ScheduleWindow;
  /** Initial/base state (manual demo: controllable off, always_on on). */
  base_on: boolean;
  /** Manual override; persists until cleared. */
  override: { on: boolean } | null;
  /** Run-relative cumulative energy, unrounded. */
  cumulative_kwh: number;
}

interface DeviceAcc {
  energy_kwh: number;
  power_seconds: number;
  max_power_w: number;
  on_seconds: number;
  override_seconds: number;
  vacant_on_seconds: number;
  offschedule_on_seconds: number;
}

interface RoomAcc {
  occupancy_seconds: number;
  occupancy_max: number;
  occupied_seconds: number;
}

/** Current partial interval: processed but not yet published as a completed minute. */
interface PartialInterval {
  start_epoch: number;
  covered_seconds: number;
  devices: Record<string, DeviceAcc>;
  rooms: Record<string, RoomAcc>;
}

interface CheckpointState {
  devices: Record<string, { base_on: boolean; override: { on: boolean } | null; cumulative_kwh: number }>;
  rooms: Record<string, { occupancy: number }>;
  partial: PartialInterval;
}

interface RunRuntime {
  run_id: string;
  simEpoch: number;
  seq: number;
  devices: DeviceRuntime[];
  rooms: { room_id: string; occupancy: number }[];
  environment: { avg_temp_c: number; avg_rh_pct: number };
  partial: PartialInterval;
}

export interface EngineOptions {
  schedulerDeps?: SchedulerDeps;
  scheduler?: SchedulerOptions;
  /** Wall-clock source for record bookkeeping (created_utc etc.). */
  wallClock?: () => Date;
}

const toEpoch = (utc: string): number => Date.parse(utc) / 1000;
const toUtc = (epoch: number): string => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const powerOf = (d: DeviceRuntime, on: boolean): number => (on ? d.nominal_power_w : (d.standby_power_w ?? 0));
const isOn = (d: DeviceRuntime): boolean => (d.override ? d.override.on : d.base_on);

const emptyDeviceAcc = (): DeviceAcc => ({
  energy_kwh: 0, power_seconds: 0, max_power_w: 0, on_seconds: 0, override_seconds: 0, vacant_on_seconds: 0, offschedule_on_seconds: 0,
});

/**
 * Backend-authoritative simulation engine (K1). All simulated time advances
 * through advanceSteps(), which is deterministic and independent of wall
 * time; the WallClockScheduler only decides how many steps are owed.
 */
export class SimulationEngine {
  private status: Lifecycle = 'not_initialized';
  private speed: Speed = DEFAULT_SPEED;
  private run: RunRuntime | null = null;
  readonly scheduler: WallClockScheduler;
  private readonly wallClock: () => Date;

  constructor(private readonly db: Database, options: EngineOptions = {}) {
    this.wallClock = options.wallClock ?? (() => new Date());
    this.scheduler = new WallClockScheduler(
      (steps) => this.advanceSteps(steps),
      this.speed,
      (err) => {
        console.error('Simulation step failed; engine paused:', err);
        this.status = this.run ? 'paused' : 'not_initialized';
      },
      options.schedulerDeps,
      options.scheduler,
    );
  }

  // ---------------------------------------------------------------- lifecycle

  get lifecycle(): Lifecycle {
    return this.status;
  }

  get currentSpeed(): Speed {
    return this.speed;
  }

  /** Loads the most recent active run (if any) as PAUSED. Downtime never advances simulated time. */
  recover(): { run_id: string; sim_time_utc: string; seq: number } | null {
    const row = this.db.prepare(`SELECT run_id, seq, sim_time_utc, speed, state FROM engine_checkpoints
        WHERE lifecycle = 'active'`).get() as { run_id: string; seq: number; sim_time_utc: string; speed: number; state: string } | undefined;
    if (!row) return null;
    const state = JSON.parse(row.state) as CheckpointState;
    this.run = this.loadRun(row.run_id, toEpoch(row.sim_time_utc), row.seq, state);
    this.speed = isSpeed(row.speed) ? row.speed : DEFAULT_SPEED;
    this.scheduler.setSpeed(this.speed);
    this.status = 'paused';
    return { run_id: row.run_id, sim_time_utc: row.sim_time_utc, seq: row.seq };
  }

  /** idle → new run, running; paused → running; running → no-op (no second timer). */
  start(speed?: unknown): void {
    if (speed !== undefined) this.setSpeed(speed);
    if (!this.run) this.run = this.createNewRun();
    this.goRunning();
  }

  /** paused → running; running → no-op; no run → 409. */
  resume(speed?: unknown): void {
    if (!this.run) throw new EngineError(409, 'CONFLICT', 'No simulation run exists; use start');
    if (speed !== undefined) this.setSpeed(speed);
    this.goRunning();
  }

  /** running → paused (freezes at the last processed step); paused → no-op; no run → 409. */
  pause(): void {
    if (!this.run) throw new EngineError(409, 'CONFLICT', 'No simulation run exists');
    if (this.status !== 'running') return;
    this.scheduler.stop();
    this.status = 'paused';
    this.run.seq++;
    this.writeCheckpoint();
  }

  /**
   * Ends the current run (publishing its processed partial interval with
   * partial=true and its actual duration) and creates a NEW run at the
   * initial time with seq 0, paused. Old runs and their readings are kept.
   */
  reset(): void {
    this.scheduler.stop();
    if (this.run) {
      const run = this.run;
      transaction(this.db, () => {
        this.publishPartial(run, true);
        this.upsertCheckpoint(run, 'ended');
      });
    }
    this.run = this.createNewRun();
    this.status = 'paused';
  }

  setSpeed(speed: unknown): void {
    if (!isSpeed(speed)) {
      throw new EngineError(400, 'VALIDATION_ERROR', 'speed must be one of 1, 2, 10, 60, 100, 1000', 'speed');
    }
    if (speed === this.speed) return;
    this.scheduler.setSpeed(speed);
    this.speed = speed;
    if (this.run) {
      this.run.seq++;
      this.writeCheckpoint();
    }
  }

  /** Stops the loop and checkpoints (including the partial accumulator). Status is recovered as paused. */
  shutdown(): void {
    this.scheduler.stop();
    if (this.run) {
      this.writeCheckpoint();
      this.status = 'paused';
    }
  }

  // ------------------------------------------------------------ device control

  /**
   * Applies a manual lighting command at the current processed step boundary
   * (sim_time_utc): it affects subsequent steps only; accumulated energy is
   * never altered. K1 supports lighting devices with the "switch" control.
   */
  commandDevice(deviceId: string, command: DeviceCommand): { device_id: string; override: { active: true; on: boolean } | null; seq: number; sim_time_utc: string } {
    if (!this.run) throw new EngineError(409, 'CONFLICT', 'No simulation run exists; start the simulation first');
    const device = this.run.devices.find((d) => d.device_id === deviceId);
    if (!device) throw new EngineError(404, 'NOT_FOUND', `Device "${deviceId}" is not part of the current run`);
    if (device.device_type !== 'lighting' || !device.controls.includes('switch')) {
      throw new EngineError(400, 'VALIDATION_ERROR',
        `Manual control of ${device.device_type} devices is not supported yet (K1 supports lighting with the switch control)`, 'device_id');
    }
    device.override = command.kind === 'set' ? { on: command.on } : null; // clear => base state (temporary, pre-schedule layer)
    this.run.seq++;
    this.writeCheckpoint();
    return {
      device_id: device.device_id,
      override: device.override ? { active: true, on: device.override.on } : null,
      seq: this.run.seq,
      sim_time_utc: toUtc(this.run.simEpoch),
    };
  }

  // ------------------------------------------------------- deterministic core

  /** Processes n fixed steps. Deterministic; used by the scheduler and by tests. */
  advanceSteps(n: number): void {
    const run = this.run;
    if (!run) throw new EngineError(409, 'CONFLICT', 'No simulation run exists');
    for (let i = 0; i < n; i++) this.stepOnce(run);
  }

  private stepOnce(run: RunRuntime): void {
    const t = run.simEpoch;
    const occupancy = new Map<string, number>();
    for (const room of run.rooms) {
      occupancy.set(room.room_id, room.occupancy);
      const acc = run.partial.rooms[room.room_id]!;
      acc.occupancy_seconds += room.occupancy * STEP_SECONDS;
      acc.occupancy_max = Math.max(acc.occupancy_max, room.occupancy);
      if (room.occupancy > 0) acc.occupied_seconds += STEP_SECONDS;
    }
    for (const d of run.devices) {
      const on = isOn(d);
      const power = powerOf(d, on);
      const energy = (power * STEP_SECONDS) / 3_600_000;
      const acc = run.partial.devices[d.device_id]!;
      acc.energy_kwh += energy;
      acc.power_seconds += power * STEP_SECONDS;
      acc.max_power_w = Math.max(acc.max_power_w, power);
      if (d.override) acc.override_seconds += STEP_SECONDS;
      if (on) {
        acc.on_seconds += STEP_SECONDS;
        if ((occupancy.get(d.room_id) ?? 0) === 0) acc.vacant_on_seconds += STEP_SECONDS;
        if (!d.expectedOn(t)) acc.offschedule_on_seconds += STEP_SECONDS;
      }
      d.cumulative_kwh += energy;
    }
    run.partial.covered_seconds += STEP_SECONDS;
    run.simEpoch += STEP_SECONDS;
    run.seq++;
    if (run.simEpoch % INTERVAL_SECONDS === 0) {
      transaction(this.db, () => {
        this.publishPartial(run, false);
        this.upsertCheckpoint(run, 'active');
      });
    }
  }

  /** Writes the current partial interval as interval rows and starts a fresh accumulator. */
  private publishPartial(run: RunRuntime, partial: boolean): void {
    const p = run.partial;
    if (p.covered_seconds > 0) {
      const start = toUtc(p.start_epoch);
      const end = toUtc(p.start_epoch + p.covered_seconds);
      const covered = p.covered_seconds;
      const roomStmt = this.db.prepare(`INSERT INTO room_intervals (run_id, room_id, interval_start_utc, interval_end_utc,
          interval_seconds, occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const room of run.rooms) {
        const acc = p.rooms[room.room_id]!;
        roomStmt.run(run.run_id, room.room_id, start, end, covered, acc.occupancy_seconds / covered, acc.occupancy_max,
          acc.occupied_seconds / covered, run.environment.avg_temp_c, run.environment.avg_rh_pct, partial ? 1 : 0);
      }
      const devStmt = this.db.prepare(`INSERT INTO device_intervals (run_id, device_id, room_id, interval_start_utc,
          interval_end_utc, interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh, avg_voltage_v,
          avg_current_a, power_factor, on_fraction, override_seconds, vacant_on_seconds, offschedule_on_seconds,
          policy_id, policy_version, partial) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const d of run.devices) {
        const acc = p.devices[d.device_id]!;
        // Average over the actual covered duration; clamp float noise so avg never exceeds max.
        const avg = Math.min(acc.power_seconds / covered, acc.max_power_w);
        devStmt.run(run.run_id, d.device_id, d.room_id, start, end, covered, avg, acc.max_power_w, acc.energy_kwh,
          d.cumulative_kwh, d.power_factor, acc.on_seconds / covered, acc.override_seconds, acc.vacant_on_seconds,
          acc.offschedule_on_seconds, d.policy_id, d.policy_version, partial ? 1 : 0);
      }
    }
    run.partial = this.freshPartial(run, run.simEpoch);
  }

  // ---------------------------------------------------------------- snapshots

  getState(): Record<string, unknown> {
    const run = this.run;
    if (!run) {
      return { status: this.status, speed: this.speed, run_id: null, seq: null, sim_time_utc: null, rooms: [], devices: [], office: null };
    }
    const devices = run.devices.map((d) => {
      const on = isOn(d);
      return {
        device_id: d.device_id, room_id: d.room_id, on, power_w: powerOf(d, on),
        override: d.override ? { active: true, on: d.override.on } : null, energy_kwh: d.cumulative_kwh,
      };
    });
    const rooms = run.rooms.map((r) => {
      const own = devices.filter((d) => d.room_id === r.room_id);
      return {
        room_id: r.room_id, occupancy: r.occupancy,
        power_w: own.reduce((s, d) => s + d.power_w, 0), energy_kwh: own.reduce((s, d) => s + d.energy_kwh, 0),
      };
    });
    return {
      status: this.status,
      speed: this.speed,
      run_id: run.run_id,
      seq: run.seq,
      sim_time_utc: toUtc(run.simEpoch),
      step_seconds: STEP_SECONDS,
      rooms,
      devices,
      office: { power_w: devices.reduce((s, d) => s + d.power_w, 0), energy_kwh: devices.reduce((s, d) => s + d.energy_kwh, 0) },
      partial_interval: { start_utc: toUtc(run.partial.start_epoch), covered_seconds: run.partial.covered_seconds },
    };
  }

  /** Contract health shape: not_initialized until a run exists, then ok with real run/time. */
  health(): Record<string, unknown> {
    if (!this.run) return { status: 'not_initialized', run_id: null, sim_time_utc: null, contract_version: '1.0.1' };
    return { status: 'ok', run_id: this.run.run_id, sim_time_utc: toUtc(this.run.simEpoch), contract_version: '1.0.1' };
  }

  /** Control-route response: { run_id, seq, sim_time_utc } plus lifecycle status and speed. */
  summary(): { run_id: string | null; seq: number | null; sim_time_utc: string | null; status: Lifecycle; speed: Speed } {
    return {
      run_id: this.run?.run_id ?? null,
      seq: this.run?.seq ?? null,
      sim_time_utc: this.run ? toUtc(this.run.simEpoch) : null,
      status: this.status,
      speed: this.speed,
    };
  }

  // ------------------------------------------------------------------ internal

  private goRunning(): void {
    if (this.status === 'running' && this.scheduler.running) return;
    this.status = 'running';
    this.scheduler.start();
    this.run!.seq++;
    this.writeCheckpoint();
  }

  private createNewRun(): RunRuntime {
    const building = this.db.prepare('SELECT building_id FROM buildings ORDER BY building_id LIMIT 1').get() as { building_id: string } | undefined;
    if (!building) throw new EngineError(409, 'CONFLICT', 'Inventory is not seeded; run npm run db:seed');
    const missing = this.db.prepare(`SELECT d.device_id FROM devices d JOIN rooms r ON r.room_id = d.room_id
        WHERE r.building_id = ? AND NOT EXISTS (SELECT 1 FROM current_policy_versions c WHERE c.device_id = d.device_id)`)
      .all(building.building_id) as { device_id: string }[];
    if (missing.length) {
      throw new EngineError(409, 'CONFLICT', `Devices without a policy cannot be simulated: ${missing.map((m) => m.device_id).join(', ')}`);
    }
    const wall = this.wallClock();
    const runId = `run-${utcNow(wall).replace(/[-:]/g, '')}-${randomUUID().slice(0, 8)}`;
    createRun(this.db, {
      run_id: runId, building_id: building.building_id, scenario_id: 'original', run_start_utc: INITIAL_SIM_TIME_UTC,
      config: MANUAL_DEMO_CONFIG as unknown as Record<string, unknown>,
    }, wall);
    const run = this.loadRun(runId, toEpoch(INITIAL_SIM_TIME_UTC), 0, null);
    this.upsertCheckpoint(run, 'active');
    return run;
  }

  /** Builds runtime state from the run's immutable snapshot (+ checkpoint when recovering). */
  private loadRun(runId: string, simEpoch: number, seq: number, state: CheckpointState | null): RunRuntime {
    const cfg = JSON.parse((this.db.prepare('SELECT config FROM simulation_runs WHERE run_id = ?').get(runId) as { config: string }).config) as {
      environment?: { avg_temp_c?: number; avg_rh_pct?: number };
    };
    const rooms = (this.db.prepare('SELECT room_id FROM run_rooms WHERE run_id = ? ORDER BY room_id').all(runId) as { room_id: string }[])
      .map((r) => ({ room_id: r.room_id, occupancy: state?.rooms[r.room_id]?.occupancy ?? 0 }));

    const officeHoursByRef = (ref: string): OfficeHoursRules | null => {
      const m = /^(.+):(\d+)$/.exec(ref);
      if (!m) return null;
      const row = this.db.prepare('SELECT rules FROM policy_versions WHERE policy_id = ? AND version = ?').get(m[1]!, Number(m[2])) as { rules: string } | undefined;
      return row ? (JSON.parse(row.rules) as OfficeHoursRules) : null;
    };
    const runOfficeHours = this.db.prepare(`SELECT pv.rules FROM run_policies rp
        JOIN policies p ON p.policy_id = rp.policy_id
        JOIN policy_versions pv ON pv.policy_id = rp.policy_id AND pv.version = rp.version
        WHERE rp.run_id = ? AND p.kind = 'office_hours' ORDER BY rp.version DESC LIMIT 1`).get(runId) as { rules: string } | undefined;
    const resolveOfficeHours = (ref: string | null): OfficeHoursRules | null =>
      (ref ? officeHoursByRef(ref) : runOfficeHours ? (JSON.parse(runOfficeHours.rules) as OfficeHoursRules) : null);

    const policyFor = this.db.prepare(`SELECT rp.policy_id, rp.version, p.kind, pv.rules FROM run_policies rp
        JOIN policies p ON p.policy_id = rp.policy_id
        JOIN policy_versions pv ON pv.policy_id = rp.policy_id AND pv.version = rp.version
        WHERE rp.run_id = ? AND p.device_id = ? ORDER BY rp.version DESC LIMIT 1`);
    const deviceRows = this.db.prepare(`SELECT device_id, room_id, device_type, controls, nominal_power_w, standby_power_w,
        power_factor, always_on, control FROM run_devices WHERE run_id = ? ORDER BY device_id`).all(runId) as {
      device_id: string; room_id: string; device_type: string; controls: string; nominal_power_w: number;
      standby_power_w: number | null; power_factor: number; always_on: number; control: string;
    }[];

    const devices = deviceRows.map((d): DeviceRuntime => {
      const pol = policyFor.get(runId, d.device_id) as { policy_id: string; version: number; kind: string; rules: string } | undefined;
      if (!pol) throw new EngineError(409, 'CONFLICT', `Run ${runId} has no pinned policy for ${d.device_id}`);
      const alwaysOn = d.always_on === 1 || d.control === 'always_on';
      const saved = state?.devices[d.device_id];
      return {
        device_id: d.device_id, room_id: d.room_id, device_type: d.device_type, controls: JSON.parse(d.controls) as string[],
        nominal_power_w: d.nominal_power_w, standby_power_w: d.standby_power_w, power_factor: d.power_factor,
        always_on: alwaysOn, policy_id: pol.policy_id, policy_version: pol.version,
        expectedOn: scheduleWindowFor(pol.kind, JSON.parse(pol.rules) as Record<string, unknown>, resolveOfficeHours),
        base_on: saved?.base_on ?? alwaysOn,
        override: saved?.override ?? null,
        cumulative_kwh: saved?.cumulative_kwh ?? 0,
      };
    });

    const run: RunRuntime = {
      run_id: runId, simEpoch, seq, devices, rooms,
      environment: {
        avg_temp_c: cfg.environment?.avg_temp_c ?? MANUAL_DEMO_CONFIG.environment.avg_temp_c,
        avg_rh_pct: cfg.environment?.avg_rh_pct ?? MANUAL_DEMO_CONFIG.environment.avg_rh_pct,
      },
      partial: { start_epoch: simEpoch, covered_seconds: 0, devices: {}, rooms: {} },
    };
    run.partial = state?.partial ?? this.freshPartial(run, simEpoch);
    return run;
  }

  private freshPartial(run: Pick<RunRuntime, 'devices' | 'rooms'>, startEpoch: number): PartialInterval {
    return {
      start_epoch: startEpoch,
      covered_seconds: 0,
      devices: Object.fromEntries(run.devices.map((d) => [d.device_id, emptyDeviceAcc()])),
      rooms: Object.fromEntries(run.rooms.map((r) => [r.room_id, { occupancy_seconds: 0, occupancy_max: 0, occupied_seconds: 0 }])),
    };
  }

  private writeCheckpoint(): void {
    if (this.run) this.upsertCheckpoint(this.run, 'active');
  }

  private upsertCheckpoint(run: RunRuntime, lifecycle: 'active' | 'ended'): void {
    const state: CheckpointState = {
      devices: Object.fromEntries(run.devices.map((d) => [d.device_id, { base_on: d.base_on, override: d.override, cumulative_kwh: d.cumulative_kwh }])),
      rooms: Object.fromEntries(run.rooms.map((r) => [r.room_id, { occupancy: r.occupancy }])),
      partial: run.partial,
    };
    this.db.prepare(`INSERT INTO engine_checkpoints (run_id, lifecycle, seq, sim_time_utc, speed, state, updated_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (run_id) DO UPDATE SET lifecycle = excluded.lifecycle, seq = excluded.seq,
          sim_time_utc = excluded.sim_time_utc, speed = excluded.speed, state = excluded.state, updated_utc = excluded.updated_utc`)
      .run(run.run_id, lifecycle, run.seq, toUtc(run.simEpoch), this.speed, JSON.stringify(state), utcNow(this.wallClock()));
  }
}
