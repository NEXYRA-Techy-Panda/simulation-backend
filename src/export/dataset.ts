import { createHash } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import { utcNow } from '../db/clock.js';
import type { Database } from '../db/connection.js';
import type {
  ActivationMode,
  DeviceIntervalRecord,
  DeviceRecord,
  ExportLimits,
  ExportMetadata,
  ExportSelection,
  PinnedPolicyRecord,
  PolicyRecord,
  RoomIntervalRecord,
  RoomRecord,
  RunCatalogItem,
  RunRecord,
} from './types.js';
import { isCanonicalUtc, seconds, utcFromSeconds } from './time.js';

const SOURCE_INTERVAL_SECONDS = 60;
const ENERGY_TOLERANCE_KWH = 1e-9;
const POWER_EPSILON = 1e-12;
const MAX_AUDITOR_METADATA_BYTES = 8 * 1024 * 1024;

interface DeviceSourceRow {
  run_id: string;
  room_id: string;
  device_id: string;
  interval_start_utc: string;
  interval_end_utc: string;
  interval_seconds: number;
  avg_power_w: number;
  max_power_w: number;
  energy_kwh: number;
  cumulative_kwh: number;
  avg_voltage_v: number | null;
  avg_current_a: number | null;
  power_factor: number;
  on_fraction: number;
  override_seconds: number;
  vacant_on_seconds: number;
  offschedule_on_seconds: number;
  policy_ref: string;
  partial: number;
}

interface RoomSourceRow {
  run_id: string;
  room_id: string;
  interval_start_utc: string;
  interval_end_utc: string;
  interval_seconds: number;
  occupancy_avg: number;
  occupancy_max: number;
  occupied_fraction: number;
  avg_temp_c: number;
  avg_rh_pct: number;
  partial: number;
}

interface CoverageSummary {
  start_utc: string | null;
  end_utc: string | null;
  row_count: number;
  distinct_count: number;
}

interface PreparedRun {
  run: RunRecord;
  rooms: RoomRecord[];
  devices: DeviceRecord[];
  pins: PinnedPolicyRecord[];
  policies: PolicyRecord[];
  activationMode: ActivationMode;
  policyByRef: Map<string, PolicyRecord>;
}

export interface PreparedExport {
  selection: ExportSelection;
  metadata: ExportMetadata;
  activationMode: ActivationMode;
  sourceDeviceRows: number;
  sourceRoomRows: number;
  outputDeviceRows: number;
  outputRoomRows: number;
  sourceSlotCount: number;
}

function notFound(message: string, field?: string): never {
  throw new ApiError(404, 'NOT_FOUND', message, field);
}

function insufficient(message: string, field?: string): never {
  throw new ApiError(422, 'INSUFFICIENT_DATA', message, field);
}

function conflict(message: string, field?: string): never {
  throw new ApiError(409, 'CONFLICT', message, field);
}

function tooLarge(message: string, field?: string): never {
  throw new ApiError(413, 'REQUEST_TOO_LARGE', message, field);
}

function loadRun(db: Database, runId: string): RunRecord {
  const row = db.prepare(`SELECT run_id, building_id, building_name, timezone, scenario_id,
      comparison_id, run_start_utc, created_utc FROM simulation_runs WHERE run_id = ?`).get(runId) as
    | RunRecord
    | undefined;
  if (!row) notFound(`Unknown simulation run "${runId}".`, 'run_id');
  if (!isCanonicalUtc(row.run_start_utc) || !isCanonicalUtc(row.created_utc)) {
    conflict(`Run "${runId}" has invalid canonical UTC metadata.`);
  }
  // K005 integration: a history-batch run is exportable only once its job has
  // succeeded (verified complete); queued/running/failed output is never history.
  const job = db.prepare('SELECT status FROM history_jobs WHERE run_id = ?').get(runId) as { status: string } | undefined;
  if (job && job.status !== 'succeeded') {
    conflict(`Run "${runId}" belongs to a history job that is ${job.status}, not succeeded; its readings are not complete history.`, 'run_id');
  }
  // K004-FAST1 integration: this exporter reads 60 s source rows. Hourly-recorded
  // runs are refused explicitly rather than failing on row durations.
  const recording = db.prepare(`SELECT json_extract(config, '$.interval_seconds') AS s FROM simulation_runs WHERE run_id = ?`)
    .get(runId) as { s: number | null };
  if (recording.s !== null && recording.s !== SOURCE_INTERVAL_SECONDS) {
    conflict(`Run "${runId}" records ${recording.s} s intervals; export currently supports 60 s-recorded runs only.`, 'run_id');
  }
  return row;
}

function loadRooms(db: Database, runId: string): RoomRecord[] {
  const rows = db.prepare(`SELECT room_id, name, room_type, capacity, floor_area_m2
      FROM run_rooms WHERE run_id = ? ORDER BY room_id`).all(runId) as unknown as {
    room_id: string; name: string; room_type: string; capacity: number; floor_area_m2: number | null;
  }[];
  return rows.map((row) => ({
    room_id: row.room_id,
    name: row.name,
    room_type: row.room_type,
    capacity: row.capacity,
    ...(row.floor_area_m2 === null ? {} : { floor_area_m2: row.floor_area_m2 }),
  }));
}

function loadDevices(db: Database, runId: string): DeviceRecord[] {
  const rows = db.prepare(`SELECT device_id, room_id, name, device_type, quantity, nominal_power_w,
      standby_power_w, power_factor, always_on, control, controls
      FROM run_devices WHERE run_id = ? ORDER BY device_id`).all(runId) as unknown as {
    device_id: string; room_id: string; name: string; device_type: DeviceRecord['device_type'];
    quantity: number; nominal_power_w: number; standby_power_w: number | null;
    power_factor: number; always_on: number; control: DeviceRecord['control']; controls: string;
  }[];
  return rows.map((row) => ({
    device_id: row.device_id,
    room_id: row.room_id,
    name: row.name,
    device_type: row.device_type,
    quantity: row.quantity,
    nominal_power_w: row.nominal_power_w,
    ...(row.standby_power_w === null ? {} : { standby_power_w: row.standby_power_w }),
    power_factor: row.power_factor,
    always_on: row.always_on === 1,
    control: row.control,
    controls: JSON.parse(row.controls) as string[],
  }));
}

