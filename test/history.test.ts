/**
 * K005-PREP batch history generation. In-memory databases only; the HTTP
 * harness listens on an ephemeral loopback port (never the fixed 19001).
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import express from 'express';
import { count, closeDatabase, memoryDb } from './helpers.js';
import { fakeEngine, stateOf } from './engineHelpers.js';
import type { Database } from '../src/db/connection.js';
import { addPolicyVersion } from '../src/db/inventory.js';
import { SimulationEngine } from '../src/engine/engine.js';
import { HistoryJobService, type HistoryServiceOptions } from '../src/history/service.js';
import { monthWindow, toUtc, validateHistoryRequest } from '../src/history/request.js';
import { errorHandler, notFound } from '../src/http/errors.js';
import { requestId } from '../src/http/requestId.js';
import { historyJobsRouter } from '../src/routes/historyJobs.js';

type Job = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const INITIAL = '2025-12-31T18:30:00Z';
const plusSeconds = (utc: string, s: number): string => toUtc(Date.parse(utc) / 1000 + s);

/** Makes the CURRENT occupancy revision scheduled (as an interactive POST /occupancy would), before any run. */
function scheduledOffice(db: Database): void {
  addPolicyVersion(db, { policy_id: 'pol-occupancy', effective_from_utc: '2000-01-01T00:00:00Z', rules: { mode: 'scheduled', auto_allocate: true } });
}

async function runJob(db: Database, body: Record<string, unknown>, options: HistoryServiceOptions = {}): Promise<Job> {
  const service = new HistoryJobService(db, options);
  service.start();
  const submitted = service.submit(body) as Job;
  await service.idle();
  return service.get(submitted.job_id as string) as Job;
}

