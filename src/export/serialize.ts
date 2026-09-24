import { ApiError } from '../http/errors.js';
import { iterateDeviceIntervals, iterateRoomIntervals, type PreparedExport } from './dataset.js';
import type { Database } from '../db/connection.js';
import type { DeviceIntervalRecord, RoomIntervalRecord } from './types.js';

function rounded(value: number, places: number): number {
  if (!Number.isFinite(value)) throw new Error('Cannot serialize a non-finite number.');
  const scale = 10 ** places;
  const result = Math.round((value + Number.EPSILON * Math.sign(value)) * scale) / scale;
  return Object.is(result, -0) ? 0 : result;
}

function normalizeRoom(row: RoomIntervalRecord): RoomIntervalRecord {
  return {
    ...row,
    occupancy_avg: rounded(row.occupancy_avg, 12),
    occupied_fraction: rounded(row.occupied_fraction, 12),
    avg_temp_c: rounded(row.avg_temp_c, 12),
    avg_rh_pct: rounded(row.avg_rh_pct, 12),
  };
}

function normalizeDevice(row: DeviceIntervalRecord): DeviceIntervalRecord {
  return {
    ...row,
    avg_power_w: rounded(row.avg_power_w, 9),
    max_power_w: rounded(row.max_power_w, 9),
    energy_kwh: rounded(row.energy_kwh, 12),
    cumulative_kwh: rounded(row.cumulative_kwh, 12),
    ...(row.avg_voltage_v === undefined ? {} : { avg_voltage_v: rounded(row.avg_voltage_v, 9) }),
    ...(row.avg_current_a === undefined ? {} : { avg_current_a: rounded(row.avg_current_a, 9) }),
    power_factor: rounded(row.power_factor, 12),
    on_fraction: rounded(row.on_fraction, 12),
    override_seconds: rounded(row.override_seconds, 9),
    vacant_on_seconds: rounded(row.vacant_on_seconds, 9),
    offschedule_on_seconds: rounded(row.offschedule_on_seconds, 9),
  };
}

function metadataPrefix(prepared: PreparedExport): string {
  const m = prepared.metadata;
  return [
    '"schema_version":', JSON.stringify(m.schema_version),
    ',"source":', JSON.stringify(m.source),
    ',"synthetic":', JSON.stringify(m.synthetic),
    ',"synthetic_label":', JSON.stringify(m.synthetic_label),
    ',"created_note":', JSON.stringify('Committed persisted readings only; no fault truth is included.'),
    ',"building":', JSON.stringify(m.building),
    ',"run":', JSON.stringify(m.run),
    ',"export":', JSON.stringify(m.export),
    ',"rooms":', JSON.stringify(m.rooms),
    ',"devices":', JSON.stringify(m.devices),
    ',"policies":', JSON.stringify(m.policies),
  ].join('');
}

export function* iterateJsonChunks(db: Database, prepared: PreparedExport): Generator<string> {
  yield `{${metadataPrefix(prepared)},"room_intervals":[`;
  let first = true;
  for (const raw of iterateRoomIntervals(db, prepared)) {
    if (!first) yield ',';
    first = false;
    yield JSON.stringify(normalizeRoom(raw));
  }
  yield '],"device_intervals":[';
  first = true;
  for (const raw of iterateDeviceIntervals(db, prepared)) {
    if (!first) yield ',';
    first = false;
    yield JSON.stringify(normalizeDevice(raw));
  }
  yield ']}';
}

const CSV_HEADER = [
  'run_id',
  'building_id',
  'scenario_id',
  'interval_start_utc',
  'interval_end_utc',
  'interval_seconds',
  'room_id',
  'room_occupancy_avg',
  'room_occupancy_max',
  'room_occupied_fraction',
  'room_temp_c',
  'room_rh_pct',
  'device_id',
  'avg_power_w',
  'max_power_w',
  'energy_kwh',
  'cumulative_kwh',
  'avg_voltage_v',
  'avg_current_a',
  'power_factor',
  'on_fraction',
  'override_seconds',
  'vacant_on_seconds',
  'offschedule_on_seconds',
  'policy_ref',
  'partial',
  'meta_run',
].join(',');