function loadPins(db: Database, runId: string): PinnedPolicyRecord[] {
  const rows = db.prepare(`SELECT rp.policy_id, rp.version, rp.active_from_utc, p.applies_to, p.kind,
      pv.effective_from_utc AS global_effective_from_utc, pv.rules
      FROM run_policies rp
      JOIN policies p ON p.policy_id = rp.policy_id
      JOIN policy_versions pv ON pv.policy_id = rp.policy_id AND pv.version = rp.version
      WHERE rp.run_id = ? ORDER BY rp.policy_id, rp.version`).all(runId) as unknown as {
    policy_id: string; version: number; active_from_utc: string | null; applies_to: string;
    kind: PinnedPolicyRecord['kind']; global_effective_from_utc: string; rules: string;
  }[];
  return rows.map((row) => {
    const global = row.global_effective_from_utc;
    const active = row.active_from_utc;
    if (!isCanonicalUtc(global) || (active !== null && !isCanonicalUtc(active))) {
      conflict(`Run "${runId}" has a policy pin with invalid UTC metadata.`);
    }
    return {
      policy_id: row.policy_id,
      version: row.version,
      applies_to: row.applies_to,
      kind: row.kind,
      // K002: run-scoped activation is the exported effective time. Legacy null
      // falls back to global revision identity only for validation/export; it is
      // never backfilled into immutable history.
      effective_from_utc: active ?? global,
      rules: JSON.parse(row.rules) as Record<string, unknown>,
      global_effective_from_utc: global,
      active_from_utc: active,
    };
  });
}

function prepareRun(db: Database, runId: string): PreparedRun {
  const run = loadRun(db, runId);
  const rooms = loadRooms(db, runId);
  const devices = loadDevices(db, runId);
  const pins = loadPins(db, runId);
  if (rooms.length === 0 || devices.length === 0 || pins.length === 0) {
    conflict(`Run "${runId}" has an incomplete immutable snapshot.`);
  }

  const roomIds = new Set(rooms.map((room) => room.room_id));
  for (const device of devices) {
    if (!roomIds.has(device.room_id)) conflict(`Run device ${device.device_id} references a missing room snapshot.`);
  }
  // CSV contract v1.0.1 carries room summaries only on device rows. Reject a
  // device-less room rather than silently omitting its committed intervals from
  // CSV or breaking JSON/CSV parity.
  const deviceRoomIds = new Set(devices.map((device) => device.room_id));
  const deviceLessRoom = rooms.find((room) => !deviceRoomIds.has(room.room_id));
  if (deviceLessRoom) {
    conflict(`Run room ${deviceLessRoom.room_id} has no device, so standalone CSV cannot represent its committed room history.`, 'rooms');
  }

  const activationMode: ActivationMode = pins.some((pin) => pin.active_from_utc === null)
    ? 'legacy_unrecorded'
    : 'run_scoped';
  const policies: PolicyRecord[] = pins.map(({ policy_id, version, applies_to, kind, effective_from_utc, rules }) => ({
    policy_id, version, applies_to, kind, effective_from_utc, rules,
  }));
  const policyByRef = new Map(policies.map((policy) => [`${policy.policy_id}:${policy.version}`, policy]));
  if (policyByRef.size !== policies.length) conflict(`Run "${runId}" contains duplicate policy references.`);

  for (const policy of policies) {
    if (policy.kind !== 'device_schedule') continue;
    const reference = policy.rules.office_hours_ref;
    const target = typeof reference === 'string' ? policyByRef.get(reference) : undefined;
    if (!target || target.kind !== 'office_hours') {
      conflict(`Policy ${policy.policy_id}:${policy.version} has an unresolved office_hours_ref.`, 'policies');
    }
  }

  // Validate the whole run, not only the selected window. Otherwise a later
  // window could hide a pre-K002 interval that referenced a not-yet-effective
  // global revision.
  const activationViolations = db.prepare(`SELECT COUNT(*) AS n
      FROM device_intervals di
      JOIN run_policies rp ON rp.run_id = di.run_id AND rp.policy_id = di.policy_id AND rp.version = di.policy_version
      JOIN policy_versions pv ON pv.policy_id = rp.policy_id AND pv.version = rp.version
      WHERE di.run_id = ?
        AND di.interval_start_utc < coalesce(rp.active_from_utc, pv.effective_from_utc)`)
    .get(runId) as { n: number };
  if (activationViolations.n > 0) {
    conflict(
      activationMode === 'legacy_unrecorded'
        ? `Legacy run "${runId}" has ${activationViolations.n} interval(s) applied before immutable global policy time and cannot be exported.`
        : `Run "${runId}" has ${activationViolations.n} interval(s) applied before run-scoped policy activation.`,
    );
  }

  return { run, rooms, devices, pins, policies, activationMode, policyByRef };
}

function coverageSummary(
  db: Database,
  table: 'device_intervals' | 'room_intervals',
  id: string,
  runId: string,
  fromUtc?: string,
  toUtc?: string,
): CoverageSummary {
  const bounded = fromUtc !== undefined && toUtc !== undefined;
  return db.prepare(`SELECT MIN(interval_start_utc) AS start_utc, MAX(interval_end_utc) AS end_utc,
      COUNT(*) AS row_count, COUNT(DISTINCT ${id}) AS distinct_count
      FROM ${table} WHERE run_id = ?${bounded ? ' AND interval_start_utc >= ? AND interval_start_utc < ?' : ''}`)
    .get(...(bounded ? [runId, fromUtc, toUtc] : [runId])) as unknown as CoverageSummary;
}