/** Interval rows without run identity, in a stable order. */
function deviceRows(db: Database, runId: string): Record<string, unknown>[] {
  return db.prepare(`SELECT device_id, room_id, interval_start_utc, interval_end_utc, interval_seconds, avg_power_w, max_power_w,
      energy_kwh, cumulative_kwh, power_factor, on_fraction, override_seconds, vacant_on_seconds, offschedule_on_seconds,
      policy_id, policy_version, partial FROM device_intervals WHERE run_id = ? ORDER BY interval_start_utc, device_id`).all(runId);
}
function roomRows(db: Database, runId: string): Record<string, unknown>[] {
  return db.prepare(`SELECT room_id, interval_start_utc, interval_end_utc, interval_seconds, occupancy_avg, occupancy_max,
      occupied_fraction, avg_temp_c, avg_rh_pct, partial FROM room_intervals WHERE run_id = ? ORDER BY interval_start_utc, room_id`).all(runId);
}
function pins(db: Database, runId: string): Record<string, unknown>[] {
  return db.prepare('SELECT policy_id, version, active_from_utc FROM run_policies WHERE run_id = ? ORDER BY policy_id, version').all(runId);
}
const runConfig = (db: Database, runId: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT config FROM simulation_runs WHERE run_id = ?').get(runId) as { config: string }).config) as Record<string, unknown>;

/** A yield function that blocks the worker after `free` chunks until release() is called. */
function gate(free: number): { yieldFn: () => Promise<void>; release: () => void; reached: Promise<void> } {
  let n = 0;
  let release!: () => void;
  let signal!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  const reached = new Promise<void>((r) => { signal = r; });
  return {
    yieldFn: async () => {
      n += 1;
      if (n > free) { signal(); await blocked; } else await new Promise<void>((r) => { setImmediate(r); });
    },
    release: () => release(),
    reached,
  };
}

describe('K005 calendar windows (Asia/Kolkata, UTC half-open)', () => {
  const days = (w: { from: number; to: number }): number => (w.to - w.from) / 86_400;

  it('January has 31 local days; February 28/29; December rolls into the next year', () => {
    const jan = monthWindow('2026-01');
    assert.equal(toUtc(jan.from), '2025-12-31T18:30:00Z');
    assert.equal(toUtc(jan.to), '2026-01-31T18:30:00Z');
    assert.equal(days(jan), 31);
    assert.equal(days(monthWindow('2026-02')), 28);
    assert.equal(days(monthWindow('2028-02')), 29);
    assert.equal(days(monthWindow('2024-02')), 29);
    assert.throws(() => monthWindow('2100-01'), /years 2000–2099/);
    assert.equal(days(monthWindow('2026-04')), 30);
    const dec = monthWindow('2026-12');
    assert.equal(toUtc(dec.from), '2026-11-30T18:30:00Z');
    assert.equal(toUtc(dec.to), '2026-12-31T18:30:00Z'); // = 2027-01-01 00:00 local
    assert.equal(toUtc(monthWindow('2027-01').from), toUtc(dec.to));
  });

  it('a month request expects every 10 s step and 1-minute interval of its local days', () => {
    const db = memoryDb();
    try {
      const req = validateHistoryRequest(db, { month: '2026-01', seed: 1 }, () => 0);
      assert.equal(req.expected_intervals, 31 * 1440);
      assert.equal(req.expected_steps, 31 * 8640);
      const feb = validateHistoryRequest(db, { month: '2028-02', seed: 1 }, () => 0);
      assert.equal(feb.expected_intervals, 29 * 1440);
    } finally { closeDatabase(db); }
  });
});

describe('K005 request validation has no side effects', () => {
  it('rejects unsupported or malformed requests before any job or run exists', () => {
    const db = memoryDb();
    try {
      const service = new HistoryJobService(db);
      const cases: [Record<string, unknown>, number, string][] = [
        [{ month: '2026-01', from: INITIAL }, 400, 'month'],
        [{ month: '2026-13' }, 400, 'month'],
        [{ from: '2026-01-01T00:00:30Z', to: '2026-01-01T01:00:00Z' }, 400, 'from'],
        [{ from: '2026-02-30T00:00:00Z', to: '2026-03-01T00:00:00Z' }, 400, 'from'],
        [{ from: '2026-01-01T00:00:00+05:30', to: '2026-01-02T00:00:00Z' }, 400, 'from'],
        [{ from: '1999-01-01T00:00:00Z', to: '1999-01-02T00:00:00Z' }, 400, 'from'],
        [{ from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }, 400, 'to'],
        [{ from: '2026-01-01T00:00:00Z' }, 400, 'to'],
        [{ from: '2026-01-01T00:00:00Z', to: '2026-02-02T00:00:00Z' }, 413, 'to'],
        [{ month: '2026-01', interval_seconds: 300 }, 400, 'interval_seconds'],
        [{ month: '2026-01', seed: -1 }, 400, 'seed'],
        [{ month: '2026-01', seed: 1.5 }, 400, 'seed'],
        [{ month: '2026-01', calendar: { working_days: [1] } }, 400, 'calendar'],
        [{ month: '2026-01', environment: { temp_c: 30 } }, 400, 'environment'],
        [{ month: '2026-01', occupancy: { mode: 'scheduled', target: 10 } }, 409, 'occupancy.mode'], // pinned mode is manual
        [{ month: '2026-01', occupancy: { mode: 'manual', total: 21 } }, 400, 'occupancy.total'],
        [{ month: '2026-01', occupancy: { mode: 'manual', target: 3 } }, 400, 'occupancy.target'],
        [{ month: '2026-01', occupancy: { mode: 'manual', total: 3, extra: 1 } }, 400, 'occupancy.extra'],
      ];
      for (const [body, status, field] of cases) {
        assert.throws(() => service.submit(body), (err: { status?: number; field?: string }) => err.status === status && err.field === field,
          JSON.stringify(body));
      }
      assert.equal(count(db, 'history_jobs'), 0);
      assert.equal(count(db, 'simulation_runs'), 0);
    } finally { closeDatabase(db); }
  });

  it('an unseeded inventory is refused up front', () => {
    const db = memoryDb({ seed: false });
    try {
      assert.throws(() => new HistoryJobService(db).submit({ month: '2026-01' }), (err: { status?: number }) => err.status === 409);
      assert.equal(count(db, 'history_jobs'), 0);
    } finally { closeDatabase(db); }
  });
});

describe('K005 shared engine: batch equals interactive stepping', () => {
  it('same inputs and seed give identical telemetry and pins over 12 simulated hours', async () => {
    const db = memoryDb();
    try {
      scheduledOffice(db);
      const { engine } = fakeEngine(db);
      engine.reset(2026);
      engine.advanceSteps(12 * 360);
      const interactive = stateOf(engine).run_id!;

      const job = await runJob(db, { from: INITIAL, to: plusSeconds(INITIAL, 12 * 3600), seed: 2026 });
      assert.equal(job.status, 'succeeded', JSON.stringify(job.failure));
      const batch = job.run_id as string;
      assert.notEqual(batch, interactive);
      assert.equal(deviceRows(db, batch).length, 720 * 18);
      assert.deepEqual(deviceRows(db, batch), deviceRows(db, interactive));
      assert.deepEqual(roomRows(db, batch), roomRows(db, interactive));
      assert.deepEqual(pins(db, batch), pins(db, interactive));
      // Non-trivial: people arrived at 09:00 and devices switched on.
      const occupied = db.prepare('SELECT max(occupancy_max) AS m FROM room_intervals WHERE run_id = ?').get(batch) as { m: number };
      assert.ok(occupied.m > 0);
    } finally { closeDatabase(db); }
  });

  it('results do not depend on the worker chunk size (custom start inside a working day)', async () => {
    const db = memoryDb();
    try {
      scheduledOffice(db);
      const window = { from: '2026-01-05T03:00:00Z', to: '2026-01-05T06:00:00Z', seed: 77 }; // Mon 08:30–11:30 local
      const results = [];
      for (const chunkSteps of [1, 7, 360]) {
        const job = await runJob(db, window, { chunkSteps });
        assert.equal(job.status, 'succeeded');
        results.push({ dev: deviceRows(db, job.run_id), room: roomRows(db, job.run_id) });
      }
      assert.deepEqual(results[1], results[0]);
      assert.deepEqual(results[2], results[0]);
      assert.equal(results[0]!.dev[0]!.interval_start_utc, '2026-01-05T03:00:00Z');
    } finally { closeDatabase(db); }
  });

  it('the seed changes room allocation only; the same seed reproduces exactly', async () => {
    const db = memoryDb();
    try {
      scheduledOffice(db);
      const w = { from: '2026-01-05T03:00:00Z', to: '2026-01-05T09:00:00Z' };
      const a = await runJob(db, { ...w, seed: 1 });
      const a2 = await runJob(db, { ...w, seed: 1 });
      const b = await runJob(db, { ...w, seed: 999 });
      assert.deepEqual(roomRows(db, a.run_id), roomRows(db, a2.run_id));
      assert.deepEqual(deviceRows(db, a.run_id), deviceRows(db, a2.run_id));
      assert.notDeepEqual(roomRows(db, a.run_id), roomRows(db, b.run_id));
      const office = (run: string): unknown[] => db.prepare(`SELECT interval_start_utc, sum(occupancy_max) AS n FROM room_intervals
          WHERE run_id = ? GROUP BY interval_start_utc ORDER BY interval_start_utc`).all(run);
      assert.deepEqual(office(a.run_id), office(b.run_id)); // office count follows the schedule, not the seed
    } finally { closeDatabase(db); }
  });
});

describe('K005 energy and reconciliation', () => {
  it('known load × simulated duration: an empty office draws only always-on and standby power', async () => {
    const db = memoryDb(); // seeded occupancy revision: manual, total 0
    try {
      const job = await runJob(db, { from: '2026-01-05T00:00:00Z', to: '2026-01-05T02:00:00Z', seed: 5 });
      assert.equal(job.status, 'succeeded');
      const devices = db.prepare('SELECT device_id, always_on, nominal_power_w, standby_power_w FROM run_devices WHERE run_id = ?')
        .all(job.run_id) as { device_id: string; always_on: number; nominal_power_w: number; standby_power_w: number | null }[];
      let office = 0;
      for (const d of devices) {
        const w = d.always_on ? d.nominal_power_w : (d.standby_power_w ?? 0);
        const expected = (w * 7200) / 3_600_000;
        const got = (db.prepare('SELECT sum(energy_kwh) AS e FROM device_intervals WHERE run_id = ? AND device_id = ?').get(job.run_id, d.device_id) as { e: number }).e;
        assert.ok(Math.abs(got - expected) <= 1e-9, `${d.device_id}: ${got} vs ${expected}`);
        office += expected;
      }
      const fridge = (db.prepare(`SELECT sum(energy_kwh) AS e FROM device_intervals WHERE run_id = ? AND device_id = 'dev-pantry-fridge'`)
        .get(job.run_id) as { e: number }).e;
      assert.ok(Math.abs(fridge - 0.3) <= 1e-9); // 150 W × 2 h
      const total = (db.prepare('SELECT sum(energy_kwh) AS e FROM device_intervals WHERE run_id = ?').get(job.run_id) as { e: number }).e;
      assert.ok(Math.abs(total - office) <= 18 * 120 * 1e-9);
    } finally { closeDatabase(db); }
  });

  it('device totals reconcile to rooms and office exactly once; cumulative counters match', async () => {
    const db = memoryDb();
    try {
      scheduledOffice(db);
      const job = await runJob(db, { from: '2026-01-05T02:30:00Z', to: '2026-01-05T14:30:00Z', seed: 11 });
      const run = job.run_id as string;
      const byRoom = db.prepare(`SELECT d.room_id, sum(i.energy_kwh) AS e FROM device_intervals i
          JOIN run_devices d ON d.run_id = i.run_id AND d.device_id = i.device_id WHERE i.run_id = ? GROUP BY d.room_id`).all(run) as { e: number }[];
      const office = (db.prepare('SELECT sum(energy_kwh) AS e, count(*) AS n, count(DISTINCT device_id || interval_start_utc) AS u FROM device_intervals WHERE run_id = ?')
        .get(run) as { e: number; n: number; u: number });
      assert.equal(office.n, office.u);
      assert.equal(office.n, 720 * 18);
      assert.ok(Math.abs(byRoom.reduce((s, r) => s + r.e, 0) - office.e) <= 1e-9);
      assert.ok(office.e > 0);
      const last = db.prepare(`SELECT device_id, cumulative_kwh FROM device_intervals WHERE run_id = ? AND interval_end_utc = ?`)
        .all(run, '2026-01-05T14:30:00Z') as { device_id: string; cumulative_kwh: number }[];
      for (const l of last) {
        const sum = (db.prepare('SELECT sum(energy_kwh) AS e FROM device_intervals WHERE run_id = ? AND device_id = ?').get(run, l.device_id) as { e: number }).e;
        assert.ok(Math.abs(sum - l.cumulative_kwh) <= 1e-9, l.device_id);
      }
    } finally { closeDatabase(db); }
  });
});

describe('K005 run identity, policy activation and interactive isolation', () => {
  it('the batch run starts, activates its pinned policies and records provenance at the requested start', async () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.reset(3);
      engine.setCalendar({ working_days: [1, 2, 3, 4, 5, 6], open_local: '08:00', close_local: '20:00' }); // new GLOBAL revisions
      const from = '2026-02-02T03:30:00Z';
      const job = await runJob(db, { from, to: plusSeconds(from, 3600), seed: 4 });
      assert.equal(job.status, 'succeeded');
      const run = job.run_id as string;
      const p = pins(db, run);
      assert.ok(p.length > 0 && p.every((x) => x.active_from_utc === from));
      assert.ok(p.some((x) => x.policy_id === 'pol-office-hours' && x.version === 2));
      const early = db.prepare(`SELECT count(*) AS n FROM device_intervals i JOIN run_policies rp ON rp.run_id = i.run_id
          AND rp.policy_id = i.policy_id AND rp.version = i.policy_version WHERE i.run_id = ? AND i.interval_start_utc < rp.active_from_utc`).get(run) as { n: number };
      assert.equal(early.n, 0);
      const ac = db.prepare(`SELECT DISTINCT policy_version AS v FROM device_intervals WHERE run_id = ? AND device_id = 'dev-open-ac'`).all(run) as { v: number }[];
      assert.deepEqual(ac.map((r) => r.v), [2]);
      const runRow = db.prepare('SELECT run_start_utc FROM simulation_runs WHERE run_id = ?').get(run) as { run_start_utc: string };
      assert.equal(runRow.run_start_utc, from);
      const cfg = runConfig(db, run);
      assert.equal(cfg.run_purpose, 'history_batch');
      assert.equal(cfg.history_job_id, job.job_id);
      assert.equal(cfg.initial_sim_time_utc, from);
      assert.equal(cfg.occupancy_seed, 4);
      assert.equal(cfg.synthetic, true);
    } finally { closeDatabase(db); }
  });

  it('never touches the interactive run, its readings or checkpoint; restart recovers only the interactive run', async () => {
    const db = memoryDb();
    try {
      scheduledOffice(db);
      const { engine } = fakeEngine(db);
      engine.reset(8);
      engine.advanceSteps(95); // leaves a partial minute
      engine.pause();
      const before = { state: stateOf(engine), checkpoint: db.prepare('SELECT * FROM engine_checkpoints').all(), rows: count(db, 'device_intervals') };
      const job = await runJob(db, { from: '2026-01-05T03:00:00Z', to: '2026-01-05T05:00:00Z', seed: 9 });
      assert.equal(job.status, 'succeeded');
      assert.deepEqual(stateOf(engine), before.state);
      assert.deepEqual(db.prepare('SELECT * FROM engine_checkpoints').all(), before.checkpoint);
      assert.equal((db.prepare('SELECT count(*) AS n FROM device_intervals WHERE run_id = ?').get(before.state.run_id) as { n: number }).n, before.rows);
      const restarted = new SimulationEngine(db).recover();
      assert.equal(restarted?.run_id, before.state.run_id);
      assert.throws(() => db.prepare(`INSERT INTO engine_checkpoints (run_id, lifecycle, seq, sim_time_utc, speed, state, updated_utc)
          VALUES (?, 'ended', 0, '2026-01-05T03:00:00Z', 1, '{}', 't')`).run(job.run_id), /never has an interactive engine checkpoint/);
    } finally { closeDatabase(db); }
  });

  it('with no interactive run, a newer batch run is still never recovered', async () => {
    const db = memoryDb();
    try {
      const job = await runJob(db, { from: '2026-01-05T03:00:00Z', to: '2026-01-05T03:10:00Z', seed: 1 });
      assert.equal(job.status, 'succeeded');
      assert.equal(count(db, 'engine_checkpoints'), 0);
      const engine = new SimulationEngine(db);
      assert.equal(engine.recover(), null);
      assert.equal(engine.lifecycle, 'not_initialized');
    } finally { closeDatabase(db); }
  });

  it('a batch engine refuses interactive lifecycle calls and global-policy commands', () => {
    const db = memoryDb();
    try {
      const engine = new SimulationEngine(db, { batch: { onCommit: () => undefined } });
      for (const call of [() => engine.recover(), () => engine.start(), () => engine.reset(), () => engine.resume(),
        () => engine.setCalendar({ working_days: [1], open_local: '09:00', close_local: '10:00' }),
        () => engine.setOccupancy({ mode: 'scheduled' }), () => engine.commandDevice('dev-open-ac', { kind: 'clear' })]) {
        assert.throws(call, (err: { status?: number }) => err.status === 409);
      }
      assert.equal(count(db, 'simulation_runs'), 0);
    } finally { closeDatabase(db); }
  });

  it('runtime occupancy for the pinned mode is applied without minting a policy revision', async () => {
    const db = memoryDb();
    try {
      scheduledOffice(db);
      const versions = count(db, 'policy_versions');
      const job = await runJob(db, { from: '2026-01-05T04:00:00Z', to: '2026-01-05T04:10:00Z', seed: 2, occupancy: { mode: 'scheduled', target: 6 } });
      assert.equal(job.status, 'succeeded');
      assert.equal(count(db, 'policy_versions'), versions);
      const office = db.prepare(`SELECT sum(occupancy_max) AS n FROM room_intervals WHERE run_id = ? AND interval_start_utc = '2026-01-05T04:09:00Z'`)
        .get(job.run_id) as { n: number };
      assert.equal(office.n, 6); // 09:39 local, open, no redistribution window
    } finally { closeDatabase(db); }
  });
});