function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'boolean' ? String(value) : typeof value === 'number' ? decimal(value) : value;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Cannot serialize a non-finite CSV number.');
  const text = Math.abs(value) < 1e-12 ? '0' : value.toFixed(12);
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

function roomKey(row: Pick<RoomIntervalRecord, 'interval_start_utc' | 'interval_end_utc' | 'room_id'>): string {
  return `${row.interval_start_utc}|${row.interval_end_utc}|${row.room_id}`;
}

function csvMetadata(prepared: PreparedExport): string {
  const m = prepared.metadata;
  return JSON.stringify({
    schema_version: m.schema_version,
    source: m.source,
    synthetic: m.synthetic,
    synthetic_label: m.synthetic_label,
    created_note: 'Committed persisted readings only; no fault truth is included.',
    building: m.building,
    run: m.run,
    export: m.export,
    rooms: m.rooms,
    devices: m.devices,
    policies: m.policies,
  });
}

export function* iterateCsvChunks(db: Database, prepared: PreparedExport): Generator<string> {
  yield `${CSV_HEADER}\n`;
  const roomIterator = iterateRoomIntervals(db, prepared)[Symbol.iterator]();
  const deviceIterator = iterateDeviceIntervals(db, prepared)[Symbol.iterator]();
  let room = roomIterator.next();
  let device = deviceIterator.next();
  let first = true;

  // Both iterators are ordered by output bucket start. Hold only the rooms for
  // the current bucket, never the complete room history, while CSV repeats each
  // committed room summary on its device rows.
  while (!device.done) {
    const bucketStart = device.value.interval_start_utc;
    const rooms = new Map<string, RoomIntervalRecord>();
    while (!room.done && room.value.interval_start_utc === bucketStart) {
      const normalized = normalizeRoom(room.value);
      rooms.set(roomKey(normalized), normalized);
      room = roomIterator.next();
    }

    while (!device.done && device.value.interval_start_utc === bucketStart) {
      const normalizedDevice = normalizeDevice(device.value);
      const normalizedRoom = rooms.get(roomKey(normalizedDevice));
      if (!normalizedRoom) {
        throw new ApiError(409, 'CONFLICT', `CSV export could not resolve room interval ${roomKey(normalizedDevice)}.`);
      }
      const fields = [
        normalizedDevice.run_id,
        prepared.metadata.building.building_id,
        prepared.metadata.run.scenario_id,
        normalizedDevice.interval_start_utc,
        normalizedDevice.interval_end_utc,
        normalizedDevice.interval_seconds,
        normalizedRoom.room_id,
        normalizedRoom.occupancy_avg,
        normalizedRoom.occupancy_max,
        normalizedRoom.occupied_fraction,
        normalizedRoom.avg_temp_c,
        normalizedRoom.avg_rh_pct,
        normalizedDevice.device_id,
        normalizedDevice.avg_power_w,
        normalizedDevice.max_power_w,
        normalizedDevice.energy_kwh,
        normalizedDevice.cumulative_kwh,
        normalizedDevice.avg_voltage_v,
        normalizedDevice.avg_current_a,
        normalizedDevice.power_factor,
        normalizedDevice.on_fraction,
        normalizedDevice.override_seconds,
        normalizedDevice.vacant_on_seconds,
        normalizedDevice.offschedule_on_seconds,
        normalizedDevice.policy_ref,
        normalizedDevice.partial,
        first ? csvMetadata(prepared) : '',
      ];
      yield `${fields.map(csvField).join(',')}\n`;
      first = false;
      device = deviceIterator.next();
    }
  }
  if (!room.done) {
    throw new ApiError(409, 'CONFLICT', 'CSV export contains room intervals without device rows.');
  }
  if (first) throw new ApiError(422, 'INSUFFICIENT_DATA', 'The export produced no device rows.');
}

export function exportFilename(prepared: PreparedExport): string {
  const run = prepared.metadata.run.run_id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 90);
  return `nexyra-${run}-${prepared.metadata.export.export_id}.${prepared.selection.format}`;
}
