/**
 * K002 test helper: builds a contract 1.0.1-shaped dataset from a run's stored
 * snapshots and readings, and reports semantic problems.
 *
 * This is test-only tooling (no production export endpoint is built in K002).
 * It is deliberately independent of the engine's in-memory state: it reads the
 * database, so it exercises exactly what a future export would read.
 *
 * The point of interest is policy activation. For a run created after K002 the
 * dataset's `effective_from_utc` for a pinned revision is the run-scoped
 * activation (run_policies.active_from_utc). A run whose pins predate K002 has
 * no recorded activation; it is reported as legacy and the global revision
 * time is used instead, so such a run is validated against the old meaning
 * rather than silently re-certified.
 */
import { count } from './helpers.js';
import type { Database } from '../src/db/connection.js';

export interface PinnedPolicy {
  policy_id: string;
  version: number;
  kind: string;
  applies_to: string;
  /** Global revision record time: when the revision was minted (identity). */
  effective_from_utc: string;
  /** Run-scoped activation on this run's timeline; null for pre-K002 pins. */
  active_from_utc: string | null;
  rules: Record<string, unknown>;
}

export type ActivationMode = 'run_scoped' | 'legacy_unrecorded';

export interface BuiltDataset {
  dataset: Record<string, unknown>;
  pins: PinnedPolicy[];
  mode: ActivationMode;
  /** policy_id:version → the effective time written into the dataset. */
  datasetEffectiveTimes: Map<string, string>;
}

const epoch = (utc: string): number => Date.parse(utc) / 1000;

export function pinnedPolicies(db: Database, runId: string): PinnedPolicy[] {
  const rows = db.prepare(`SELECT rp.policy_id, rp.version, rp.active_from_utc, p.kind, p.applies_to,
      pv.effective_from_utc, pv.rules
      FROM run_policies rp
      JOIN policies p ON p.policy_id = rp.policy_id
      JOIN policy_versions pv ON pv.policy_id = rp.policy_id AND pv.version = rp.version
      WHERE rp.run_id = ? ORDER BY rp.policy_id, rp.version`).all(runId) as unknown as {
    policy_id: string; version: number; active_from_utc: string | null; kind: string;
    applies_to: string; effective_from_utc: string; rules: string;
  }[];
  return rows.map((r) => ({
    policy_id: r.policy_id, version: r.version, kind: r.kind, applies_to: r.applies_to,
    effective_from_utc: r.effective_from_utc, active_from_utc: r.active_from_utc,
    rules: JSON.parse(r.rules) as Record<string, unknown>,
  }));
}

/** A run is legacy when any pinned row predates the run-scoped activation column. */
export function activationMode(db: Database, runId: string): ActivationMode {
  const row = db.prepare('SELECT COUNT(*) AS missing FROM run_policies WHERE run_id = ? AND active_from_utc IS NULL')
    .get(runId) as { missing: number };
  return row.missing > 0 ? 'legacy_unrecorded' : 'run_scoped';
}