describe('K005 job lifecycle, progress and failures', () => {
  it('progress counts committed readings while running; nothing is complete until verified', async () => {
    const db = memoryDb();
    try {
      const g = gate(2);
      const service = new HistoryJobService(db, { chunkSteps: 60, yieldFn: g.yieldFn });
      service.start();
      const job = service.submit({ from: '2026-01-05T00:00:00Z', to: '2026-01-05T01:00:00Z', seed: 1 }) as Job;
      await g.reached; // three chunks of 10 minutes committed
      const mid = service.get(job.job_id) as Job;
      assert.equal(mid.status, 'running');
      assert.equal(mid.result_ref, null);
      assert.equal(mid.coverage.complete, false);
      assert.equal(mid.progress.completed_intervals, 30);
      assert.equal(mid.progress.completed_steps, 180);
      assert.equal(mid.progress.committed_through_utc, '2026-01-05T00:30:00Z');
      assert.equal((db.prepare('SELECT count(*) AS n FROM device_intervals WHERE run_id = ?').get(mid.run_id) as { n: number }).n, 30 * 18);
      g.release();
      await service.idle();
      const done = service.get(job.job_id) as Job;
      assert.equal(done.status, 'succeeded');
      assert.equal(done.result_ref, done.run_id);
      assert.deepEqual(done.coverage, { complete: true, from_utc: '2026-01-05T00:00:00Z', to_utc: '2026-01-05T01:00:00Z' });
      assert.equal(done.progress.fraction, 1);
    } finally { closeDatabase(db); }
  });

  it('a failure keeps partial readings as explicitly incomplete, and the terminal row is final', async () => {
    const db = memoryDb();
    try {
      let chunks = 0;
      const job = await runJob(db, { from: '2026-01-05T00:00:00Z', to: '2026-01-05T01:00:00Z', seed: 1 }, {
        chunkSteps: 60,
        advance: (engine, n) => {
          chunks += 1;
          if (chunks === 3) throw new Error('injected step failure');
          engine.advanceSteps(n);
        },
      });
      assert.equal(job.status, 'failed');
      assert.deepEqual(job.failure, { code: 'JOB_FAILED', message: 'injected step failure' });
      assert.equal(job.result_ref, null);
      assert.equal(job.coverage.complete, false);
      assert.equal(job.coverage.to_utc, '2026-01-05T00:20:00Z');
      assert.equal(job.progress.completed_intervals, 20);
      assert.equal((db.prepare('SELECT count(*) AS n FROM device_intervals WHERE run_id = ?').get(job.run_id) as { n: number }).n, 20 * 18);
      assert.throws(() => db.prepare(`UPDATE history_jobs SET status = 'succeeded' WHERE job_id = ?`).run(job.job_id), /cannot be modified/);
    } finally { closeDatabase(db); }
  });

  it('stop() marks a running job interrupted; a restart fails orphaned running jobs and processes queued ones', async () => {
    const db = memoryDb();
    try {
      // stop(): graceful interruption.
      const g1 = gate(0);
      const a = new HistoryJobService(db, { chunkSteps: 60, yieldFn: g1.yieldFn });
      a.start();
      const j1 = a.submit({ from: '2026-01-05T00:00:00Z', to: '2026-01-05T01:00:00Z', seed: 1 }) as Job;
      await g1.reached;
      const stopped = a.stop();
      g1.release();
      await stopped;
      const s1 = a.get(j1.job_id) as Job;
      assert.equal(s1.status, 'failed');
      assert.equal(s1.failure.code, 'JOB_INTERRUPTED');
      assert.equal(s1.progress.completed_intervals, 10);

      // A process that dies mid-job leaves 'running'; a new process marks it failed.
      const g2 = gate(0);
      const b = new HistoryJobService(db, { chunkSteps: 60, yieldFn: g2.yieldFn });
      b.start();
      const j2 = b.submit({ from: '2026-01-06T00:00:00Z', to: '2026-01-06T01:00:00Z', seed: 2 }) as Job;
      const j3 = b.submit({ from: '2026-01-07T00:00:00Z', to: '2026-01-07T00:30:00Z', seed: 3 }) as Job;
      await g2.reached; // b is now "dead": its worker never continues
      assert.equal((b.get(j2.job_id) as Job).status, 'running');
      assert.equal((b.get(j3.job_id) as Job).status, 'queued');
      const c = new HistoryJobService(db);
      assert.deepEqual(c.start().interrupted, [j2.job_id]);
      await c.idle();
      assert.equal((c.get(j2.job_id) as Job).failure.code, 'JOB_INTERRUPTED');
      assert.equal((c.get(j2.job_id) as Job).coverage.complete, false);
      assert.equal((c.get(j3.job_id) as Job).status, 'succeeded'); // never started, so safely processed
    } finally { closeDatabase(db); }
  });

  it('the queue is bounded; excess work is refused without a job row', async () => {
    const db = memoryDb();
    try {
      const g = gate(0);
      const service = new HistoryJobService(db, { maxPending: 2, chunkSteps: 60, yieldFn: g.yieldFn });
      service.start();
      service.submit({ from: '2026-01-05T00:00:00Z', to: '2026-01-05T01:00:00Z', seed: 1 });
      service.submit({ from: '2026-01-06T00:00:00Z', to: '2026-01-06T01:00:00Z', seed: 1 });
      await g.reached;
      assert.throws(() => service.submit({ month: '2026-03' }), (err: { status?: number }) => err.status === 409);
      assert.equal(count(db, 'history_jobs'), 2);
      const stopped = service.stop();
      g.release();
      await stopped;
    } finally { closeDatabase(db); }
  });
});

