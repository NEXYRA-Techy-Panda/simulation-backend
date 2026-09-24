import { createHash, randomInt, randomUUID } from 'node:crypto';
import { utcNow } from '../db/clock.js';
import { type Database, transaction } from '../db/connection.js';
import { addPolicyVersion } from '../db/inventory.js';
import { createRun } from '../db/runs.js';
import {
  AC_POWER_MODEL_ID, type AcDeviceRating, EnvironmentInputError, acPowerW, type RoomClimateCommand,
  validateRoomClimateCommand,
} from '../environment/index.js';
import { ApiError } from '../http/errors.js';
import {
  DEFAULT_RECORDING_INTERVAL, DEFAULT_SPEED, INITIAL_SIM_TIME_UTC, INTERVAL_SECONDS, RUN_CONFIG, type RecordingInterval,
  type Speed, STEP_SECONDS, isRecordInterval, isSpeed,
} from './constants.js';
import { AdvanceDaysController, type AdvanceProgress } from './advance-days.js';
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

/** POST /api/v1/environment: the contract's closed fields (room_id, temp_c, rh_pct), all required. */
export interface EnvironmentCommand {
  room_id: unknown;
  temp_c: unknown;
  rh_pct: unknown;
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
  /** Member count; recorded for information only and never multiplied into power. */
  quantity: number;
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
  /**
   * Prescribed EXTERNAL room climate (K004-PREP2), not a simulated thermal
   * state. null only on a legacy run whose immutable configuration predates
   * the environment model: such a run keeps the flat-rated power model and the
   * old constant run-level climate readings.
   */
  climate: { temp_c: number; rh_pct: number } | null;
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
  /** Duration-weighted climate accumulators (temperature x seconds, RH x seconds). */
  temp_seconds: number;
  rh_seconds: number;
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
  rooms: Record<string, { occupancy: number; vacant_since?: number | null; climate?: { temp_c: number; rh_pct: number } | null }>;
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
  /** Configured run-level climate: the INITIAL per-room climate, not a reading or a summary. */
  environment: { avg_temp_c: number; avg_rh_pct: number };
  /** Published interval length in simulated seconds (K004-FAST1); immutable per run. */
  intervalSeconds: number;
  /** AC power model id recorded in the immutable run configuration; null = legacy flat model. */
  acPowerModelId: string | null;
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
  /** K004-FAST1: single day-advance controller (one interactive run, one runner). */
  readonly advance: AdvanceDaysController;
  /** Recording interval applied to the NEXT created run; always the default otherwise. */
  private pendingRecordingInterval: RecordingInterval = DEFAULT_RECORDING_INTERVAL;

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
    this.advance = new AdvanceDaysController({
      getRunEpochSeconds: () => (this.run ? { run_id: this.run.run_id, simEpoch: this.run.simEpoch } : null),
      advanceSteps: (n) => this.advanceSteps(n),
      pause: () => this.pause(),
      simTimeUtc: () => (this.run ? toUtc(this.run.simEpoch) : null),
    });
  }

  // ---------------------------------------------------------------- lifecycle

  get lifecycle(): Lifecycle {
    return this.status;
  }

  get currentSpeed(): Speed {
    return this.speed;
  }

  /**
   * K004-FAST1: opts the NEXT created run into hourly (3600 s) published
   * intervals. Existing runs are never changed: the interval is part of each
   * run's immutable configuration, legacy runs default to one minute, and a
   * run's resolution is never switched midway.
   */
  setRecordingIntervalForNextRun(interval: unknown): void {
    if (!isRecordInterval(interval)) {
      throw new EngineError(400, 'VALIDATION_ERROR', 'interval_seconds must be 60 or 3600', 'interval_seconds');
    }
    this.pendingRecordingInterval = interval;
  }

  /** The recording interval that the next created run will use. */
  get nextRecordingInterval(): RecordingInterval {
    return this.pendingRecordingInterval;
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

  /**
   * Starts the authoritative day-advance loop. Explicitly conflicts with the
   * regular wall-clock scheduler: the advance is the runner while active, so a
   * resume/start during an active advance is rejected rather than creating a
   * competing timer for the same interactive run.
   */
  resume(speed?: unknown): void {
    if (!this.run) throw new EngineError(409, 'CONFLICT', 'No simulation run exists; use start');
    if (this.advance.active) {
      throw new EngineError(409, 'CONFLICT', 'A day advance is active; stop it before resuming regular speed (POST /api/v1/control/advance-stop)');
    }
    if (speed !== undefined) this.setSpeed(speed);
    this.goRunning();
  }

  /** running → paused (freezes at the last processed step); paused → no-op; no run → 409. */
  pause(): void {
    if (!this.run) throw new EngineError(409, 'CONFLICT', 'No simulation run exists');
    if (this.advance.active) this.advance.requestStop();
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
    if (this.advance.active) {
      throw new EngineError(409, 'CONFLICT',
        'A day advance is active; stop it before resetting (POST /api/v1/control/advance-stop). Reset never runs as a side effect of an active advance.');
    }
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
    if (this.advance.active) {
      throw new EngineError(409, 'CONFLICT', 'A day advance is active; speed commands are rejected until it completes or is stopped');
    }
    if (speed === this.speed) return;
    this.scheduler.setSpeed(speed);
    this.speed = speed;
    if (this.run) {
      this.run.seq++;
      this.writeCheckpoint();
    }
  }

  /** Starts the authoritative day-advance run loop; conflicts surface as 409/400 envelopes. */
  beginAdvanceDays(days: unknown): Promise<AdvanceProgress> {
    this.requireRun();
    this.advance.requestStop(); // an explicit new advance always supersedes a stale stop flag
    return this.advance.begin(days);
  }

  /** Synchronous stop request for an active advance (freezes at the next chunk boundary). */
  stopAdvance(): void {
    this.advance.requestStop();
  }

  /** Progress snapshot computed from processed simulated time, or null without a run. */
  advanceProgress(): AdvanceProgress | null {
    if (!this.run) return null;
    return this.advance.progress();
  }

  /** True while a day advance owns the run loop. */
  get advanceActive(): boolean {
    return this.advance.active;
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

  /**
   * POST /api/v1/environment (contract fields `room_id`, `temp_c`, `rh_pct` —
   * all required, no extra fields). Prescribes the ROOM climate the AC power
   * model reads; it is an external input, not a modelled thermal state.
   *
   * Validation happens before any mutation, so an invalid command leaves
   * climate, seq, checkpoint and readings exactly as they were. The value
   * applies from the NEXT simulated step (the step starting at
   * `sim_time_utc`): the seconds already accumulated in the partial minute keep
   * their previous climate and the minute is published duration-weighted. A
   * paused run therefore accepts a climate change without advancing time or
   * energy, and no completed reading is ever rewritten.
   */
  setEnvironment(cmd: EnvironmentCommand): Record<string, unknown> {
    const run = this.requireRun();
    let reading: RoomClimateCommand;
    try {
      reading = validateRoomClimateCommand({ room_id: cmd.room_id, temp_c: cmd.temp_c, rh_pct: cmd.rh_pct });
    } catch (err) {
      if (err instanceof EnvironmentInputError) throw new EngineError(400, 'VALIDATION_ERROR', err.message, err.field);
      throw err;
    }
    const room = run.rooms.find((r) => r.room_id === reading.room_id);
    if (!room) {
      throw new EngineError(404, 'NOT_FOUND', `Room "${reading.room_id}" is not part of the current run`, 'room_id');
    }
    if (run.acPowerModelId !== AC_POWER_MODEL_ID) {
      throw new EngineError(409, 'CONFLICT',
        'This run predates the environment model and keeps its flat-rated power semantics; reset to create an environment-capable run',
        'room_id');
    }
    room.climate = { temp_c: reading.temp_c, rh_pct: reading.rh_pct };
    run.seq++;
    this.writeCheckpoint();
    return {
      room_id: room.room_id,
      seq: run.seq,
      temp_c: room.climate.temp_c,
      rh_pct: room.climate.rh_pct,
      sim_time_utc: toUtc(run.simEpoch),
      applies_from: 'next_step',
    };
  }

  // ------------------------------------------------------- deterministic core

  /**
   * Processes n fixed steps. Deterministic; used by the scheduler, the
   * K004-FAST1 day-advance controller, and tests.
   */
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
      // Duration-weighted climate: a change partway through the minute keeps
      // each segment's own reading, so the published interval describes what
      // actually occurred rather than the final value.
      if (room.climate) {
        acc.temp_seconds += room.climate.temp_c * STEP_SECONDS;
        acc.rh_seconds += room.climate.rh_pct * STEP_SECONDS;
      }
    }
    for (const d of run.devices) {
      const on = this.isOn(run, d, t);
      const power = this.powerFor(run, d, on);
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
    if (run.simEpoch % run.intervalSeconds === 0) {
      // Interval boundary: publish the completed interval (old policy refs), then
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

  /**
   * Power for one simulated step AND for the exposed state; the identical
   * function is used by both, so exposed power always agrees with accumulated
   * energy. Legacy runs (no recorded model id) and every non-AC device keep the
   * flat-rated behaviour: on => nominal_power_w, off => standby_power_w or 0.
   * The refrigerator is never routed through the AC model.
   */
  private powerFor(run: RunRuntime, d: DeviceRuntime, on: boolean): number {
    if (run.acPowerModelId !== AC_POWER_MODEL_ID || d.device_type !== 'ac') return powerOf(d, on);
    const room = this.room(run, d.room_id);
    if (!room.climate) return powerOf(d, on); // defensive: model runs always carry a climate
    const device: AcDeviceRating = {
      device_id: d.device_id,
      device_type: d.device_type,
      quantity: d.quantity,
      nominal_power_w: d.nominal_power_w,
      ...(d.standby_power_w === null ? {} : { standby_power_w: d.standby_power_w }),
    };
    return acPowerW({ device, on, temp_c: room.climate.temp_c, rh_pct: room.climate.rh_pct, occupancy: room.occupancy });
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
        // Per-room climate readings are duration-weighted over the covered
        // seconds (never a copy of the final value). A legacy run has no
        // per-room climate and keeps the run-level constant, exactly as before.
        const tempC = room.climate ? acc.temp_seconds / covered : run.environment.avg_temp_c;
        const rhPct = room.climate ? acc.rh_seconds / covered : run.environment.avg_rh_pct;
        roomStmt.run(run.run_id, room.room_id, start, end, covered, acc.occupancy_seconds / covered, acc.occupancy_max,
          acc.occupied_seconds / covered, tempC, rhPct, partial ? 1 : 0);
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
        device_id: d.device_id, room_id: d.room_id, on, power_w: this.powerFor(run, d, on),
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
        climate: r.climate ? { temp_c: r.climate.temp_c, rh_pct: r.climate.rh_pct } : null,
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
      /** Internal (non-contract) identifier of the AC power model this run uses. */
      ac_power_model: run.acPowerModelId,
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
      /** K004-FAST1: this run's immutable published-interval length (60 s or 3600 s). */
      recording_interval_seconds: run.intervalSeconds,
      /** K004-FAST1 day-advance progress computed from processed simulated time; null when idle. */
      advance: this.advanceProgress(),
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

  /** Runs the simulated clock (regular scheduler) unless a day advance owns it. */
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
      config: {
        ...RUN_CONFIG,
        occupancy_seed: occupancySeed,
        recording: { ...RUN_CONFIG.recording, interval_seconds: this.pendingRecordingInterval },
      } as unknown as Record<string, unknown>,
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
      devices?: { ac_power_model?: string };
      occupancy_seed?: number;
      recording?: { interval_seconds?: unknown };
    };
    // The recorded model id is part of the immutable run configuration: its
    // absence is what makes a persisted pre-integration run legacy.
    const acPowerModelId = cfg.devices?.ac_power_model ?? null;
    // K004-FAST1: the published interval is immutable per run. A stored
    // configuration without a valid `recording.interval_seconds` is a legacy
    // run and keeps the historical one-minute behaviour.
    const recordedInterval = cfg.recording?.interval_seconds;
    const intervalSeconds = isRecordInterval(recordedInterval) ? recordedInterval : DEFAULT_RECORDING_INTERVAL;
    const environment = {
      avg_temp_c: cfg.environment?.avg_temp_c ?? RUN_CONFIG.environment.avg_temp_c,
      avg_rh_pct: cfg.environment?.avg_rh_pct ?? RUN_CONFIG.environment.avg_rh_pct,
    };
    const rooms = (this.db.prepare('SELECT room_id, room_type, capacity FROM run_rooms WHERE run_id = ? ORDER BY room_id').all(runId) as {
      room_id: string; room_type: string; capacity: number;
    }[]).map((r): RoomRuntime => ({
      ...r, occupancy: state?.rooms[r.room_id]?.occupancy ?? 0, vacant_since: state?.rooms[r.room_id]?.vacant_since ?? null,
      climate: state?.rooms[r.room_id]?.climate
        ?? (acPowerModelId ? { temp_c: environment.avg_temp_c, rh_pct: environment.avg_rh_pct } : null),
    }));
    const deviceRows = this.db.prepare(`SELECT device_id, room_id, device_type, controls, quantity, nominal_power_w, standby_power_w,
        power_factor, control FROM run_devices WHERE run_id = ? ORDER BY device_id`).all(runId) as {
      device_id: string; room_id: string; device_type: string; controls: string; quantity: number;
      nominal_power_w: number; standby_power_w: number | null; power_factor: number; control: string;
    }[];

    const placeholder: DevicePolicy = { policy_id: '', version: 0, kind: '', permitted: () => false, grace_seconds: 0, allow_manual_override: false };
    const run: RunRuntime = {
      run_id: runId, simEpoch, seq, rooms,
      devices: deviceRows.map((d) => ({
        ...d, controls: JSON.parse(d.controls) as string[], policy: placeholder,
        override: state?.devices[d.device_id]?.override ?? null,
        cumulative_kwh: state?.devices[d.device_id]?.cumulative_kwh ?? 0,
      })),
      environment,
      intervalSeconds,
      acPowerModelId,
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
    run.partial = this.restorePartial(run, state?.partial, simEpoch);
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
      rooms: Object.fromEntries(run.rooms.map((r) => [r.room_id, {
        occupancy_seconds: 0, occupancy_max: 0, occupied_seconds: 0, temp_seconds: 0, rh_seconds: 0,
      }])),
    };
  }

  /**
   * Restores the partial accumulator, filling in anything a checkpoint written
   * before the environment model did not record (climate seconds = 0, so the
   * remaining covered seconds still weigh correctly). Room climate itself comes
   * from the checkpointed rooms; a missing entry falls back to the configured
   * run climate for model runs and stays null for legacy runs.
   */
  private restorePartial(run: RunRuntime, stored: PartialInterval | undefined, startEpoch: number): PartialInterval {
    if (!stored) return this.freshPartial(run, startEpoch);
    return {
      start_epoch: stored.start_epoch,
      covered_seconds: stored.covered_seconds,
      devices: Object.fromEntries(
        run.devices.map((d) => [d.device_id, { ...emptyDeviceAcc(), ...(stored.devices[d.device_id] ?? {}) }]),
      ),
      rooms: Object.fromEntries(run.rooms.map((r) => {
        const acc = stored.rooms[r.room_id];
        return [r.room_id, {
          occupancy_seconds: acc?.occupancy_seconds ?? 0,
          occupancy_max: acc?.occupancy_max ?? 0,
          occupied_seconds: acc?.occupied_seconds ?? 0,
          temp_seconds: acc?.temp_seconds ?? 0,
          rh_seconds: acc?.rh_seconds ?? 0,
        }];
      })),
    };
  }

  private writeCheckpoint(): void {
    if (this.run) this.upsertCheckpoint(this.run, 'active');
  }

  private upsertCheckpoint(run: RunRuntime, lifecycle: 'active' | 'ended'): void {
    const state: CheckpointState = {
      format: 2,
      devices: Object.fromEntries(run.devices.map((d) => [d.device_id, { override: d.override, cumulative_kwh: d.cumulative_kwh }])),
      rooms: Object.fromEntries(run.rooms.map((r) => [r.room_id, { occupancy: r.occupancy, vacant_since: r.vacant_since, climate: r.climate }])),
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