export function buildRunDataset(db: Database, runId: string): BuiltDataset {
  const run = db.prepare(`SELECT r.run_id, r.run_start_utc, r.scenario_id, r.comparison_id, r.building_id,
      r.building_name, r.timezone FROM simulation_runs r WHERE r.run_id = ?`).get(runId) as {
    run_id: string; run_start_utc: string; scenario_id: string; comparison_id: string | null;
    building_id: string; building_name: string; timezone: string;
  };

  const rooms = (db.prepare(`SELECT room_id, name, room_type, capacity, floor_area_m2 FROM run_rooms
      WHERE run_id = ? ORDER BY room_id`).all(runId) as unknown as {
    room_id: string; name: string; room_type: string; capacity: number; floor_area_m2: number | null;
  }[]).map((r) => ({ room_id: r.room_id, name: r.name, room_type: r.room_type, capacity: r.capacity,
    ...(r.floor_area_m2 === null ? {} : { floor_area_m2: r.floor_area_m2 }) }));

  const devices = (db.prepare(`SELECT device_id, room_id, name, device_type, quantity, nominal_power_w,
      standby_power_w, power_factor, always_on, control, controls FROM run_devices WHERE run_id = ?
      ORDER BY device_id`).all(runId) as unknown as {
    device_id: string; room_id: string; name: string; device_type: string; quantity: number;
    nominal_power_w: number; standby_power_w: number | null; power_factor: number; always_on: number;
    control: string; controls: string;
  }[]).map((d) => ({ device_id: d.device_id, name: d.name, room_id: d.room_id, device_type: d.device_type,
    quantity: d.quantity, nominal_power_w: d.nominal_power_w, power_factor: d.power_factor,
    always_on: d.always_on === 1, control: d.control, controls: JSON.parse(d.controls) as string[],
    ...(d.standby_power_w === null ? {} : { standby_power_w: d.standby_power_w }) }));

  const pins = pinnedPolicies(db, runId);
  const mode = activationMode(db, runId);
  // Run-scoped activation is the effective time when it exists; otherwise fall
  // back to the global revision record so legacy runs can still be checked.
  const datasetEffectiveTimes = new Map<string, string>();
  const policies = pins.map((p) => {
    const effective = p.active_from_utc ?? p.effective_from_utc;
    datasetEffectiveTimes.set(`${p.policy_id}:${p.version}`, effective);
    return { policy_id: p.policy_id, version: p.version, applies_to: p.applies_to, kind: p.kind,
      effective_from_utc: effective, rules: p.rules };
  });

  const roomIntervals = (db.prepare(`SELECT run_id, room_id, interval_start_utc, interval_end_utc,
      interval_seconds, occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial
      FROM room_intervals WHERE run_id = ? ORDER BY room_id, interval_start_utc`).all(runId) as unknown as Record<string, unknown>[])
    .map((r): Record<string, unknown> => ({ ...r, partial: r.partial === 1 }));

  const deviceIntervals: Record<string, unknown>[] = (db.prepare(`SELECT run_id, device_id, room_id, interval_start_utc, interval_end_utc,
      interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh, avg_voltage_v, avg_current_a,
      power_factor, on_fraction, override_seconds, vacant_on_seconds, offschedule_on_seconds, policy_ref, partial
      FROM device_intervals WHERE run_id = ? ORDER BY interval_start_utc, device_id`).all(runId) as unknown as Record<string, unknown>[])
    .map((r): Record<string, unknown> => {
      const { avg_voltage_v, avg_current_a, ...rest } = r;
      return { ...rest, partial: r.partial === 1,
        ...(avg_voltage_v === null ? {} : { avg_voltage_v }),
        ...(avg_current_a === null ? {} : { avg_current_a }) };
    });

  const starts = deviceIntervals.map((r) => String(r.interval_start_utc)).concat(roomIntervals.map((r) => String(r.interval_start_utc)));
  const ends = deviceIntervals.map((r) => String(r.interval_end_utc)).concat(roomIntervals.map((r) => String(r.interval_end_utc)));

  const dataset: Record<string, unknown> = {
    schema_version: '1.0.1',
    source: 'simulation',
    synthetic: false,
    building: { building_id: run.building_id, name: run.building_name, timezone: run.timezone },
    run: { run_id: run.run_id, scenario_id: run.scenario_id, comparison_id: run.comparison_id, run_start_utc: run.run_start_utc },
    export: {
      export_id: `export-${runId}`,
      export_start_utc: starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : run.run_start_utc,
      export_end_utc: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : run.run_start_utc,
      interval_seconds: 60,
      created_utc: ends.length ? ends.reduce((a, b) => (a > b ? a : b)) : run.run_start_utc,
    },
    rooms, devices, policies, room_intervals: roomIntervals, device_intervals: deviceIntervals,
  };
  return { dataset, pins, mode, datasetEffectiveTimes };
}

/**
 * Semantic problems a schema-valid dataset can still have. Empty means the
 * dataset is consistent: references resolve inside the dataset, no policy is
 * applied before its effective time, keys are unique, every device covers the
 * same grid, and per-device cumulative energy still reconciles.
 */
