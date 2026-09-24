/**
 * K005-PREP representative month generation (evidence run, not a benchmark).
 *
 *   npx tsx scripts/k005-month-run.ts [YYYY-MM] [seed]
 *
 * Uses a NEW scratch SQLite file under the OS temp directory (kept for
 * inspection), never data/ or any shared database. The history router is
 * served by an in-process harness on an ephemeral loopback port (never the
 * fixed 19001). Setup mirrors what an operator would do interactively: seed
 * the demo inventory, create an interactive run and switch the office to
 * scheduled occupancy (a normal POST /occupancy action that mints the
 * scheduled occupancy revision in THIS scratch database), then request the
 * month. Memory figures are point samples, not measured peaks.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { closeDatabase, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDemoInventory } from '../src/db/seed/seed.js';
import { SimulationEngine } from '../src/engine/engine.js';
import { HistoryJobService } from '../src/history/service.js';
import { errorHandler, notFound } from '../src/http/errors.js';
import { requestId } from '../src/http/requestId.js';
import { historyJobsRouter } from '../src/routes/historyJobs.js';

const month = process.argv[2] ?? '2026-01';
const seed = Number(process.argv[3] ?? 20260101);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const dir = join(tmpdir(), 'nexyra-k005', `month-${month}-${stamp}`);
mkdirSync(dir, { recursive: true });
const dbPath = join(dir, 'history.sqlite');

const db = openDatabase(dbPath);
runMigrations(db);
seedDemoInventory(db);

// Interactive setup (as an operator would): a paused interactive run in scheduled mode.
const interactive = new SimulationEngine(db);
interactive.reset(7);
interactive.setOccupancy({ mode: 'scheduled', target: 14 });
const checkpointBefore = JSON.stringify(db.prepare('SELECT * FROM engine_checkpoints').all());

const service = new HistoryJobService(db);
service.start();
const app = express();
app.use(requestId);
app.use(express.json());
app.use('/api/v1', historyJobsRouter(service));
app.use(notFound);
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((r) => { server.once('listening', r); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> => {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: (await res.json()) as Json };
};

const t0 = performance.now();
const created = await call('POST', '/history/jobs', { month, interval_seconds: 60, seed, occupancy: { mode: 'scheduled', target: 14 } });
if (created.status !== 202) throw new Error(`POST failed: ${JSON.stringify(created)}`);
const jobId = created.json.data.job_id as string;
const samples: Json[] = [];
let final: Json;
for (;;) {
  await new Promise((r) => { setTimeout(r, 2000); });
  const got = await call('GET', `/history/jobs/${jobId}`);
  const d = got.json.data as Json;
  const mem = process.memoryUsage();
  samples.push({
    wall_s: Math.round((performance.now() - t0) / 100) / 10, status: d.status,
    completed_intervals: d.progress.completed_intervals, committed_through_utc: d.progress.committed_through_utc,
    heap_used_mb_sample: Math.round(mem.heapUsed / 1048576), rss_mb_sample: Math.round(mem.rss / 1048576),
  });
  if (d.status === 'succeeded' || d.status === 'failed') { final = d; break; }
}
const wallSeconds = (performance.now() - t0) / 1000;
server.close();
await service.stop();

const run = final.run_id as string;
const q = <T>(sql: string, ...args: (string | number)[]): T => db.prepare(sql).get(run, ...args) as T;
const all = <T>(sql: string, ...args: (string | number)[]): T[] => db.prepare(sql).all(run, ...args) as T[];
const devRows = q<{ n: number; p: number; lo: string; hi: string; e: number }>(`SELECT count(*) AS n, sum(partial) AS p,
    min(interval_start_utc) AS lo, max(interval_end_utc) AS hi, sum(energy_kwh) AS e FROM device_intervals WHERE run_id = ?`);
const roomRows = q<{ n: number; p: number }>('SELECT count(*) AS n, sum(partial) AS p FROM room_intervals WHERE run_id = ?');
const byRoom = all<{ room_id: string; kwh: number }>(`SELECT d.room_id, sum(i.energy_kwh) AS kwh FROM device_intervals i
    JOIN run_devices d ON d.run_id = i.run_id AND d.device_id = i.device_id WHERE i.run_id = ? GROUP BY d.room_id ORDER BY d.room_id`);
const byDevice = all<{ device_id: string; kwh: number; cumulative: number; on_hours: number }>(`SELECT device_id, sum(energy_kwh) AS kwh,
    max(cumulative_kwh) AS cumulative, sum(on_fraction) / 60.0 AS on_hours FROM device_intervals WHERE run_id = ? GROUP BY device_id ORDER BY device_id`);
const perMinute = all<{ w: number }>(`SELECT sum(avg_power_w) AS w FROM device_intervals WHERE run_id = ? GROUP BY interval_start_utc`);
const occ = q<{ max_office: number }>(`SELECT max(s) AS max_office FROM (SELECT sum(occupancy_max) AS s FROM room_intervals WHERE run_id = ? GROUP BY interval_start_utc)`);
const hours = q<{ complete: number; total: number }>(`SELECT sum(c = 60) AS complete, count(*) AS total FROM (SELECT substr(interval_start_utc, 1, 13) AS h,
    count(DISTINCT interval_start_utc) AS c FROM device_intervals WHERE run_id = ? GROUP BY h)`);
const pins = all<{ a: string; n: number }>('SELECT active_from_utc AS a, count(*) AS n FROM run_policies WHERE run_id = ? GROUP BY a');
const cfg = JSON.parse(q<{ config: string }>('SELECT config FROM simulation_runs WHERE run_id = ?').config) as Json;
const reconcileErr = Math.max(...byDevice.map((d) => Math.abs(d.kwh - d.cumulative)));
const roomSum = byRoom.reduce((s, r) => s + r.kwh, 0);

const summary = {
  scratch_db: dbPath,
  request: { month, interval_seconds: 60, seed, occupancy: { mode: 'scheduled', target: 14 } },
  job: { job_id: jobId, status: final.status, result_ref: final.result_ref, run_id: run, failure: final.failure,
    progress: final.progress, coverage: final.coverage, created_utc: final.created_utc, started_utc: final.started_utc, finished_utc: final.finished_utc },
  wall_seconds_total_including_polling: Math.round(wallSeconds * 10) / 10,
  rows: { device_intervals: devRows.n, room_intervals: roomRows.n, partial: devRows.p + roomRows.p },
  boundaries: { first_interval_start_utc: devRows.lo, last_interval_end_utc: devRows.hi },
  energy_kwh: { office: devRows.e, rooms_sum: roomSum, by_room: byRoom, max_device_cumulative_mismatch: reconcileErr },
  devices: byDevice,
  office_power_w: { min_minute_avg: Math.min(...perMinute.map((m) => m.w)), max_minute_avg: Math.max(...perMinute.map((m) => m.w)) },
  occupancy: { max_office_count: occ.max_office },
  hourly_coverage: hours,
  policy_activation: pins,
  run_config: { run_purpose: cfg.run_purpose, initial_sim_time_utc: cfg.initial_sim_time_utc, occupancy_seed: cfg.occupancy_seed,
    synthetic: cfg.synthetic, layer: cfg.layer, environment: cfg.environment },
  interactive_checkpoint_unchanged: JSON.stringify(db.prepare('SELECT * FROM engine_checkpoints').all()) === checkpointBefore,
  interactive_recovery_run: new SimulationEngine(db).recover()?.run_id ?? null,
  interactive_run_id: (interactive.getState() as Json).run_id,
  progress_samples: samples,
};
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
closeDatabase(db);
console.log(JSON.stringify(summary, (k, v) => (k === 'devices' || k === 'progress_samples' ? `[${(v as unknown[]).length} entries in summary.json]` : v), 2));
console.log(`summary: ${join(dir, 'summary.json')}`);