function policyActivationMode(db: Database, runId: string): ActivationMode {
  const row = db.prepare(`SELECT COUNT(*) AS missing FROM run_policies
      WHERE run_id = ? AND active_from_utc IS NULL`).get(runId) as { missing: number };
  return row.missing > 0 ? 'legacy_unrecorded' : 'run_scoped';
}

function catalogReason(db: Database, run: RunRecord, device: CoverageSummary, room: CoverageSummary): string | null {
  if (device.row_count === 0 || room.row_count === 0) return 'NO_COMMITTED_DATA';
  if (!device.start_utc || !device.end_utc || !room.start_utc || !room.end_utc) return 'NO_COMMITTED_DATA';
  if (device.start_utc !== room.start_utc || device.end_utc !== room.end_utc) return 'HISTORY_COVERAGE_INCONSISTENT';
  if (seconds(device.end_utc) <= seconds(device.start_utc)) return 'HISTORY_COVERAGE_INCONSISTENT';

  const snapshots = db.prepare(`SELECT
      (SELECT COUNT(*) FROM run_rooms WHERE run_id = @run) AS rooms,
      (SELECT COUNT(*) FROM run_devices WHERE run_id = @run) AS devices,
      (SELECT COUNT(*) FROM run_policies WHERE run_id = @run) AS policies`).get({ run: run.run_id }) as {
    rooms: number; devices: number; policies: number;
  };
  if (snapshots.rooms === 0 || snapshots.devices === 0 || snapshots.policies === 0) return 'INCOMPLETE_RUN_SNAPSHOT';
  const deviceCoveredRooms = (db.prepare(`SELECT COUNT(DISTINCT room_id) AS n FROM run_devices
      WHERE run_id = ?`).get(run.run_id) as { n: number }).n;
  if (deviceCoveredRooms !== snapshots.rooms) return 'DEVICE_LESS_ROOM_UNSUPPORTED';
  if (device.distinct_count !== snapshots.devices || room.distinct_count !== snapshots.rooms) {
    return 'HISTORY_COVERAGE_INCONSISTENT';
  }
  // Min/max plus distinct ids alone can hide a missing middle row. Cardinality
  // and the same endpoints for every entity cheaply prove a complete persisted
  // grid before offering a full-window export in the catalog.
  const expectedSlots = Math.ceil((seconds(device.end_utc) - seconds(device.start_utc)) / SOURCE_INTERVAL_SECONDS);
  const badDeviceCoverage = db.prepare(`SELECT COUNT(*) AS n FROM (
      SELECT device_id, COUNT(*) AS row_count, MIN(interval_start_utc) AS min_start, MAX(interval_end_utc) AS max_end
      FROM device_intervals WHERE run_id = @run GROUP BY device_id)
      WHERE row_count != @slots OR min_start != @start OR max_end != @end`).get({
    run: run.run_id,
    slots: expectedSlots,
    start: device.start_utc,
    end: device.end_utc,
  }) as { n: number };
  const badRoomCoverage = db.prepare(`SELECT COUNT(*) AS n FROM (
      SELECT room_id, COUNT(*) AS row_count, MIN(interval_start_utc) AS min_start, MAX(interval_end_utc) AS max_end
      FROM room_intervals WHERE run_id = @run GROUP BY room_id)
      WHERE row_count != @slots OR min_start != @start OR max_end != @end`).get({
    run: run.run_id,
    slots: expectedSlots,
    start: room.start_utc,
    end: room.end_utc,
  }) as { n: number };
  if (badDeviceCoverage.n > 0 || badRoomCoverage.n > 0) return 'HISTORY_COVERAGE_INCONSISTENT';
  const badDeviceShape = db.prepare(`SELECT COUNT(*) AS n FROM device_intervals
      WHERE run_id = @run AND (
        interval_seconds != unixepoch(interval_end_utc) - unixepoch(interval_start_utc)
        OR interval_seconds > 60
        OR ((unixepoch(interval_start_utc) - unixepoch(@run_start)) % 60) != 0
        OR (interval_seconds < 60 AND partial != 1)
        OR (partial = 1 AND interval_start_utc != @start AND interval_end_utc != @end))`)
    .get({ run: run.run_id, run_start: run.run_start_utc, start: device.start_utc, end: device.end_utc }) as { n: number };
  const badRoomShape = db.prepare(`SELECT COUNT(*) AS n FROM room_intervals
      WHERE run_id = @run AND (
        interval_seconds != unixepoch(interval_end_utc) - unixepoch(interval_start_utc)
        OR interval_seconds > 60
        OR ((unixepoch(interval_start_utc) - unixepoch(@run_start)) % 60) != 0
        OR (interval_seconds < 60 AND partial != 1)
        OR (partial = 1 AND interval_start_utc != @start AND interval_end_utc != @end))`)
    .get({ run: run.run_id, run_start: run.run_start_utc, start: room.start_utc, end: room.end_utc }) as { n: number };
  if (badDeviceShape.n > 0 || badRoomShape.n > 0) return 'HISTORY_COVERAGE_INCONSISTENT';

  const mode = policyActivationMode(db, run.run_id);
  const violations = db.prepare(`SELECT COUNT(*) AS n FROM device_intervals di
      JOIN run_policies rp ON rp.run_id = di.run_id AND rp.policy_id = di.policy_id AND rp.version = di.policy_version
      JOIN policy_versions pv ON pv.policy_id = rp.policy_id AND pv.version = rp.version
      WHERE di.run_id = @run
        AND di.interval_start_utc < coalesce(rp.active_from_utc, pv.effective_from_utc)`)
    .get({ run: run.run_id }) as { n: number };
  if (violations.n > 0) {
    return mode === 'legacy_unrecorded' ? 'LEGACY_POLICY_ACTIVATION_INVALID' : 'POLICY_ACTIVATION_INVALID';
  }
  return null;
}

