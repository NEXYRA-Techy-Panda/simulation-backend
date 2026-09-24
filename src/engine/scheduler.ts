import { performance } from 'node:perf_hooks';
import { MAX_STEPS_PER_BATCH, STEP_SECONDS, TICK_MS } from './constants.js';

/** Time/timer primitives, injectable so tests can drive the scheduler without real waiting. */
export interface SchedulerDeps {
  /** Monotonic milliseconds (performance.now in production). */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setImmediate(fn: () => void): unknown;
  clearImmediate(handle: unknown): void;
}

export const realSchedulerDeps: SchedulerDeps = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setImmediate: (fn) => setImmediate(fn),
  clearImmediate: (h) => clearImmediate(h as NodeJS.Immediate),
};

export interface SchedulerOptions {
  tickMs?: number;
  maxBatchSteps?: number;
}

/**
 * Converts monotonic real elapsed time × speed into owed simulated seconds
 * and asks the engine to process whole STEP_SECONDS steps. Work is done in
 * bounded batches; when a backlog remains it yields via setImmediate so HTTP
 * requests are served between batches. Owed time is carried forward, never
 * dropped while running, so no step is skipped to "catch up"; the engine's
 * processed time is the only simulation time exposed. One loop at most:
 * start() on an active scheduler is a no-op.
 */
export class WallClockScheduler {
  private active = false;
  private owedSimSeconds = 0;
  private lastMs = 0;
  private handle: { kind: 'timeout' | 'immediate'; h: unknown } | null = null;
  private readonly tickMs: number;
  private readonly maxBatchSteps: number;

  constructor(
    private readonly advance: (steps: number) => void,
    private speed: number,
    private readonly onError: (err: unknown) => void,
    private readonly deps: SchedulerDeps = realSchedulerDeps,
    { tickMs = TICK_MS, maxBatchSteps = MAX_STEPS_PER_BATCH }: SchedulerOptions = {},
  ) {
    this.tickMs = tickMs;
    this.maxBatchSteps = maxBatchSteps;
  }

  get running(): boolean {
    return this.active;
  }

  /** Whole steps owed but not yet processed. */
  get backlogSteps(): number {
    return Math.floor(this.owedSimSeconds / STEP_SECONDS);
  }

  /** Returns false (and does nothing) if already running. */
  start(): boolean {
    if (this.active) return false;
    this.active = true;
    this.owedSimSeconds = 0;
    this.lastMs = this.deps.now();
    this.schedule('timeout');
    return true;
  }

  /** Stops the loop. Unprocessed owed wall time is discarded; processed simulation state is untouched. */
  stop(): void {
    this.active = false;
    this.owedSimSeconds = 0;
    this.clearHandle();
  }

  setSpeed(speed: number): void {
    if (this.active) this.accrue(); // time before the change counts at the old speed
    this.speed = speed;
  }

  /** One scheduling turn: process up to maxBatchSteps owed steps. Public for deterministic tests. */
  tick(): number {
    this.handle = null;
    if (!this.active) return 0;
    this.accrue();
    const steps = Math.min(Math.floor(this.owedSimSeconds / STEP_SECONDS), this.maxBatchSteps);
    if (steps > 0) {
      try {
        this.advance(steps);
      } catch (err) {
        this.stop();
        this.onError(err);
        return 0;
      }
      this.owedSimSeconds -= steps * STEP_SECONDS;
    }
    if (this.active) this.schedule(this.backlogSteps > 0 ? 'immediate' : 'timeout');
    return steps;
  }

  private accrue(): void {
    const now = this.deps.now();
    this.owedSimSeconds += ((now - this.lastMs) * this.speed) / 1000;
    this.lastMs = now;
  }

  private schedule(kind: 'timeout' | 'immediate'): void {
    this.clearHandle();
    const run = (): void => {
      this.tick();
    };
    this.handle = kind === 'immediate'
      ? { kind, h: this.deps.setImmediate(run) }
      : { kind, h: this.deps.setTimeout(run, this.tickMs) };
  }

  private clearHandle(): void {
    if (!this.handle) return;
    if (this.handle.kind === 'immediate') this.deps.clearImmediate(this.handle.h);
    else this.deps.clearTimeout(this.handle.h);
    this.handle = null;
  }
}
