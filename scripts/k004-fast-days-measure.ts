/**
 * K004-FAST1 measurement: one interactive 30-day advance on an HOURLY run.
 *
 *   npx tsx scripts/k004-fast-days-measure.ts [days]
 *
 * NEW scratch SQLite file under the OS temp directory (kept), never data/ or a
 * shared database. The real app (createApp: health + inventory + simulation
 * routes) listens on an ephemeral loopback port — never the fixed 19001. The
 * real wall-clock scheduler runs. While advancing, GET /health and GET /state
 * are polled for latency, and dev-open-ac is switched on at ≈day 3 and cleared
 * at ≈day 5 to show command responsiveness. Memory values are point samples,
 * not measured peaks. One measurement, not a benchmark.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { closeDatabase, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDemoInventory } from '../src/db/seed/seed.js';
import { SimulationEngine } from '../src/engine/engine.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const days = Number(process.argv[2] ?? 30);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const dir = join(tmpdir(), 'nexyra-k004-fast1', `advance-${days}d-${stamp}`);
mkdirSync(dir, { recursive: true });
const dbPath = join(dir, 'simulation.sqlite');
const db = openDatabase(dbPath);
runMigrations(db);
seedDemoInventory(db);
const engine = new SimulationEngine(db);
const server = createApp(loadConfig({}), { db, engine }).listen(0, '127.0.0.1');
await new Promise<void>((r) => { server.once('listening', r); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json; ms: number }> {
  const t = performance.now();
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = (await res.json()) as Json;
  return { status: res.status, json, ms: performance.now() - t };
}
const must = async (method: string, path: string, body?: unknown): Promise<Json> => {
  const r = await call(method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.data as Json;
};

await must('POST', '/control/reset', { seed: 2026, interval_seconds: 3600 });
await must('POST', '/occupancy', { mode: 'scheduled', target: 14 });
const t0 = performance.now();
const started = await must('POST', '/control/advance', { days });
const startSim = Date.parse(started.sim_time_utc as string) / 1000;
const samples: Json[] = [];
const commands: Json[] = [];
let acOn = false;
let acCleared = false;
for (;;) {
  await new Promise((r) => { setTimeout(r, 250); });
  const h = await call('GET', '/health');
  const s = await call('GET', '/state');
  const st = s.json.data as Json;
  const simDays = (Date.parse(st.sim_time_utc as string) / 1000 - startSim) / 86_400;
  const mem = process.memoryUsage();
  samples.push({
    wall_s: +((performance.now() - t0) / 1000).toFixed(2), sim_days_processed: +simDays.toFixed(3), status: st.status,
    advance_fraction: st.advance.active ? +st.advance.fraction.toFixed(4) : null,
    health_ms: +h.ms.toFixed(1), state_ms: +s.ms.toFixed(1),
    heap_used_mb_sample: Math.round(mem.heapUsed / 1048576), rss_mb_sample: Math.round(mem.rss / 1048576),
  });
  if (!acOn && simDays >= 3 && st.advance.active) {
    const c = await call('POST', '/devices/dev-open-ac', { manual_state: 'on' });
    commands.push({ command: 'dev-open-ac on', status: c.status, ms: +c.ms.toFixed(1), applied_at_sim_utc: c.json.data?.sim_time_utc ?? null, error: c.json.error ?? null });
    acOn = true;
  } else if (acOn && !acCleared && simDays >= 5 && st.advance.active) {
    const c = await call('POST', '/devices/dev-open-ac', { clear_override: true });
    commands.push({ command: 'dev-open-ac clear', status: c.status, ms: +c.ms.toFixed(1), applied_at_sim_utc: c.json.data?.sim_time_utc ?? null, error: c.json.error ?? null });
    acCleared = true;
  }
  if (!st.advance.active) break;
}
const elapsed = (performance.now() - t0) / 1000;
const final = await must('GET', '/state');
server.close();
engine.shutdown();

const run = final.run_id as string;
const q = <T>(sql: string, ...a: (string | number)[]): T => db.prepare(sql).get(run, ...a) as T;
const dev = q<{ n: number; e: number; p: number; lo: string; hi: string; secs: string }>(`SELECT count(*) AS n, sum(energy_kwh) AS e, sum(partial) AS p,
    min(interval_start_utc) AS lo, max(interval_end_utc) AS hi, group_concat(DISTINCT interval_seconds) AS secs FROM device_intervals WHERE run_id = ?`);
const rooms = q<{ n: number }>('SELECT count(*) AS n FROM room_intervals WHERE run_id = ?');
const perDevice = db.prepare(`SELECT device_id, sum(energy_kwh) AS e, max(cumulative_kwh) AS c FROM device_intervals WHERE run_id = ? GROUP BY device_id`)
  .all(run) as { device_id: string; e: number; c: number }[];
const stateDevices = final.devices as { device_id: string; energy_kwh: number }[];
const mismatch = Math.max(...perDevice.map((d) => Math.abs(d.e - d.c)),
  ...perDevice.map((d) => Math.abs(d.c - (stateDevices.find((x) => x.device_id === d.device_id)?.energy_kwh ?? NaN))));
const acHours = db.prepare(`SELECT interval_start_utc, energy_kwh, on_fraction, override_seconds FROM device_intervals
    WHERE run_id = ? AND device_id = 'dev-open-ac' AND override_seconds > 0 ORDER BY interval_start_utc`).all(run) as Json[];
const ms = (k: string): Json => {
  const v = samples.map((x) => x[k] as number).sort((a, b) => a - b);
  return { n: v.length, median: v[Math.floor(v.length / 2)], p95: v[Math.floor(v.length * 0.95)], max: v.at(-1) };
};
const summary = {
  scratch_db: dbPath,
  requested_days: days,
  elapsed_seconds_wall: +elapsed.toFixed(2),
  simulated_days_per_real_second: +(days / elapsed).toFixed(3),
  processed_steps: final.advance.last.processed_steps,
  expected_steps: final.advance.last.expected_steps,
  outcome: final.advance.last.outcome,
  final_sim_time_utc: final.sim_time_utc,
  status_after: final.status,
  recording_interval_seconds: final.recording_interval_seconds,
  stored: { device_intervals: dev.n, room_intervals: rooms.n, partial: dev.p, interval_seconds: dev.secs, first_start: dev.lo, last_end: dev.hi },
  energy_kwh: { office_sum_of_intervals: dev.e, office_state: (final.office as Json).energy_kwh, max_device_mismatch_intervals_cumulative_state: mismatch },
  commands,
  ac_override_hours: { count: acHours.length, first: acHours[0] ?? null, last: acHours.at(-1) ?? null },
  latency_ms: { health: ms('health_ms'), state: ms('state_ms') },
  memory_samples_mb: { heap_used: ms('heap_used_mb_sample'), rss: ms('rss_mb_sample') },
  samples,
};
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
closeDatabase(db);
console.log(JSON.stringify({ ...summary, samples: `[${samples.length} in summary.json]` }, null, 2));
console.log(`summary: ${join(dir, 'summary.json')}`);
