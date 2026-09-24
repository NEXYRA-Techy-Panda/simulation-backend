import { createHash, randomInt, randomUUID } from 'node:crypto';
import { utcNow } from '../db/clock.js';
import { type Database, transaction } from '../db/connection.js';
import { addPolicyVersion } from '../db/inventory.js';
import { createRun } from '../db/runs.js';
import { ApiError } from '../http/errors.js';
import {
  DEFAULT_SPEED, INITIAL_SIM_TIME_UTC, INTERVAL_SECONDS, RUN_CONFIG, type Speed, STEP_SECONDS, isSpeed,
} from './constants.js';
import { MAX_OCCUPANTS, OccupancyModel, type OccupancyMode, type OccupancyState } from './occupancy.js';
import { isSeed } from './rng.js';
import { type OfficeHoursRules, type ScheduleWindow, kolkataLocal, officeHoursWindow, scheduleWindowFor } from './schedule.js';
import { type SchedulerDeps, type SchedulerOptions, WallClockScheduler } from './scheduler.js';

export type Lifecycle = 'not_initialized' | 'paused' | 'running';

/** Lifecycle/command errors carry their contract status and code. */
export class EngineError extends ApiError {}

export type DeviceCommand = { kind: 'set'; on: boolean } | { kind: 'clear' };

export interface OccupancyCommand {
  mode: unknown;
  total?: unknown;
  target?: unknown;
}

export interface CalendarCommand {
  working_days: unknown;
  open_local: unknown;
  close_local: unknown;
  overnight?: unknown;
}

interface PolicyRef {
  policy_id: string;
  version: number;
}

interface DevicePolicy extends PolicyRef {
  kind: string;
  /** When the schedule permits automatic operation (and measures off-schedule time). */
  permitted: ScheduleWindow;
  grace_seconds: number;
  allow_manual_override: boolean;
}

interface DeviceRuntime {
  device_id: string;
  room_id: string;
  device_type: string;
  control: string;
  controls: string[];
  nominal_power_w: number;
  standby_power_w: number | null;
  power_factor: number;
  policy: DevicePolicy;
  /** Manual override; persists until cleared. */
  override: { on: boolean } | null;
  /** Run-relative cumulative energy, unrounded. */
  cumulative_kwh: number;
}

