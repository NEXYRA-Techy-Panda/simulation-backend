import { randomInt, randomUUID } from 'node:crypto';
import { utcNow } from '../db/clock.js';
import { type Database, transaction } from '../db/connection.js';
import { INTERVAL_SECONDS, STEP_SECONDS } from '../engine/constants.js';
import { SimulationEngine } from '../engine/engine.js';
import { ApiError } from '../http/errors.js';
import { type HistoryRequest, validateHistoryRequest } from './request.js';

/**
 * K005-PREP batch history generation.
 *
 * One worker, bounded queue. Each job creates its own batch run (own run_id,
 * frozen inventory/policy snapshot, policy activation at the requested start,
 * seeded occupancy) through a batch-mode SimulationEngine and advances it with
 * the same deterministic advanceSteps() the interactive clock uses — no
 * wall-clock waiting, no skipped steps. Each simulated minute is published and
 * its progress committed in one short transaction; the worker yields between
 * chunks. Nothing accumulates in memory beyond the current minute.
 *
 * A job is `succeeded` only after the expected readings are verified in the
 * database. Failures keep their partial readings with status `failed` and a
 * coverage that shows exactly how far they got. start() marks jobs left
 * `running` by a previous process as failed (`JOB_INTERRUPTED`) — they are
 * not resumed — and processes still-`queued` jobs (which never created a run).
 */

export const RUN_PURPOSE = 'history_batch';

export interface HistoryServiceOptions {
  /** Steps per worker chunk before yielding (default 360 = one simulated hour). */
  chunkSteps?: number;
  /** Maximum queued + running jobs (default 3 = one running + two waiting). */
  maxPending?: number;
  wallClock?: () => Date;
  /** How the worker yields between chunks (default: setImmediate). */
  yieldFn?: () => Promise<void>;
  /** Test seam: how a chunk is advanced (default engine.advanceSteps). */
  advance?: (engine: SimulationEngine, steps: number) => void;
}

interface JobRow {
  job_id: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; run_id: string | null;
  from_utc: string; to_utc: string; interval_seconds: number; seed: number; request: string;
  expected_steps: number; expected_intervals: number; completed_steps: number; completed_intervals: number;
  processed_sim_utc: string | null; failure_code: string | null; failure_message: string | null;
  created_utc: string; started_utc: string | null; finished_utc: string | null;
}

const epochOf = (utc: string): number => Date.parse(utc) / 1000;
const defaultYield = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