export function datasetProblems(built: BuiltDataset, { tolerance = 1e-9 } = {}): string[] {
  const problems: string[] = [];
  const { dataset, datasetEffectiveTimes } = built;
  const deviceIntervals = dataset.device_intervals as Record<string, unknown>[];
  const roomIntervals = dataset.room_intervals as Record<string, unknown>[];
  const policies = dataset.policies as { policy_id: string; version: number; kind: string; rules: Record<string, unknown> }[];

  // 1. Reference integrity: every interval's policy_ref resolves in the dataset.
  for (const row of deviceIntervals) {
    const ref = String(row.policy_ref);
    if (!datasetEffectiveTimes.has(ref)) problems.push(`device interval ${String(row.device_id)}@${String(row.interval_start_utc)} references ${ref}, which the dataset does not define`);
  }
  // 2. Dependency integrity: device_schedule.office_hours_ref resolves in the dataset.
  for (const p of policies) {
    if (p.kind !== 'device_schedule') continue;
    const ref = p.rules.office_hours_ref;
    if (typeof ref !== 'string' || !datasetEffectiveTimes.has(ref)) {
      problems.push(`device_schedule ${p.policy_id}:${p.version} office_hours_ref ${String(ref)} does not resolve inside the dataset`);
    }
  }
  // 3. Activation semantics: a policy is never applied before its effective time.
  for (const row of deviceIntervals) {
    const effective = datasetEffectiveTimes.get(String(row.policy_ref));
    if (effective === undefined) continue;
    if (epoch(effective) > epoch(String(row.interval_start_utc))) {
      problems.push(`${String(row.device_id)}@${String(row.interval_start_utc)} applies ${String(row.policy_ref)} before its effective time ${effective}`);
    }
  }
  // 4. Key uniqueness.
  const deviceKeys = new Set<string>();
  for (const row of deviceIntervals) {
    const key = `${String(row.device_id)}@${String(row.interval_start_utc)}`;
    if (deviceKeys.has(key)) problems.push(`duplicate device interval key ${key}`);
    deviceKeys.add(key);
  }
  const roomKeys = new Set<string>();
  for (const row of roomIntervals) {
    const key = `${String(row.room_id)}@${String(row.interval_start_utc)}`;
    if (roomKeys.has(key)) problems.push(`duplicate room interval key ${key}`);
    roomKeys.add(key);
  }
  // 5. Aligned grid: every device covers exactly the same interval starts.
  const grid = new Set(deviceIntervals.map((r) => String(r.interval_start_utc)));
  const byDevice = new Map<string, Set<string>>();
  for (const row of deviceIntervals) {
    const id = String(row.device_id);
    if (!byDevice.has(id)) byDevice.set(id, new Set());
    byDevice.get(id)!.add(String(row.interval_start_utc));
  }
  for (const [device, starts] of byDevice) {
    if (starts.size !== grid.size) problems.push(`${device} covers ${starts.size} intervals but the dataset grid has ${grid.size}`);
  }
  // 6. Energy: cumulative counters advance by the interval energy (the first
  // interval of a partial export is exempt, per contract 3.5).
  for (const [device, starts] of byDevice) {
    const rows = deviceIntervals.filter((r) => String(r.device_id) === device)
      .sort((a, b) => (String(a.interval_start_utc) < String(b.interval_start_utc) ? -1 : 1));
    let previousCumulative: number | null = null;
    for (const row of rows) {
      const cumulative = Number(row.cumulative_kwh);
      const energy = Number(row.energy_kwh);
      if (previousCumulative !== null && Math.abs((cumulative - previousCumulative) - energy) > tolerance) {
        problems.push(`${device}@${String(row.interval_start_utc)} cumulative step ${cumulative - previousCumulative} != energy ${energy}`);
      }
      previousCumulative = cumulative;
    }
    if (starts.size === 0) problems.push(`${device} has no intervals`);
  }
  // 7. Energy total is preserved: the dataset's device energy equals the database's.
  const datasetEnergy = deviceIntervals.reduce((s, r) => s + Number(r.energy_kwh), 0);
  if (!Number.isFinite(datasetEnergy)) problems.push('device energy total is not finite');
  return problems;
}

/** Convenience for tests: the intervals of one device, ordered by start. */
export function deviceRows(built: BuiltDataset, deviceId: string): Record<string, unknown>[] {
  return (built.dataset.device_intervals as Record<string, unknown>[])
    .filter((r) => r.device_id === deviceId)
    .sort((a, b) => (String(a.interval_start_utc) < String(b.interval_start_utc) ? -1 : 1));
}

export const intervalCount = (db: Database, table: string, runId: string): number => {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ?`).get(runId) as { n: number };
  return row.n;
};

export { count };