describe('K005 history routes (in-process HTTP harness, ephemeral port)', () => {
  it('POST 202 → GET until succeeded; 404, 400 and 413 use the contract envelopes', async () => {
    const db = memoryDb();
    const service = new HistoryJobService(db);
    service.start();
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.use('/api/v1', historyJobsRouter(service));
    app.use(notFound);
    app.use(errorHandler);
    const server: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => { server.once('listening', r); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Job }> => {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, json: (await res.json()) as Job };
    };
    try {
      const created = await call('POST', '/history/jobs', { from: '2026-01-05T03:00:00Z', to: '2026-01-05T04:00:00Z', interval_seconds: 60, seed: 12 });
      assert.equal(created.status, 202);
      assert.ok(created.json.meta.request_id);
      assert.ok(['queued', 'running'].includes(created.json.data.status));
      await service.idle();
      const done = await call('GET', `/history/jobs/${created.json.data.job_id}`);
      assert.equal(done.status, 200);
      assert.equal(done.json.data.status, 'succeeded');
      assert.equal(done.json.data.result_ref, done.json.data.run_id);
      assert.equal(done.json.data.progress.completed_intervals, 60);
      assert.equal((await call('GET', '/history/jobs/hist-missing')).status, 404);
      const unknown = await call('POST', '/history/jobs', { month: '2026-01', speed: 1000 });
      assert.deepEqual([unknown.status, unknown.json.error.code, unknown.json.error.field], [400, 'VALIDATION_ERROR', 'speed']);
      const big = await call('POST', '/history/jobs', { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' });
      assert.deepEqual([big.status, big.json.error.code], [413, 'REQUEST_TOO_LARGE']);
    } finally {
      await new Promise<void>((r) => { server.close(() => r()); });
      await service.stop();
      closeDatabase(db);
    }
  });
});
