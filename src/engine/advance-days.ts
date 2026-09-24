import { ADVANCE_MAX_DAYS, DAY_SECONDS, STEP_SECONDS } from './constants.js';

/**
 * K004-FAST1 day-advance controller.
 *
 * A NARROW wrapper around the existing interactive engine: it only decides how
 * many whole 10-second steps separate the current processed time from the
 * requested target and asks the engine's own deterministic core
 * (`advanceSteps`) to process them in bounded chunks. It never skips
 * calculations, never derives energy from wall-clock intervals, and never
 * touches the display clock: every reported time is the engine's processed
 * `sim_time_utc`.
 *
 * Concurrency contract (single interactive run):
 * - One active advance at most. A second start is rejected as a 409 CONFLICT
 *   (no duplicate runner is ever created).
 * - `requestStop()` is synchronous: the chunk loop observes it after the
 *   current chunk finishes, freezes time/energy at that step and pauses the
 *   run. Completed work is preserved; nothing is reset or erased.
 * - The engine's own lifecycle guard (`goRunning` → scheduler.start() no-op on
 *   an active scheduler, and pause() while status is running) makes a regular
 *   start/pause/resume/speed command during an advance either wait on the same
 *   single-flight lock in the routes or explicitly stop the advance — never a
 *   second concurrent timer. See routes/simulation.ts for the exact conflicts.
 */

/** Lifecycle of one advance request. 'failed' keeps processed time and energy. */
export type AdvanceStatus = 'idle' | 'advancing' | 'failed';

export interface AdvanceProgress {
  run_id: string;
  status: AdvanceStatus;
  /** Whole days requested for this advance. */
  requested_days: number;
  /** Simulated seconds this advance must process (days × 86,400). */
  target_seconds: number;
  /** Simulated seconds processed so far by THIS advance. */
  processed_seconds: number;
  /** Simulated seconds remaining (>= 0). */
  remaining_seconds: number;
  /** Processed/target as a 0..1 fraction, computed from steps actually run. */
  progress: number;
  /** Authoritative processed time of the run (UTC string). */
  processed_sim_time_utc: string;
  /** Real elapsed milliseconds since this advance started (measured, not promised). */
  elapsed_ms: number;
  error: string | null;
}

export interface AdvanceHost {
  /** Authoritative processed time (seconds since epoch) and run identity. */
  getRunEpochSeconds(): { run_id: string; simEpoch: number } | null;
  /** Processes exactly n whole steps with the engine's own semantics. */
  advanceSteps(n: number): void;
  /** Pauses the run at the last processed step (freezes time and energy). */
  pause(): void;
  /** Authoritative processed time as the engine formats it. */
  simTimeUtc(): string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class AdvanceDaysController {
  private activeFlag = false;
  private requestedDays = 0;
  private targetSeconds = 0;
  private processedSeconds = 0;
  private startedAt = 0;
  private lastError: string | null = null;
  private runId: string | null = null;
  private startEpoch = 0;
  private stopRequested = false;

  constructor(private readonly host: AdvanceHost) {}

  get active(): boolean {
    return this.activeFlag;
  }

  /**
   * Validates and begins an advance of `days` whole simulated days. Returns a
   * promise that settles when the advance finishes (target reached, stopped,
   * or failed). Throws synchronously (before any mutation) when a run is
   * missing, the value is invalid, or another advance is already active.
   */
  begin(days: unknown): Promise<AdvanceProgress> {
    if (this.activeFlag) {
      throw new ConflictError('A day advance is already active for this run; stop it first (POST /api/v1/control/advance-stop).');
    }
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > ADVANCE_MAX_DAYS) {
      throw new ConflictError(`days must be a whole number from 1 to ${ADVANCE_MAX_DAYS}`, 400, 'VALIDATION_ERROR', 'days');
    }
    const atStart = this.host.getRunEpochSeconds();
    if (!atStart) {
      throw new ConflictError('No simulation run exists; an explicit new-run setup is required before advancing', 409, 'CONFLICT');
    }
    this.activeFlag = true;
    this.requestedDays = days;
    this.targetSeconds = days * DAY_SECONDS;
    this.processedSeconds = 0;
    this.startedAt = Date.now();
    this.lastError = null;
    this.runId = atStart.run_id;
    this.startEpoch = atStart.simEpoch;
    this.stopRequested = false;
    return this.run();
  }

  /** Synchronous stop request: freezes at the last processed step and pauses. */
  requestStop(): void {
    if (this.activeFlag) this.stopRequested = true;
  }

  /** Current progress snapshot from processed engine time — never a clock ahead of calculations. */
  progress(): AdvanceProgress {
    const run = this.host.getRunEpochSeconds();
    const processed = Math.max(0, Math.min(this.targetSeconds, run ? run.simEpoch - this.startEpoch : this.processedSeconds));
    const status: AdvanceStatus = this.activeFlag ? 'advancing' : this.lastError ? 'failed' : 'idle';
    return {
      run_id: this.runId ?? (run ? run.run_id : ''),
      status,
      requested_days: this.requestedDays,
      target_seconds: this.targetSeconds,
      processed_seconds: this.activeFlag ? processed : this.processedSeconds,
      remaining_seconds: Math.max(0, this.targetSeconds - (this.activeFlag ? processed : this.processedSeconds)),
      progress: this.targetSeconds > 0 ? (this.activeFlag ? processed : this.processedSeconds) / this.targetSeconds : 0,
      processed_sim_time_utc: this.host.simTimeUtc() ?? '',
      elapsed_ms: this.activeFlag ? Date.now() - this.startedAt : 0,
      error: this.lastError,
    };
  }

  private async run(): Promise<AdvanceProgress> {
    try {
      while (!this.stopRequested) {
        const run = this.host.getRunEpochSeconds();
        if (!run || run.run_id !== this.runId) break; // run ended/replaced mid-advance
        const remaining = this.targetSeconds - (run.simEpoch - this.startEpoch);
        if (remaining <= 0) break;
        const chunkSeconds = Math.min(remaining, ADVANCE_CHUNK_SECONDS);
        const steps = Math.floor(chunkSeconds / STEP_SECONDS);
        if (steps <= 0) break;
        this.host.advanceSteps(steps); // engine's own transactional step semantics
        this.processedSeconds = run.simEpoch - this.startEpoch + steps * STEP_SECONDS;
        // Yield so HTTP state/commands are served between chunks.
        await sleep(0);
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'day advance failed';
    }
    // Freeze at the last processed step (target reached, stopped, or failed).
    try {
      this.host.pause();
    } catch {
      // The run may already be paused or gone; processed state is untouched.
    }
    this.activeFlag = false;
    return this.progress();
  }
}

/** Bounded chunk of simulated seconds processed between yields (whole steps). */
export const ADVANCE_CHUNK_SECONDS = 6000;

/** Conflict/validation error surfaced by the controller before any mutation. */
export class ConflictError extends Error {
  constructor(message: string, readonly status: number = 409, readonly code: string = 'CONFLICT', readonly field?: string) {
    super(message);
    this.name = 'ConflictError';
  }
}
