import { assertRules, isPolicyKind, type PolicyKind } from '../contract/validators.js';
import { utcNow } from './clock.js';
import type { Database } from './connection.js';

// Contract-shaped inventory records (dataset.schema.json rooms/devices/policies items).
export interface Room {
  room_id: string;
  name: string;
  room_type: string;
  capacity: number;
  floor_area_m2?: number;
}

export interface Device {
  device_id: string;
  name: string;
  room_id: string;
  device_type: string;
  quantity: number;
  /** Rating of the whole device or group (not per member). */
  nominal_power_w: number;
  standby_power_w?: number;
  power_factor: number;
  always_on: boolean;
  control: 'manual' | 'scheduled' | 'always_on';
  controls: string[];
}

export interface Policy {
  policy_id: string;
  version: number;
  applies_to: string;
  kind: PolicyKind;
  effective_from_utc: string;
  rules: Record<string, unknown>;
}

export interface Inventory {
  rooms: Room[];
  devices: Device[];
  policies: Policy[];
}

interface RoomRow { room_id: string; name: string; room_type: string; capacity: number; floor_area_m2: number | null }
interface DeviceRow {
  device_id: string; name: string; room_id: string; device_type: string; quantity: number;
  nominal_power_w: number; standby_power_w: number | null; power_factor: number; always_on: number;
  control: Device['control']; controls: string;
}
interface PolicyRow { policy_id: string; version: number; applies_to: string; kind: PolicyKind; effective_from_utc: string; rules: string }

export const toRoom = (r: RoomRow): Room => ({
  room_id: r.room_id, name: r.name, room_type: r.room_type, capacity: r.capacity,
  ...(r.floor_area_m2 === null ? {} : { floor_area_m2: r.floor_area_m2 }),
});

export const toDevice = (d: DeviceRow): Device => ({
  device_id: d.device_id, name: d.name, room_id: d.room_id, device_type: d.device_type,
  quantity: d.quantity, nominal_power_w: d.nominal_power_w,
  ...(d.standby_power_w === null ? {} : { standby_power_w: d.standby_power_w }),
  power_factor: d.power_factor, always_on: d.always_on === 1, control: d.control,
  controls: JSON.parse(d.controls) as string[],
});

const toPolicy = (p: PolicyRow): Policy => ({
  policy_id: p.policy_id, version: p.version, applies_to: p.applies_to, kind: p.kind,
  effective_from_utc: p.effective_from_utc, rules: JSON.parse(p.rules) as Record<string, unknown>,
});

/** Current inventory: all rooms and devices, and the latest version of every policy. */
export function getInventory(db: Database): Inventory {
  const rooms = db.prepare('SELECT room_id, name, room_type, capacity, floor_area_m2 FROM rooms ORDER BY room_id')
    .all() as unknown as RoomRow[];
  const devices = db.prepare(`SELECT device_id, name, room_id, device_type, quantity, nominal_power_w,
      standby_power_w, power_factor, always_on, control, controls FROM devices ORDER BY device_id`)
    .all() as unknown as DeviceRow[];
  const policies = db.prepare(`SELECT policy_id, version, applies_to, kind, effective_from_utc, rules
      FROM current_policy_versions ORDER BY policy_id`).all() as unknown as PolicyRow[];
  return { rooms: rooms.map(toRoom), devices: devices.map(toDevice), policies: policies.map(toPolicy) };
}

export interface NewPolicyVersion {
  policy_id: string;
  effective_from_utc: string;
  rules: Record<string, unknown>;
}

/**
 * Appends the next immutable version of an existing policy after validating
 * its rules against the contract for the policy's kind. Returns the version.
 */
export function addPolicyVersion(db: Database, input: NewPolicyVersion, now: Date = new Date()): number {
  const head = db.prepare('SELECT kind FROM policies WHERE policy_id = ?').get(input.policy_id) as { kind: string } | undefined;
  if (!head) throw new Error(`Unknown policy "${input.policy_id}"`);
  if (!isPolicyKind(head.kind)) throw new Error(`Unknown policy kind "${head.kind}"`);
  assertRules(head.kind, input.rules);
  const { next } = db.prepare('SELECT coalesce(max(version), 0) + 1 AS next FROM policy_versions WHERE policy_id = ?')
    .get(input.policy_id) as { next: number };
  db.prepare(`INSERT INTO policy_versions (policy_id, version, effective_from_utc, rules, created_utc)
      VALUES (?, ?, ?, ?, ?)`).run(input.policy_id, next, input.effective_from_utc, JSON.stringify(input.rules), utcNow(now));
  return next;
}