export function listRuns(db: Database, page: number, pageSize: number): { runs: RunCatalogItem[]; total: number } {
  const rows = db.prepare(`SELECT r.run_id, r.building_id, r.building_name, r.timezone, r.scenario_id,
      r.comparison_id, r.run_start_utc, r.created_utc,
      coalesce(c.lifecycle, 'ended') AS status,
      d.start_utc AS device_start_utc, d.end_utc AS device_end_utc,
      d.row_count AS device_interval_count, d.distinct_count AS device_count,
      q.start_utc AS room_start_utc, q.end_utc AS room_end_utc,
      q.row_count AS room_interval_count, q.distinct_count AS room_count
      FROM simulation_runs r
      LEFT JOIN engine_checkpoints c ON c.run_id = r.run_id
      LEFT JOIN (SELECT run_id, MIN(interval_start_utc) start_utc, MAX(interval_end_utc) end_utc,
          COUNT(*) row_count, COUNT(DISTINCT device_id) distinct_count FROM device_intervals GROUP BY run_id) d
        ON d.run_id = r.run_id
      LEFT JOIN (SELECT run_id, MIN(interval_start_utc) start_utc, MAX(interval_end_utc) end_utc,
          COUNT(*) row_count, COUNT(DISTINCT room_id) distinct_count FROM room_intervals GROUP BY run_id) q
        ON q.run_id = r.run_id
      ORDER BY r.created_utc DESC, r.run_id DESC
      LIMIT @limit OFFSET @offset`).all({ limit: pageSize, offset: (page - 1) * pageSize }) as unknown as {
    run_id: string; building_id: string; building_name: string; timezone: 'Asia/Kolkata';
    scenario_id: 'original' | 'improved'; comparison_id: string | null; run_start_utc: string; created_utc: string;
    status: 'active' | 'ended'; device_start_utc: string | null; device_end_utc: string | null;
    device_interval_count: number | null; device_count: number | null;
    room_start_utc: string | null; room_end_utc: string | null; room_interval_count: number | null; room_count: number | null;
  }[];

  const runs = rows.map((row): RunCatalogItem => {
    const run: RunRecord = {
      run_id: row.run_id,
      building_id: row.building_id,
      building_name: row.building_name,
      timezone: row.timezone,
      scenario_id: row.scenario_id,
      comparison_id: row.comparison_id,
      run_start_utc: row.run_start_utc,
      created_utc: row.created_utc,
    };
    const device: CoverageSummary = {
      start_utc: row.device_start_utc,
      end_utc: row.device_end_utc,
      row_count: row.device_interval_count ?? 0,
      distinct_count: row.device_count ?? 0,
    };
    const room: CoverageSummary = {
      start_utc: row.room_start_utc,
      end_utc: row.room_end_utc,
      row_count: row.room_interval_count ?? 0,
      distinct_count: row.room_count ?? 0,
    };
    const reason = catalogReason(db, run, device, room);
    return {
      run_id: run.run_id,
      scenario_id: run.scenario_id,
      comparison_id: run.comparison_id,
      run_start_utc: run.run_start_utc,
      created_utc: run.created_utc,
      status: row.status,
      committed_start_utc: device.start_utc,
      committed_end_utc: device.end_utc,
      committed_interval_count: device.row_count,
      exportable: reason === null,
      unavailable_reason: reason,
      activation_mode: policyActivationMode(db, run.run_id),
    };
  });
  const total = (db.prepare('SELECT COUNT(*) AS n FROM simulation_runs').get() as { n: number }).n;
  return { runs, total };
}

function sourceHashSeed(input: {
  run: RunRecord;
  rooms: RoomRecord[];
  devices: DeviceRecord[];
  policies: PolicyRecord[];
  selection: ExportSelection;
}): string {
  return JSON.stringify({
    identity_version: 'k003-v1',
    run: input.run,
    rooms: input.rooms,
    devices: input.devices,
    policies: input.policies,
    selection: {
      run_id: input.selection.runId,
      from_utc: input.selection.fromUtc,
      to_utc: input.selection.toUtc,
      interval_seconds: input.selection.intervalSeconds,
    },
  });
}

function validateWindow(selection: ExportSelection, run: RunRecord, limits: ExportLimits): number {
  const from = seconds(selection.fromUtc);
  const to = seconds(selection.toUtc);
  const runStart = seconds(run.run_start_utc);
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Export range must satisfy from < to.', 'to');
  }
  if (from < runStart) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Export range cannot begin before the selected run.', 'from');
  }
  if ((from - runStart) % SOURCE_INTERVAL_SECONDS !== 0) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Export start must align to the persisted one-minute run grid.', 'from');
  }
  if (to - from > limits.maxRangeSeconds) {
    tooLarge(`Export range exceeds the ${limits.maxRangeSeconds}-second limit.`, 'to');
  }
  return Math.ceil((to - from) / SOURCE_INTERVAL_SECONDS);
}

function validateCoverage(
  db: Database,
  prepared: PreparedRun,
  selection: ExportSelection,
  sourceSlots: number,
  limits: ExportLimits,
): { device: CoverageSummary; room: CoverageSummary } {
  const device = coverageSummary(db, 'device_intervals', 'device_id', selection.runId, selection.fromUtc, selection.toUtc);
  const room = coverageSummary(db, 'room_intervals', 'room_id', selection.runId, selection.fromUtc, selection.toUtc);
  if (device.row_count === 0 || room.row_count === 0) {
    insufficient('The selected run has no committed readings for the requested range.', 'run_id');
  }
  if (device.start_utc !== selection.fromUtc || device.end_utc !== selection.toUtc
      || room.start_utc !== selection.fromUtc || room.end_utc !== selection.toUtc) {
    insufficient('The requested range is not fully committed. Export only the available committed coverage or wait for more rows.', 'to');
  }

  const expectedDeviceRows = sourceSlots * prepared.devices.length;
  const expectedRoomRows = sourceSlots * prepared.rooms.length;
  if (expectedDeviceRows > limits.maxSourceDeviceRows) {
    tooLarge(`Export would contain ${expectedDeviceRows} source device rows; limit is ${limits.maxSourceDeviceRows}.`, 'interval_seconds');
  }
  if (expectedRoomRows > limits.maxSourceRoomRows) {
    tooLarge(`Export would contain ${expectedRoomRows} source room rows; limit is ${limits.maxSourceRoomRows}.`, 'interval_seconds');
  }
  if (device.row_count !== expectedDeviceRows || room.row_count !== expectedRoomRows
      || device.distinct_count !== prepared.devices.length || room.distinct_count !== prepared.rooms.length) {
    conflict('Persisted history contains a gap or unexpected device/room coverage for the requested range.', 'to');
  }

  const missingRoomRows = db.prepare(`SELECT COUNT(*) AS n FROM device_intervals di
      LEFT JOIN room_intervals ri ON ri.run_id = di.run_id AND ri.room_id = di.room_id
        AND ri.interval_start_utc = di.interval_start_utc
      WHERE di.run_id = ? AND di.interval_start_utc >= ? AND di.interval_start_utc < ?
        AND ri.run_id IS NULL`).get(selection.runId, selection.fromUtc, selection.toUtc) as { n: number };
  if (missingRoomRows.n > 0) conflict(`${missingRoomRows.n} device interval(s) have no matching committed room interval.`, 'to');
  return { device, room };
}