interface RoomRuntime {
  room_id: string;
  room_type: string;
  capacity: number;
  occupancy: number;
  /** Simulated epoch when the room last became vacant (grace start); null while occupied or never occupied. */
  vacant_since: number | null;
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

/** Policy versions created at runtime, applied to the run at effective_epoch (a minute boundary). */
interface PendingChange {
  kind: 'calendar';
  effective_epoch: number;
  refs: PolicyRef[];
}

interface CheckpointState {
  format?: 2;
  devices: Record<string, { override: { on: boolean } | null; cumulative_kwh: number; base_on?: boolean }>;
  rooms: Record<string, { occupancy: number; vacant_since?: number | null }>;
  occupancy?: OccupancyState;
  pending?: PendingChange[];
  partial: PartialInterval;
}

interface RunRuntime {
  run_id: string;
  simEpoch: number;
  seq: number;
  devices: DeviceRuntime[];
  rooms: RoomRuntime[];
  environment: { avg_temp_c: number; avg_rh_pct: number };
  partial: PartialInterval;
  occupancy: OccupancyModel;
  officeHours: (PolicyRef & { rules: OfficeHoursRules }) | null;
  occupancyPolicy: PolicyRef | null;
  pending: PendingChange[];
}

export interface EngineOptions {
  schedulerDeps?: SchedulerDeps;
  scheduler?: SchedulerOptions;
  /** Wall-clock source for record bookkeeping (created_utc etc.). */
  wallClock?: () => Date;
}

const toEpoch = (utc: string): number => Date.parse(utc) / 1000;
const toUtc = (epoch: number): string => new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const refString = (r: PolicyRef): string => `${r.policy_id}:${r.version}`;
const powerOf = (d: DeviceRuntime, on: boolean): number => (on ? d.nominal_power_w : (d.standby_power_w ?? 0));
const nextMinute = (epoch: number): number => Math.ceil(epoch / INTERVAL_SECONDS) * INTERVAL_SECONDS;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const emptyDeviceAcc = (): DeviceAcc => ({
  energy_kwh: 0, power_seconds: 0, max_power_w: 0, on_seconds: 0, override_seconds: 0, vacant_on_seconds: 0, offschedule_on_seconds: 0,
});

/**
 * Backend-authoritative simulation engine. All simulated time advances
 * through advanceSteps(), which is deterministic and independent of wall
 * time; the WallClockScheduler only decides how many steps are owed.
 * K3–K4: seeded occupancy allocation + policy-driven device control.
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
    this.run = this.loadRun(row.run_id, toEpoch(row.sim_time_utc), row.seq, JSON.parse(row.state) as CheckpointState);
    this.speed = isSpeed(row.speed) ? row.speed : DEFAULT_SPEED;
    this.scheduler.setSpeed(this.speed);
    this.status = 'paused';
    return { run_id: row.run_id, sim_time_utc: row.sim_time_utc, seq: row.seq };
  }

  /** not_initialized → new run, running; paused → running; running → no-op (no second timer). */
  start(speed?: unknown, seed?: unknown): void {
    if (seed !== undefined && this.run) {
      throw new EngineError(409, 'CONFLICT', 'seed only applies when a run is created; use reset with a seed', 'seed');
    }
    const checkedSeed = this.checkSeed(seed);
    if (speed !== undefined) this.setSpeed(speed);
    if (!this.run) this.run = this.createNewRun(checkedSeed);
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
  reset(seed?: unknown): void {
    const checkedSeed = this.checkSeed(seed);
    this.scheduler.stop();
    if (this.run) {
      const run = this.run;
      transaction(this.db, () => {
        this.publishPartial(run, true);
        this.upsertCheckpoint(run, 'ended');
      });
    }
    this.run = this.createNewRun(checkedSeed);
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

  // ------------------------------------------------------------------ commands

  /**
   * Manual override at the current processed step boundary (sim_time_utc):
   * affects subsequent steps only. Persists until cleared; clearing returns
   * the device to its current policy immediately. Any device with the
   * "switch" control whose policy allows manual override.
   */
  commandDevice(deviceId: string, command: DeviceCommand): Record<string, unknown> {
    const run = this.requireRun();
    const device = run.devices.find((d) => d.device_id === deviceId);
    if (!device) throw new EngineError(404, 'NOT_FOUND', `Device "${deviceId}" is not part of the current run`);
    if (!device.controls.includes('switch') || device.policy.kind === 'always_on' || !device.policy.allow_manual_override) {
      throw new EngineError(400, 'VALIDATION_ERROR',
        `Device "${deviceId}" does not accept manual switching (no switch control, always-on exception, or overrides disallowed by policy)`, 'device_id');
    }
    device.override = command.kind === 'set' ? { on: command.on } : null;
    run.seq++;
    this.writeCheckpoint();
    const on = this.isOn(run, device, run.simEpoch);
    return {
      device_id: device.device_id,
      override: device.override ? { active: true, on: device.override.on } : null,
      seq: run.seq,
      sim_time_utc: toUtc(run.simEpoch),
      on,
      control_source: device.override ? 'override' : 'policy',
    };
  }

  /**
   * POST /api/v1/occupancy. manual: {mode:"manual", total}; scheduled:
   * {mode:"scheduled", target?}. Applied at the current step boundary. A
   * mode change also appends an immutable occupancy-policy version.
   */
  setOccupancy(cmd: OccupancyCommand): Record<string, unknown> {
    const run = this.requireRun();
    const mode = cmd.mode;
    if (mode !== 'manual' && mode !== 'scheduled') {
      throw new EngineError(400, 'VALIDATION_ERROR', 'mode must be "manual" or "scheduled"', 'mode');
    }
    if (mode === 'manual' && cmd.target !== undefined) {
      throw new EngineError(400, 'VALIDATION_ERROR', 'target applies to scheduled mode; use total for manual mode', 'target');
    }
    if (mode === 'scheduled' && cmd.total !== undefined) {
      throw new EngineError(400, 'VALIDATION_ERROR', 'total applies to manual mode; use target for scheduled mode', 'total');
    }
    if (mode === 'manual' && cmd.total === undefined) {
      throw new EngineError(400, 'VALIDATION_ERROR', 'total is required in manual mode', 'total');
    }
    const count = mode === 'manual'
      ? run.occupancy.checkCount(cmd.total, 'total')
      : cmd.target === undefined ? run.occupancy.state.scheduled_target : run.occupancy.checkCount(cmd.target, 'target');

    let policyRef: string | null = null;
    transaction(this.db, () => {
      if (mode !== run.occupancy.mode && run.occupancyPolicy) {
        const version = addPolicyVersion(this.db, {
          policy_id: run.occupancyPolicy.policy_id, effective_from_utc: toUtc(run.simEpoch), rules: { mode, auto_allocate: true },
        }, this.wallClock());
        const ref = { policy_id: run.occupancyPolicy.policy_id, version };
        this.pin(run, [ref], run.simEpoch);
        run.occupancyPolicy = ref;
        policyRef = refString(ref);
      }
      if (mode === 'manual') run.occupancy.setManual(count);
      else run.occupancy.setScheduled(count);
      this.reconcile(run);
      run.seq++;
      this.upsertCheckpoint(run, 'active');
    });
    return {
      allocation: run.rooms.map((r) => ({ room_id: r.room_id, count: r.occupancy })),
      mode,
      office_count: run.occupancy.officeCount,
      ...(mode === 'manual' ? { total: count } : { target: count }),
      effective_sim_utc: toUtc(run.simEpoch),
      occupancy_policy_ref: policyRef,
      seq: run.seq,
    };
  }

  /**
   * POST /api/v1/calendar. Creates a new immutable office-hours version and
   * new versions of every device_schedule that references that office-hours
   * policy, effective at the NEXT minute boundary (or now if the run is
   * exactly on one), so every persisted interval has one policy reference.
   */
  setCalendar(cmd: CalendarCommand): Record<string, unknown> {
    const run = this.requireRun();
    const rules = validateCalendar(cmd);
    if (!run.officeHours) throw new EngineError(409, 'CONFLICT', 'The current run has no office_hours policy to update');
    const ohId = run.officeHours.policy_id;
    const effective = nextMinute(run.simEpoch);
    const effectiveUtc = toUtc(effective);
    const wall = this.wallClock();

    const refs: PolicyRef[] = [];
    transaction(this.db, () => {
      const ohVersion = addPolicyVersion(this.db, { policy_id: ohId, effective_from_utc: effectiveUtc, rules: { ...rules } }, wall);
      refs.push({ policy_id: ohId, version: ohVersion });
      const schedules = this.db.prepare(`SELECT policy_id, rules FROM current_policy_versions
          WHERE kind = 'device_schedule' ORDER BY policy_id`).all() as { policy_id: string; rules: string }[];
      for (const s of schedules) {
        const r = JSON.parse(s.rules) as Record<string, unknown>;
        if (typeof r.office_hours_ref !== 'string' || !r.office_hours_ref.startsWith(`${ohId}:`)) continue;
        const version = addPolicyVersion(this.db, {
          policy_id: s.policy_id, effective_from_utc: effectiveUtc, rules: { ...r, office_hours_ref: `${ohId}:${ohVersion}` },
        }, wall);
        refs.push({ policy_id: s.policy_id, version });
      }
      run.pending.push({ kind: 'calendar', effective_epoch: effective, refs });
      if (effective === run.simEpoch) {
        this.applyDuePending(run);
        this.reconcile(run);
      }
      run.seq++;
      this.upsertCheckpoint(run, 'active');
    });
    return {
      policy_refs: refs.map(refString),
      effective_sim_utc: effectiveUtc,
      applied: effective === run.simEpoch,
      calendar: { working_days: rules.working_days_iso, open_local: rules.open_local, close_local: rules.close_local, overnight: rules.overnight },
      seq: run.seq,
    };
  }

  // ------------------------------------------------------- deterministic core

  /** Processes n fixed steps. Deterministic; used by the scheduler and by tests. */
  advanceSteps(n: number): void {
    const run = this.requireRun();
    for (let i = 0; i < n; i++) this.stepOnce(run);
  }

  private stepOnce(run: RunRuntime): void {
    const t = run.simEpoch;
    for (const room of run.rooms) {
      const acc = run.partial.rooms[room.room_id]!;
      acc.occupancy_seconds += room.occupancy * STEP_SECONDS;
      acc.occupancy_max = Math.max(acc.occupancy_max, room.occupancy);
      if (room.occupancy > 0) acc.occupied_seconds += STEP_SECONDS;
    }
    for (const d of run.devices) {
      const on = this.isOn(run, d, t);
      const power = powerOf(d, on);
      const energy = (power * STEP_SECONDS) / 3_600_000;
      const acc = run.partial.devices[d.device_id]!;
      acc.energy_kwh += energy;
      acc.power_seconds += power * STEP_SECONDS;
      acc.max_power_w = Math.max(acc.max_power_w, power);
      if (d.override) acc.override_seconds += STEP_SECONDS;
      if (on) {
        acc.on_seconds += STEP_SECONDS;
        if (this.room(run, d.room_id).occupancy === 0) acc.vacant_on_seconds += STEP_SECONDS;
        if (!d.policy.permitted(t)) acc.offschedule_on_seconds += STEP_SECONDS;
      }
      d.cumulative_kwh += energy;
    }
    run.partial.covered_seconds += STEP_SECONDS;
    run.simEpoch += STEP_SECONDS;
    run.seq++;
    if (run.simEpoch % INTERVAL_SECONDS === 0) {
      // Minute boundary: publish the completed minute (old policy refs), then
      // apply due policy changes, then occupancy for the new time — atomically.
      transaction(this.db, () => {
        this.publishPartial(run, false);
        this.applyDuePending(run);
        this.reconcile(run);
        this.upsertCheckpoint(run, 'active');
      });
    } else {
      this.reconcile(run);
    }
  }

  /** Automatic (policy) state of a device at step start t. */
  private autoOn(run: RunRuntime, d: DeviceRuntime, t: number): boolean {
    if (d.policy.kind === 'always_on') return true;
    if (d.control !== 'scheduled') return false; // manual-control devices run only by override
    if (d.policy.kind !== 'lighting_schedule' && d.policy.kind !== 'device_schedule') return false;
    if (!d.policy.permitted(t)) return false; // schedule closing ends automatic operation, even in grace
    const room = this.room(run, d.room_id);
    if (room.occupancy > 0) return true;
    return room.vacant_since !== null && t - room.vacant_since < d.policy.grace_seconds;
  }

  private isOn(run: RunRuntime, d: DeviceRuntime, t: number): boolean {
    return d.override ? d.override.on : this.autoOn(run, d, t);
  }

  private room(run: RunRuntime, roomId: string): RoomRuntime {
    return run.rooms.find((r) => r.room_id === roomId)!;
  }

  /** Occupancy for the step starting at run.simEpoch; updates vacancy (grace) timestamps. */
  private reconcile(run: RunRuntime): void {
    const t = run.simEpoch;
    run.occupancy.reconcile(officeHoursWindow(run.officeHours?.rules ?? null)(t), kolkataLocal(t).minute);
    const counts = run.occupancy.counts();
    for (const room of run.rooms) {
      const next = counts.get(room.room_id) ?? 0;
      if (next === 0 && room.occupancy > 0) room.vacant_since = t;
      if (next > 0) room.vacant_since = null;
      room.occupancy = next;
    }
  }

  /** Pins every due pending change to the run and rebuilds runtime policies. */
  private applyDuePending(run: RunRuntime): void {
    const due = run.pending.filter((p) => p.effective_epoch <= run.simEpoch);
    if (!due.length) return;
    run.pending = run.pending.filter((p) => p.effective_epoch > run.simEpoch);
    // Each change activates on its own boundary, so a run-scoped activation is
    // recorded per change rather than for the batch as a whole.
    for (const p of due) this.pin(run, p.refs, p.effective_epoch);
    this.rebuildPolicies(run);
  }

  /**
   * Adds versions to the run's pinned set with their run-scoped activation
   * (idempotent; snapshot rows are never changed, and the FIRST activation
   * recorded for a pin wins — ON CONFLICT DO NOTHING).
   */
  private pin(run: RunRuntime, refs: PolicyRef[], activeFromEpoch: number): void {
    const relevant = new Set([
      ...run.devices.map((d) => d.policy.policy_id),
      ...(run.officeHours ? [run.officeHours.policy_id] : []),
      ...(run.occupancyPolicy ? [run.occupancyPolicy.policy_id] : []),
    ]);
    const stmt = this.db.prepare(`INSERT INTO run_policies (run_id, policy_id, version, active_from_utc)
        VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`);
    const activeFromUtc = toUtc(activeFromEpoch);
    for (const r of refs) if (relevant.has(r.policy_id)) stmt.run(run.run_id, r.policy_id, r.version, activeFromUtc);
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
          acc.offschedule_on_seconds, d.policy.policy_id, d.policy.version, partial ? 1 : 0);
      }
    }
    run.partial = this.freshPartial(run, run.simEpoch);
  }

  // ---------------------------------------------------------------- snapshots

  getState(): Record<string, unknown> {
    const run = this.run;
    if (!run) {
      return {
        status: this.status, speed: this.speed, run_id: null, seq: null, sim_time_utc: null, rooms: [], devices: [],
        office: null, occupancy: null, calendar: null, overrides: [], pending_changes: [],
      };
    }
    const t = run.simEpoch;
    const devices = run.devices.map((d) => {
      const on = this.isOn(run, d, t);
      return {
        device_id: d.device_id, room_id: d.room_id, on, power_w: powerOf(d, on),
        control_source: d.override ? 'override' : 'policy',
        override: d.override ? { active: true, on: d.override.on } : null,
        policy_ref: refString(d.policy),
        energy_kwh: d.cumulative_kwh,
      };
    });
    const rooms = run.rooms.map((r) => {
      const own = devices.filter((d) => d.room_id === r.room_id);
      return {
        room_id: r.room_id, occupancy: r.occupancy, capacity: r.capacity,
        power_w: own.reduce((s, d) => s + d.power_w, 0), energy_kwh: own.reduce((s, d) => s + d.energy_kwh, 0),
      };
    });
    const occ = run.occupancy.state;
    const oh = run.officeHours;
    return {
      status: this.status,
      speed: this.speed,
      run_id: run.run_id,
      seq: run.seq,
      sim_time_utc: toUtc(t),
      step_seconds: STEP_SECONDS,
      rooms,
      devices,
      office: {
        occupancy: run.occupancy.officeCount,
        power_w: devices.reduce((s, d) => s + d.power_w, 0),
        energy_kwh: devices.reduce((s, d) => s + d.energy_kwh, 0),
      },
      occupancy: {
        mode: occ.mode,
        office_count: run.occupancy.officeCount,
        manual_total: occ.manual_total,
        scheduled_target: occ.scheduled_target,
        max_total: MAX_OCCUPANTS,
        capacity_total: run.occupancy.capacityTotal,
        seed: occ.seed,
        occupants: occ.occupants.map((o) => ({ occupant_id: o.occupant_id, room_id: o.room_id, home_room_id: o.home_room_id })),
        redistribution: occ.redistribution,
        policy_ref: run.occupancyPolicy ? refString(run.occupancyPolicy) : null,
      },
      calendar: oh
        ? {
          policy_ref: refString(oh), working_days: oh.rules.working_days_iso, open_local: oh.rules.open_local,
          close_local: oh.rules.close_local, overnight: oh.rules.overnight, timezone: 'Asia/Kolkata',
          open_now: officeHoursWindow(oh.rules)(t),
        }
        : null,
      overrides: run.devices.filter((d) => d.override).map((d) => ({ device_id: d.device_id, on: d.override!.on })),
      pending_changes: run.pending.map((p) => ({ kind: p.kind, effective_sim_utc: toUtc(p.effective_epoch), policy_refs: p.refs.map(refString) })),
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

  private requireRun(): RunRuntime {
    if (!this.run) throw new EngineError(409, 'CONFLICT', 'No simulation run exists; start or reset first');
    return this.run;
  }

  private checkSeed(seed: unknown): number | undefined {
    if (seed === undefined) return undefined;
    if (!isSeed(seed)) throw new EngineError(400, 'VALIDATION_ERROR', 'seed must be an integer from 0 to 4294967295', 'seed');
    return seed;
  }

  private goRunning(): void {
    if (this.status === 'running' && this.scheduler.running) return;
    this.status = 'running';
    this.scheduler.start();
    this.run!.seq++;
    this.writeCheckpoint();
  }

  private createNewRun(seed?: number): RunRuntime {
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
    const occupancySeed = seed ?? randomInt(0, 0x100000000);
    createRun(this.db, {
      run_id: runId, building_id: building.building_id, scenario_id: 'original', run_start_utc: INITIAL_SIM_TIME_UTC,
      config: { ...RUN_CONFIG, occupancy_seed: occupancySeed } as unknown as Record<string, unknown>,
    }, wall);
    const run = this.loadRun(runId, toEpoch(INITIAL_SIM_TIME_UTC), 0, null);
    this.reconcile(run);
    this.upsertCheckpoint(run, 'active');
    return run;
  }

  /** Builds runtime state from the run's immutable snapshot + pinned policies (+ checkpoint when recovering). */
  private loadRun(runId: string, simEpoch: number, seq: number, state: CheckpointState | null): RunRuntime {
    const cfg = JSON.parse((this.db.prepare('SELECT config FROM simulation_runs WHERE run_id = ?').get(runId) as { config: string }).config) as {
      environment?: { avg_temp_c?: number; avg_rh_pct?: number };
      occupancy_seed?: number;
    };
    const rooms = (this.db.prepare('SELECT room_id, room_type, capacity FROM run_rooms WHERE run_id = ? ORDER BY room_id').all(runId) as {
      room_id: string; room_type: string; capacity: number;
    }[]).map((r): RoomRuntime => ({
      ...r, occupancy: state?.rooms[r.room_id]?.occupancy ?? 0, vacant_since: state?.rooms[r.room_id]?.vacant_since ?? null,
    }));
    const deviceRows = this.db.prepare(`SELECT device_id, room_id, device_type, controls, nominal_power_w, standby_power_w,
        power_factor, control FROM run_devices WHERE run_id = ? ORDER BY device_id`).all(runId) as {
      device_id: string; room_id: string; device_type: string; controls: string; nominal_power_w: number;
      standby_power_w: number | null; power_factor: number; control: string;
    }[];

    const placeholder: DevicePolicy = { policy_id: '', version: 0, kind: '', permitted: () => false, grace_seconds: 0, allow_manual_override: false };
    const run: RunRuntime = {
      run_id: runId, simEpoch, seq, rooms,
      devices: deviceRows.map((d) => ({
        ...d, controls: JSON.parse(d.controls) as string[], policy: placeholder,
        override: state?.devices[d.device_id]?.override ?? null,
        cumulative_kwh: state?.devices[d.device_id]?.cumulative_kwh ?? 0,
      })),
      environment: {
        avg_temp_c: cfg.environment?.avg_temp_c ?? RUN_CONFIG.environment.avg_temp_c,
        avg_rh_pct: cfg.environment?.avg_rh_pct ?? RUN_CONFIG.environment.avg_rh_pct,
      },
      partial: { start_epoch: simEpoch, covered_seconds: 0, devices: {}, rooms: {} },
      occupancy: new OccupancyModel([], OccupancyModel.initial([], 0, 'manual')),
      officeHours: null,
      occupancyPolicy: null,
      pending: state?.pending ?? [],
    };
    this.rebuildPolicies(run);

    // Pre-K3 checkpoints have no occupancy state: start a seeded model (seed derived from run_id for old runs).
    const seed = cfg.occupancy_seed ?? createHash('sha256').update(runId).digest().readUInt32BE(0);
    const occupancyMode = this.pinnedOccupancyMode(run);
    run.occupancy = new OccupancyModel(rooms, state?.occupancy ?? OccupancyModel.initial(rooms, seed, occupancyMode));
    run.partial = state?.partial ?? this.freshPartial(run, simEpoch);
    return run;
  }

  private pinnedOccupancyMode(run: RunRuntime): OccupancyMode {
    if (!run.occupancyPolicy) return 'manual';
    const row = this.db.prepare('SELECT rules FROM policy_versions WHERE policy_id = ? AND version = ?')
      .get(run.occupancyPolicy.policy_id, run.occupancyPolicy.version) as { rules: string } | undefined;
    return (row ? (JSON.parse(row.rules) as { mode?: OccupancyMode }).mode : undefined) ?? 'manual';
  }

  /**
   * Resolves each device's, the office-hours and the occupancy policy from the
   * highest version pinned to the run (a revision is pinned exactly when it
   * activates, so the highest pinned version is the one in force).
   *
   * K002: the run-scoped activation on the pin — not the global revision time —
   * is what makes a revision applicable to this run, and office-hours
   * dependencies resolve to the exact revision pinned in THIS run.
   */
  private rebuildPolicies(run: RunRuntime): void {
    const pinned = this.db.prepare(`SELECT p.policy_id, p.kind, p.device_id, p.building_id, p.room_id, pv.version, pv.rules
        FROM run_policies rp
        JOIN policies p ON p.policy_id = rp.policy_id
        JOIN policy_versions pv ON pv.policy_id = rp.policy_id AND pv.version = rp.version
        WHERE rp.run_id = ? AND rp.version = (SELECT max(version) FROM run_policies x WHERE x.run_id = rp.run_id AND x.policy_id = rp.policy_id)`)
      .all(run.run_id) as { policy_id: string; kind: string; device_id: string | null; version: number; rules: string }[];

    const oh = pinned.find((p) => p.kind === 'office_hours' && p.device_id === null);
    run.officeHours = oh ? { policy_id: oh.policy_id, version: oh.version, rules: JSON.parse(oh.rules) as OfficeHoursRules } : null;
    const occ = pinned.find((p) => p.kind === 'occupancy');
    run.occupancyPolicy = occ ? { policy_id: occ.policy_id, version: occ.version } : null;

    // Office-hours dependencies resolve to the exact revision pinned in THIS
    // run, so device_schedule.office_hours_ref never reaches outside the run's
    // own definitions. Only a ref that is not pinned here (possible solely in a
    // pre-K002 run) falls back to the global revision record.
    const pinnedOfficeHours = new Map<string, OfficeHoursRules>();
    const onRows = this.db.prepare(`SELECT pv.policy_id, pv.version, pv.rules FROM run_policies rp
        JOIN policies p ON p.policy_id = rp.policy_id
        JOIN policy_versions pv ON pv.policy_id = rp.policy_id AND pv.version = rp.version
        WHERE rp.run_id = ? AND p.kind = 'office_hours'`).all(run.run_id) as unknown as {
      policy_id: string; version: number; rules: string;
    }[];
    for (const row of onRows) pinnedOfficeHours.set(`${row.policy_id}:${row.version}`, JSON.parse(row.rules) as OfficeHoursRules);

    const officeHoursByRef = (ref: string): OfficeHoursRules | null => {
      const runScoped = pinnedOfficeHours.get(ref);
      if (runScoped) return runScoped;
      const m = /^(.+):(\d+)$/.exec(ref);
      if (!m) return null;
      const row = this.db.prepare('SELECT rules FROM policy_versions WHERE policy_id = ? AND version = ?').get(m[1]!, Number(m[2])) as { rules: string } | undefined;
      return row ? (JSON.parse(row.rules) as OfficeHoursRules) : null;
    };
    const resolve = (ref: string | null): OfficeHoursRules | null => (ref ? officeHoursByRef(ref) : run.officeHours?.rules ?? null);

    for (const d of run.devices) {
      const p = pinned.find((x) => x.device_id === d.device_id);
      if (!p) throw new EngineError(409, 'CONFLICT', `Run ${run.run_id} has no pinned policy for ${d.device_id}`);
      const rules = JSON.parse(p.rules) as Record<string, unknown>;
      d.policy = {
        policy_id: p.policy_id, version: p.version, kind: p.kind,
        permitted: scheduleWindowFor(p.kind, rules, resolve),
        grace_seconds: typeof rules.vacancy_grace_seconds === 'number' ? rules.vacancy_grace_seconds : p.kind === 'device_schedule' ? 300 : 0,
        allow_manual_override: rules.allow_manual_override !== false,
      };
    }
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
      format: 2,
      devices: Object.fromEntries(run.devices.map((d) => [d.device_id, { override: d.override, cumulative_kwh: d.cumulative_kwh }])),
      rooms: Object.fromEntries(run.rooms.map((r) => [r.room_id, { occupancy: r.occupancy, vacant_since: r.vacant_since }])),
      occupancy: run.occupancy.state,
      pending: run.pending,
      partial: run.partial,
    };
    this.db.prepare(`INSERT INTO engine_checkpoints (run_id, lifecycle, seq, sim_time_utc, speed, state, updated_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (run_id) DO UPDATE SET lifecycle = excluded.lifecycle, seq = excluded.seq,
          sim_time_utc = excluded.sim_time_utc, speed = excluded.speed, state = excluded.state, updated_utc = excluded.updated_utc`)
      .run(run.run_id, lifecycle, run.seq, toUtc(run.simEpoch), this.speed, JSON.stringify(state), utcNow(this.wallClock()));
  }
}