export class HistoryJobService {
  private readonly chunkSteps: number;
  private readonly maxPending: number;
  private readonly wallClock: () => Date;
  private readonly yieldFn: () => Promise<void>;
  private readonly advance: (engine: SimulationEngine, steps: number) => void;
  private worker: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly db: Database, options: HistoryServiceOptions = {}) {
    this.chunkSteps = options.chunkSteps ?? 360;
    if (!Number.isInteger(this.chunkSteps) || this.chunkSteps < 1) throw new Error('chunkSteps must be a positive integer');
    this.maxPending = options.maxPending ?? 3;
    this.wallClock = options.wallClock ?? (() => new Date());
    this.yieldFn = options.yieldFn ?? defaultYield;
    this.advance = options.advance ?? ((engine, steps) => engine.advanceSteps(steps));
  }

  /** Marks jobs interrupted by a previous process as failed, then processes queued jobs. */
  start(): { interrupted: string[] } {
    const now = utcNow(this.wallClock());
    const rows = this.db.prepare(`SELECT job_id FROM history_jobs WHERE status = 'running' ORDER BY rowid`).all() as { job_id: string }[];
    transaction(this.db, () => {
      for (const r of rows) {
        this.db.prepare(`UPDATE history_jobs SET status = 'failed', failure_code = 'JOB_INTERRUPTED',
            failure_message = 'The service stopped while this job was running; partial readings are kept and the job is not resumed',
            finished_utc = ? WHERE job_id = ?`).run(now, r.job_id);
      }
    });
    this.stopping = false;
    this.kick();
    return { interrupted: rows.map((r) => r.job_id) };
  }

  /** Stops after the current chunk; a job still running is marked failed (JOB_INTERRUPTED). */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.worker;
  }

  /** Resolves when the worker has nothing left to do (tests, scripts). */
  async idle(): Promise<void> {
    while (this.worker) await this.worker;
  }

  submit(body: Record<string, unknown>): Record<string, unknown> {
    const req = validateHistoryRequest(this.db, body, () => randomInt(0, 0x100000000));
    const jobId = `hist-${randomUUID()}`;
    transaction(this.db, () => {
      const pending = (this.db.prepare(`SELECT count(*) AS n FROM history_jobs WHERE status IN ('queued', 'running')`).get() as { n: number }).n;
      if (pending >= this.maxPending) {
        throw new ApiError(409, 'CONFLICT', `history queue is full (${pending} queued or running; limit ${this.maxPending}); retry later`);
      }
      this.db.prepare(`INSERT INTO history_jobs (job_id, status, from_utc, to_utc, interval_seconds, seed, request,
          expected_steps, expected_intervals, created_utc) VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(jobId, req.from_utc, req.to_utc, req.interval_seconds, req.seed, JSON.stringify(req),
          req.expected_steps, req.expected_intervals, utcNow(this.wallClock()));
    });
    this.kick();
    return this.get(jobId)!;
  }

  get(jobId: string): Record<string, unknown> | null {
    const row = this.db.prepare('SELECT * FROM history_jobs WHERE job_id = ?').get(jobId) as unknown as JobRow | undefined;
    return row ? view(row) : null;
  }

  // ------------------------------------------------------------------ worker

  private kick(): void {
    if (this.worker || this.stopping) return;
    // A submit() can arrive after loop() found nothing but before this promise
    // settles; re-check the queue on settle so such a job is never stranded.
    this.worker = this.loop().finally(() => {
      this.worker = null;
      if (!this.stopping && this.db.isOpen
        && this.db.prepare(`SELECT 1 FROM history_jobs WHERE status = 'queued' LIMIT 1`).get()) this.kick();
    });
  }

  private async loop(): Promise<void> {
    for (;;) {
      if (this.stopping) return;
      const next = this.db.prepare(`SELECT * FROM history_jobs WHERE status = 'queued' ORDER BY rowid LIMIT 1`)
        .get() as unknown as JobRow | undefined;
      if (!next) return;
      await this.runJob(next);
    }
  }

  private async runJob(job: JobRow): Promise<void> {
    const req = JSON.parse(job.request) as HistoryRequest;
    const start = epochOf(job.from_utc);
    const markRunning = this.db.prepare(`UPDATE history_jobs SET status = 'running', started_utc = ? WHERE job_id = ? AND status = 'queued'`);
    if (markRunning.run(utcNow(this.wallClock()), job.job_id).changes !== 1) return;

    const progress = this.db.prepare(`UPDATE history_jobs SET run_id = ?, processed_sim_utc = ?, completed_steps = ?,
        completed_intervals = ? WHERE job_id = ?`);
    const engine = new SimulationEngine(this.db, {
      wallClock: this.wallClock,
      batch: {
        // Runs inside each published minute's transaction: progress == committed readings.
        onCommit: ({ run_id, sim_time_utc }) => {
          const elapsed = epochOf(sim_time_utc) - start;
          progress.run(run_id, sim_time_utc, elapsed / STEP_SECONDS, Math.floor(elapsed / INTERVAL_SECONDS), job.job_id);
        },
      },
    });

    try {
      engine.createBatchRun({
        startUtc: job.from_utc,
        seed: job.seed,
        ...(req.occupancy ? { occupancy: req.occupancy } : {}),
        config: {
          run_purpose: RUN_PURPOSE,
          history_job_id: job.job_id,
          synthetic: true,
          generator: 'K005-PREP batch history (shared SimulationEngine.advanceSteps; 10 s steps, 60 s intervals)',
          requested_window: { from_utc: job.from_utc, to_utc: job.to_utc, interval_seconds: job.interval_seconds, month: req.month },
          seed_source: req.seed_source,
          occupancy_runtime: req.occupancy,
        },
      });
      let done = 0;
      while (done < job.expected_steps) {
        if (this.stopping) {
          this.fail(job.job_id, 'JOB_INTERRUPTED', 'The service was stopped while this job was running; partial readings are kept and the job is not resumed');
          return;
        }
        const n = Math.min(this.chunkSteps, job.expected_steps - done);
        this.advance(engine, n);
        done += n;
        await this.yieldFn();
      }
      this.finish(job);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(job.job_id, 'JOB_FAILED', message.slice(0, 500));
    }
  }

  /** Verifies the committed readings, then marks the job succeeded in one transaction. */
  private finish(job: JobRow): void {
    transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM history_jobs WHERE job_id = ?').get(job.job_id) as unknown as JobRow;
      const runId = row.run_id;
      if (!runId) throw new Error('batch run was not linked');
      const one = <T>(sql: string): T => this.db.prepare(sql).get(runId) as T;
      const devices = one<{ n: number }>('SELECT count(*) AS n FROM run_devices WHERE run_id = ?').n;
      const rooms = one<{ n: number }>('SELECT count(*) AS n FROM run_rooms WHERE run_id = ?').n;
      const dev = one<{ n: number; p: number; lo: string; hi: string }>(`SELECT count(*) AS n, coalesce(sum(partial), 0) AS p,
          min(interval_start_utc) AS lo, max(interval_end_utc) AS hi FROM device_intervals WHERE run_id = ?`);
      const room = one<{ n: number; p: number }>('SELECT count(*) AS n, coalesce(sum(partial), 0) AS p FROM room_intervals WHERE run_id = ?');
      const problems: string[] = [];
      if (row.completed_intervals !== row.expected_intervals || row.completed_steps !== row.expected_steps) problems.push('progress short of expected');
      if (dev.n !== row.expected_intervals * devices) problems.push(`device intervals ${dev.n} != ${row.expected_intervals * devices}`);
      if (room.n !== row.expected_intervals * rooms) problems.push(`room intervals ${room.n} != ${row.expected_intervals * rooms}`);
      if (dev.p + room.p !== 0) problems.push('partial intervals present');
      if (dev.lo !== row.from_utc || dev.hi !== row.to_utc) problems.push(`coverage ${dev.lo}..${dev.hi} != ${row.from_utc}..${row.to_utc}`);
      const now = utcNow(this.wallClock());
      if (problems.length) {
        this.db.prepare(`UPDATE history_jobs SET status = 'failed', failure_code = 'INCOMPLETE_OUTPUT', failure_message = ?,
            finished_utc = ? WHERE job_id = ?`).run(problems.join('; ').slice(0, 500), now, job.job_id);
        return;
      }
      this.db.prepare(`UPDATE history_jobs SET status = 'succeeded', finished_utc = ? WHERE job_id = ?`).run(now, job.job_id);
    });
  }

  private fail(jobId: string, code: string, message: string): void {
    this.db.prepare(`UPDATE history_jobs SET status = 'failed', failure_code = ?, failure_message = ?, finished_utc = ?
        WHERE job_id = ? AND status IN ('queued', 'running')`).run(code, message, utcNow(this.wallClock()), jobId);
  }
}

/** Public job view: contract fields (job_id, status, result_ref) plus truthful progress and coverage. */
function view(row: JobRow): Record<string, unknown> {
  const req = JSON.parse(row.request) as HistoryRequest;
  const succeeded = row.status === 'succeeded';
  return {
    job_id: row.job_id,
    status: row.status,
    // The generated run is the result; export must select it by run_id (K003 interface, see docs).
    result_ref: succeeded ? row.run_id : null,
    run_id: row.run_id,
    requested: { from_utc: row.from_utc, to_utc: row.to_utc, interval_seconds: row.interval_seconds, month: req.month },
    seed: row.seed,
    seed_source: req.seed_source,
    occupancy: req.occupancy,
    progress: {
      committed_through_utc: row.processed_sim_utc,
      completed_steps: row.completed_steps,
      expected_steps: row.expected_steps,
      completed_intervals: row.completed_intervals,
      expected_intervals: row.expected_intervals,
      fraction: row.completed_intervals / row.expected_intervals,
    },
    coverage: {
      complete: succeeded,
      from_utc: row.from_utc,
      to_utc: row.completed_intervals > 0 ? row.processed_sim_utc : null,
    },
    failure: row.failure_code ? { code: row.failure_code, message: row.failure_message } : null,
    synthetic: true,
    created_utc: row.created_utc,
    started_utc: row.started_utc,
    finished_utc: row.finished_utc,
  };
}