interface DevicePreflightState {
  count: number;
  nextStart: number;
  previousCumulative: number | null;
  roomId: string;
}

interface BucketSignature {
  powerFactor: number;
  voltagePresent: boolean;
  currentPresent: boolean;
}

function validateDeviceRows(
  db: Database,
  prepared: PreparedRun,
  selection: ExportSelection,
  sourceSlots: number,
  hash: ReturnType<typeof createHash>,
): number {
  const from = seconds(selection.fromUtc);
  const to = seconds(selection.toUtc);
  const states = new Map<string, DevicePreflightState>();
  const bucketPolicies = new Map<string, string>();
  const bucketSignatures = new Map<string, BucketSignature>();
  let rowCount = 0;
  const rows = db.prepare(`SELECT run_id, room_id, device_id, interval_start_utc, interval_end_utc,
      interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh,
      avg_voltage_v, avg_current_a, power_factor, on_fraction, override_seconds,
      vacant_on_seconds, offschedule_on_seconds, policy_ref, partial
      FROM device_intervals WHERE run_id = ?
        AND interval_start_utc >= ? AND interval_start_utc < ?
      ORDER BY device_id, interval_start_utc`).iterate(
    selection.runId, selection.fromUtc, selection.toUtc,
  ) as IterableIterator<DeviceSourceRow>;

  for (const row of rows) {
    rowCount += 1;
    const state = states.get(row.device_id) ?? {
      count: 0,
      nextStart: from,
      previousCumulative: null,
      roomId: row.room_id,
    };
    if (state.roomId !== row.room_id) conflict(`Device ${row.device_id} changes room inside one run.`);
    const start = seconds(row.interval_start_utc);
    const end = seconds(row.interval_end_utc);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start !== state.nextStart) {
      conflict(`Device ${row.device_id} has a gap, overlap, or off-grid row at ${row.interval_start_utc}.`, 'to');
    }
    const expectedDuration = state.count === sourceSlots - 1 ? to - start : SOURCE_INTERVAL_SECONDS;
    if (end <= start || row.interval_seconds !== expectedDuration || end - start !== expectedDuration || expectedDuration > SOURCE_INTERVAL_SECONDS) {
      conflict(`Device ${row.device_id} has an invalid interval duration at ${row.interval_start_utc}.`, 'interval_seconds');
    }
    if (row.partial === 1 && start > from && end < to) {
      conflict(`Device ${row.device_id} has a partial row outside export edges.`, 'partial');
    }
    if (end - start < SOURCE_INTERVAL_SECONDS && row.partial !== 1) {
      conflict(`Device ${row.device_id} has a short row not marked partial.`, 'partial');
    }
    if (row.max_power_w < row.avg_power_w || row.on_fraction < 0 || row.on_fraction > 1
        || row.override_seconds < 0 || row.override_seconds > expectedDuration
        || row.vacant_on_seconds < 0 || row.vacant_on_seconds > expectedDuration
        || row.offschedule_on_seconds < 0 || row.offschedule_on_seconds > expectedDuration) {
      conflict(`Device ${row.device_id} has invalid measurements at ${row.interval_start_utc}.`, 'device_intervals');
    }
    const expectedEnergy = row.avg_power_w * expectedDuration / 3_600_000;
    if (Math.abs(row.energy_kwh - expectedEnergy) > ENERGY_TOLERANCE_KWH) {
      conflict(`Device ${row.device_id} energy does not reconcile at ${row.interval_start_utc} (${row.energy_kwh} vs ${expectedEnergy}).`, 'energy_kwh');
    }
    if (state.previousCumulative !== null
        && Math.abs(row.cumulative_kwh - state.previousCumulative - row.energy_kwh) > ENERGY_TOLERANCE_KWH) {
      conflict(`Device ${row.device_id} cumulative counter does not reconcile at ${row.interval_start_utc}.`, 'cumulative_kwh');
    }
    const policy = prepared.policyByRef.get(row.policy_ref);
    if (!policy) conflict(`Device ${row.device_id} references policy ${row.policy_ref} outside the run snapshot.`, 'policy_ref');
    if (start < seconds(policy.effective_from_utc)) {
      conflict(`Device ${row.device_id} applies ${row.policy_ref} before its exported effective time.`, 'policy_ref');
    }

    const bucket = Math.floor((start - from) / selection.intervalSeconds);
    const policyBucketKey = `${bucket}:${row.device_id}`;
    const priorPolicy = bucketPolicies.get(policyBucketKey);
    if (priorPolicy && priorPolicy !== row.policy_ref) {
      conflict(
        `Aggregation interval ${selection.intervalSeconds}s mixes policy ${priorPolicy} and ${row.policy_ref}. Use a finer interval or a window aligned around the transition.`,
        'interval_seconds',
      );
    }
    bucketPolicies.set(policyBucketKey, row.policy_ref);

    const voltagePresent = row.avg_voltage_v !== null;
    const currentPresent = row.avg_current_a !== null;
    if (voltagePresent !== currentPresent) {
      conflict(`Device ${row.device_id} has only one of avg_voltage_v/avg_current_a.`, 'avg_voltage_v');
    }
    const signatureKey = `${bucket}:${row.device_id}`;
    const signature = bucketSignatures.get(signatureKey);
    if (signature) {
      if (Math.abs(signature.powerFactor - row.power_factor) > POWER_EPSILON
          || signature.voltagePresent !== voltagePresent || signature.currentPresent !== currentPresent) {
        conflict(`Device ${row.device_id} has incompatible metadata inside one ${selection.intervalSeconds}s bucket.`, 'interval_seconds');
      }
    } else {
      bucketSignatures.set(signatureKey, {
        powerFactor: row.power_factor,
        voltagePresent,
        currentPresent,
      });
    }

    hash.update(`${JSON.stringify(row)}\n`);
    state.count += 1;
    state.nextStart = end;
    state.previousCumulative = row.cumulative_kwh;
    states.set(row.device_id, state);
  }

  if (states.size !== prepared.devices.length) conflict('One or more run devices have no readings in the requested range.', 'to');
  for (const device of prepared.devices) {
    const state = states.get(device.device_id);
    if (!state || state.count !== sourceSlots || state.nextStart !== to) {
      conflict(`Device ${device.device_id} does not cover the requested range exactly.`, 'to');
    }
  }
  return rowCount;
}