/** Validates the contract calendar body into office_hours rules. open == close is rejected (MVP). */
function validateCalendar(cmd: CalendarCommand): OfficeHoursRules {
  const days = cmd.working_days;
  if (!Array.isArray(days) || days.length === 0 || days.length > 7 || new Set(days).size !== days.length
    || !days.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)) {
    throw new EngineError(400, 'VALIDATION_ERROR', 'working_days must be 1–7 unique ISO weekdays (Mon=1 … Sun=7)', 'working_days');
  }
  for (const field of ['open_local', 'close_local'] as const) {
    if (typeof cmd[field] !== 'string' || !HHMM.test(cmd[field])) {
      throw new EngineError(400, 'VALIDATION_ERROR', `${field} must be HH:MM (00:00–23:59)`, field);
    }
  }
  const open = cmd.open_local as string;
  const close = cmd.close_local as string;
  if (open === close) {
    throw new EngineError(400, 'VALIDATION_ERROR', 'open_local and close_local must differ (zero/24-hour windows are not supported)', 'close_local');
  }
  const overnight = close < open;
  if (cmd.overnight !== undefined && cmd.overnight !== overnight) {
    throw new EngineError(400, 'VALIDATION_ERROR', `overnight must be ${String(overnight)} for ${open}–${close} (overnight iff close_local < open_local)`, 'overnight');
  }
  return { working_days_iso: [...(days as number[])].sort((a, b) => a - b), open_local: open, close_local: close, overnight };
}