interface RoomPreflightState {
  count: number;
  nextStart: number;
}

function validateRoomRows(
  db: Database,
  prepared: PreparedRun,
  selection: ExportSelection,
  sourceSlots: number,
  hash: ReturnType<typeof createHash>,
): number {
  const from = seconds(selection.fromUtc);
  const to = seconds(selection.toUtc);
  const states = new Map<string, RoomPreflightState>();
  let rowCount = 0;
  const rows = db.prepare(`SELECT run_id, room_id, interval_start_utc, interval_end_utc,
      interval_seconds, occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial
      FROM room_intervals WHERE run_id = ?
        AND interval_start_utc >= ? AND interval_start_utc < ?
      ORDER BY room_id, interval_start_utc`).iterate(
    selection.runId, selection.fromUtc, selection.toUtc,
  ) as unknown as IterableIterator<RoomSourceRow>;

  for (const row of rows) {
    rowCount += 1;
    const state = states.get(row.room_id) ?? { count: 0, nextStart: from };
    const start = seconds(row.interval_start_utc);
    const end = seconds(row.interval_end_utc);
    if (start !== state.nextStart) conflict(`Room ${row.room_id} has a gap, overlap, or off-grid row at ${row.interval_start_utc}.`, 'to');
    const expectedDuration = state.count === sourceSlots - 1 ? to - start : SOURCE_INTERVAL_SECONDS;
    if (end <= start || row.interval_seconds !== expectedDuration || end - start !== expectedDuration || expectedDuration > SOURCE_INTERVAL_SECONDS) {
      conflict(`Room ${row.room_id} has an invalid interval duration at ${row.interval_start_utc}.`, 'interval_seconds');
    }
    if (row.partial === 1 && start > from && end < to) conflict(`Room ${row.room_id} has a partial row outside export edges.`, 'partial');
    if (end - start < SOURCE_INTERVAL_SECONDS && row.partial !== 1) conflict(`Room ${row.room_id} has a short row not marked partial.`, 'partial');
    hash.update(`${JSON.stringify(row)}\n`);
    state.count += 1;
    state.nextStart = end;
    states.set(row.room_id, state);
  }
  if (states.size !== prepared.rooms.length) conflict('One or more snapshot rooms have no readings in the requested range.', 'to');
  for (const room of prepared.rooms) {
    const state = states.get(room.room_id);
    if (!state || state.count !== sourceSlots || state.nextStart !== to) {
      conflict(`Room ${room.room_id} does not cover the requested range exactly.`, 'to');
    }
  }
  return rowCount;
}

export function prepareExport(
  db: Database,
  selection: ExportSelection,
  limits: ExportLimits,
  now = new Date(),
): PreparedExport {
  const prepared = prepareRun(db, selection.runId);
  const sourceSlots = validateWindow(selection, prepared.run, limits);
  const coverage = validateCoverage(db, prepared, selection, sourceSlots, limits);
  const hash = createHash('sha256');
  hash.update(sourceHashSeed({
    run: prepared.run,
    rooms: prepared.rooms,
    devices: prepared.devices,
    policies: prepared.policies,
    selection,
  }));
  const sourceDeviceRows = validateDeviceRows(db, prepared, selection, sourceSlots, hash);
  const sourceRoomRows = validateRoomRows(db, prepared, selection, sourceSlots, hash);
  if (sourceDeviceRows !== coverage.device.row_count || sourceRoomRows !== coverage.room.row_count) {
    conflict('Source row count changed or is inconsistent inside the export snapshot.');
  }

  const digest = hash.digest('hex');
  const metadata: ExportMetadata = {
    schema_version: '1.0.1',
    source: 'simulation',
    synthetic: true,
    synthetic_label: 'Scenario-generated NEXYRA office simulation; not live meter data.',
    building: {
      building_id: prepared.run.building_id,
      name: prepared.run.building_name,
      timezone: prepared.run.timezone,
    },
    run: {
      run_id: prepared.run.run_id,
      scenario_id: prepared.run.scenario_id,
      comparison_id: prepared.run.comparison_id,
      run_start_utc: prepared.run.run_start_utc,
    },
    export: {
      // Format-independent and selection/content-specific. Equivalent JSON/CSV
      // for one unchanged snapshot therefore share the auditor import identity;
      // any changed range/resolution/content receives a different identity.
      export_id: `export-${digest.slice(0, 32)}`,
      export_start_utc: selection.fromUtc,
      export_end_utc: selection.toUtc,
      interval_seconds: selection.intervalSeconds,
      created_utc: utcNow(now),
    },
    rooms: prepared.rooms,
    devices: prepared.devices,
    policies: prepared.policies,
  };
  const metadataBytes = Buffer.byteLength(JSON.stringify({
    schema_version: metadata.schema_version,
    source: metadata.source,
    synthetic: metadata.synthetic,
    synthetic_label: metadata.synthetic_label,
    created_note: 'Committed persisted readings only; no fault truth is included.',
    building: metadata.building,
    run: metadata.run,
    export: metadata.export,
    rooms: metadata.rooms,
    devices: metadata.devices,
    policies: metadata.policies,
  }), 'utf8');
  if (metadataBytes > MAX_AUDITOR_METADATA_BYTES) {
    tooLarge(`Export metadata is ${metadataBytes} bytes; the supported limit is ${MAX_AUDITOR_METADATA_BYTES}.`, 'policies');
  }
  const minutesPerBucket = selection.intervalSeconds / SOURCE_INTERVAL_SECONDS;
  const outputBuckets = Math.ceil(sourceSlots / minutesPerBucket);
  return {
    selection,
    metadata,
    activationMode: prepared.activationMode,
    sourceDeviceRows,
    sourceRoomRows,
    outputDeviceRows: outputBuckets * prepared.devices.length,
    outputRoomRows: outputBuckets * prepared.rooms.length,
    sourceSlotCount: sourceSlots,
  };
}

function deviceToOutput(row: DeviceSourceRow): DeviceIntervalRecord {
  return {
    run_id: row.run_id,
    room_id: row.room_id,
    device_id: row.device_id,
    interval_start_utc: row.interval_start_utc,
    interval_end_utc: row.interval_end_utc,
    interval_seconds: row.interval_seconds,
    avg_power_w: row.avg_power_w,
    max_power_w: row.max_power_w,
    energy_kwh: row.energy_kwh,
    cumulative_kwh: row.cumulative_kwh,
    ...(row.avg_voltage_v === null ? {} : { avg_voltage_v: row.avg_voltage_v }),
    ...(row.avg_current_a === null ? {} : { avg_current_a: row.avg_current_a }),
    power_factor: row.power_factor,
    on_fraction: row.on_fraction,
    override_seconds: row.override_seconds,
    vacant_on_seconds: row.vacant_on_seconds,
    offschedule_on_seconds: row.offschedule_on_seconds,
    policy_ref: row.policy_ref,
    partial: row.partial === 1,
  };
}

function roomToOutput(row: RoomSourceRow): RoomIntervalRecord {
  return {
    run_id: row.run_id,
    room_id: row.room_id,
    interval_start_utc: row.interval_start_utc,
    interval_end_utc: row.interval_end_utc,
    interval_seconds: row.interval_seconds,
    occupancy_avg: row.occupancy_avg,
    occupancy_max: row.occupancy_max,
    occupied_fraction: row.occupied_fraction,
    avg_temp_c: row.avg_temp_c,
    avg_rh_pct: row.avg_rh_pct,
    partial: row.partial === 1,
  };
}

interface RoomAggregate {
  duration: number;
  occupancyAvgSum: number;
  occupancyMax: number;
  occupiedFractionSum: number;
  tempSum: number;
  rhSum: number;
  partial: boolean;
}

interface DeviceAggregate {
  roomId: string;
  deviceId: string;
  duration: number;
  energy: number;
  weightedPower: number;
  maxPower: number;
  cumulative: number;
  weightedOnFraction: number;
  overrideSeconds: number;
  vacantOnSeconds: number;
  offscheduleOnSeconds: number;
  policyRef: string;
  powerFactor: number;
  voltagePresent: boolean;
  currentPresent: boolean;
  weightedVoltage: number;
  weightedCurrent: number;
  partial: boolean;
}

function bucketStart(rowStart: number, from: number, intervalSeconds: number): number {
  return from + Math.floor((rowStart - from) / intervalSeconds) * intervalSeconds;
}

function finishRoomAggregate(
  roomId: string,
  runId: string,
  start: number,
  end: number,
  from: number,
  nominalIntervalSeconds: number,
  aggregate: RoomAggregate,
  historicalFirst: boolean,
): RoomIntervalRecord {
  return {
    run_id: runId,
    room_id: roomId,
    interval_start_utc: utcFromSeconds(start),
    interval_end_utc: utcFromSeconds(end),
    interval_seconds: end - start,
    occupancy_avg: aggregate.occupancyAvgSum / aggregate.duration,
    occupancy_max: aggregate.occupancyMax,
    occupied_fraction: aggregate.occupiedFractionSum / aggregate.duration,
    avg_temp_c: aggregate.tempSum / aggregate.duration,
    avg_rh_pct: aggregate.rhSum / aggregate.duration,
    partial: aggregate.partial || (historicalFirst && start === from) || (end - start < nominalIntervalSeconds),
  };
}

export function* iterateRoomIntervals(db: Database, prepared: PreparedExport): Generator<RoomIntervalRecord> {
  const selection = prepared.selection;
  const from = seconds(selection.fromUtc);
  const to = seconds(selection.toUtc);
  const historicalFirst = selection.fromUtc !== prepared.metadata.run.run_start_utc;
  let currentStart: number | null = null;
  let aggregates = new Map<string, RoomAggregate>();
  const rows = db.prepare(`SELECT run_id, room_id, interval_start_utc, interval_end_utc,
      interval_seconds, occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial
      FROM room_intervals WHERE run_id = ? AND interval_start_utc >= ? AND interval_start_utc < ?
      ORDER BY interval_start_utc, room_id`).iterate(
    selection.runId, selection.fromUtc, selection.toUtc,
  ) as unknown as IterableIterator<RoomSourceRow>;

  function* flush(start: number): Generator<RoomIntervalRecord> {
    const end = Math.min(start + selection.intervalSeconds, to);
    for (const [roomId, aggregate] of aggregates) {
      yield finishRoomAggregate(roomId, selection.runId, start, end, from, selection.intervalSeconds, aggregate, historicalFirst);
    }
  }

  for (const row of rows) {
    const output = roomToOutput(row);
    const start = bucketStart(seconds(output.interval_start_utc), from, selection.intervalSeconds);
    if (currentStart === null) currentStart = start;
    if (start !== currentStart) {
      yield* flush(currentStart);
      currentStart = start;
      aggregates = new Map();
    }
    const duration = output.interval_seconds;
    const current = aggregates.get(output.room_id) ?? {
      duration: 0,
      occupancyAvgSum: 0,
      occupancyMax: 0,
      occupiedFractionSum: 0,
      tempSum: 0,
      rhSum: 0,
      partial: false,
    };
    current.duration += duration;
    current.occupancyAvgSum += output.occupancy_avg * duration;
    current.occupancyMax = Math.max(current.occupancyMax, output.occupancy_max);
    current.occupiedFractionSum += output.occupied_fraction * duration;
    current.tempSum += output.avg_temp_c * duration;
    current.rhSum += output.avg_rh_pct * duration;
    current.partial ||= output.partial;
    aggregates.set(output.room_id, current);
  }
  if (currentStart !== null) yield* flush(currentStart);
}

function finishDeviceAggregate(
  start: number,
  end: number,
  from: number,
  nominalIntervalSeconds: number,
  aggregate: DeviceAggregate,
  runId: string,
  historicalFirst: boolean,
): DeviceIntervalRecord {
  return {
    run_id: runId,
    room_id: aggregate.roomId,
    device_id: aggregate.deviceId,
    interval_start_utc: utcFromSeconds(start),
    interval_end_utc: utcFromSeconds(end),
    interval_seconds: end - start,
    avg_power_w: aggregate.weightedPower / aggregate.duration,
    max_power_w: aggregate.maxPower,
    energy_kwh: aggregate.energy,
    cumulative_kwh: aggregate.cumulative,
    ...(aggregate.voltagePresent ? { avg_voltage_v: aggregate.weightedVoltage / aggregate.duration } : {}),
    ...(aggregate.currentPresent ? { avg_current_a: aggregate.weightedCurrent / aggregate.duration } : {}),
    power_factor: aggregate.powerFactor,
    on_fraction: aggregate.weightedOnFraction / aggregate.duration,
    override_seconds: aggregate.overrideSeconds,
    vacant_on_seconds: aggregate.vacantOnSeconds,
    offschedule_on_seconds: aggregate.offscheduleOnSeconds,
    policy_ref: aggregate.policyRef,
    partial: aggregate.partial || (historicalFirst && start === from) || (end - start < nominalIntervalSeconds),
  };
}

export function* iterateDeviceIntervals(db: Database, prepared: PreparedExport): Generator<DeviceIntervalRecord> {
  const selection = prepared.selection;
  const from = seconds(selection.fromUtc);
  const to = seconds(selection.toUtc);
  const historicalFirst = selection.fromUtc !== prepared.metadata.run.run_start_utc;
  let currentStart: number | null = null;
  let aggregates = new Map<string, DeviceAggregate>();
  const rows = db.prepare(`SELECT run_id, room_id, device_id, interval_start_utc, interval_end_utc,
      interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh,
      avg_voltage_v, avg_current_a, power_factor, on_fraction, override_seconds,
      vacant_on_seconds, offschedule_on_seconds, policy_ref, partial
      FROM device_intervals WHERE run_id = ? AND interval_start_utc >= ? AND interval_start_utc < ?
      ORDER BY interval_start_utc, device_id`).iterate(
    selection.runId, selection.fromUtc, selection.toUtc,
  ) as unknown as IterableIterator<DeviceSourceRow>;

  function* flush(start: number): Generator<DeviceIntervalRecord> {
    const end = Math.min(start + selection.intervalSeconds, to);
    for (const aggregate of aggregates.values()) {
      yield finishDeviceAggregate(start, end, from, selection.intervalSeconds, aggregate, selection.runId, historicalFirst);
    }
  }

  for (const row of rows) {
    const output = deviceToOutput(row);
    const start = bucketStart(seconds(output.interval_start_utc), from, selection.intervalSeconds);
    if (currentStart === null) currentStart = start;
    if (start !== currentStart) {
      yield* flush(currentStart);
      currentStart = start;
      aggregates = new Map();
    }
    const duration = output.interval_seconds;
    const current = aggregates.get(output.device_id) ?? {
      roomId: output.room_id,
      deviceId: output.device_id,
      duration: 0,
      energy: 0,
      weightedPower: 0,
      maxPower: 0,
      cumulative: output.cumulative_kwh,
      weightedOnFraction: 0,
      overrideSeconds: 0,
      vacantOnSeconds: 0,
      offscheduleOnSeconds: 0,
      policyRef: output.policy_ref,
      powerFactor: output.power_factor,
      voltagePresent: output.avg_voltage_v !== undefined,
      currentPresent: output.avg_current_a !== undefined,
      weightedVoltage: 0,
      weightedCurrent: 0,
      partial: false,
    };
    current.duration += duration;
    current.energy += output.energy_kwh;
    current.weightedPower += output.avg_power_w * duration;
    current.maxPower = Math.max(current.maxPower, output.max_power_w);
    current.cumulative = output.cumulative_kwh;
    current.weightedOnFraction += output.on_fraction * duration;
    current.overrideSeconds += output.override_seconds;
    current.vacantOnSeconds += output.vacant_on_seconds;
    current.offscheduleOnSeconds += output.offschedule_on_seconds;
    current.weightedVoltage += (output.avg_voltage_v ?? 0) * duration;
    current.weightedCurrent += (output.avg_current_a ?? 0) * duration;
    current.partial ||= output.partial;
    aggregates.set(output.device_id, current);
  }
  if (currentStart !== null) yield* flush(currentStart);
}
