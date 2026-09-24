import { assertDevice, assertRoom } from '../../contract/validators.js';
import { utcNow } from '../clock.js';
import { type Database, transaction } from '../connection.js';
import { addPolicyVersion } from '../inventory.js';
import { currentSchemaVersion, latestKnownVersion } from '../migrate.js';
import { DEMO_BUILDING, DEMO_DEVICES, DEMO_POLICIES, DEMO_ROOMS, SEED_EFFECTIVE_FROM_UTC } from './demoInventory.js';

export interface SeedCounts {
  inserted: number;
  existing: number;
}

export interface SeedReport {
  buildings: SeedCounts;
  rooms: SeedCounts;
  devices: SeedCounts;
  policies: SeedCounts;
  policy_versions: SeedCounts;
}

/**
 * Inserts only MISSING demo records, in one transaction. Existing rows are
 * never updated or deleted, so user edits survive re-running. No runs or
 * readings are created. A destructive reset is deliberately not provided.
 */
export function seedDemoInventory(db: Database, now: Date = new Date()): SeedReport {
  const version = currentSchemaVersion(db);
  if (version !== latestKnownVersion()) {
    throw new Error(`Database schema is at version ${version}, expected ${latestKnownVersion()}; run migrations first (npm run db:migrate)`);
  }
  DEMO_ROOMS.forEach(assertRoom);
  DEMO_DEVICES.forEach(assertDevice);

  const ts = utcNow(now);
  const counts = (): SeedCounts => ({ inserted: 0, existing: 0 });
  const report: SeedReport = {
    buildings: counts(), rooms: counts(), devices: counts(), policies: counts(), policy_versions: counts(),
  };
  const tally = (c: SeedCounts, changes: number | bigint): void => {
    if (Number(changes) > 0) c.inserted++;
    else c.existing++;
  };

  return transaction(db, () => {
    tally(report.buildings, db.prepare(`INSERT INTO buildings (building_id, name, timezone, created_utc)
        VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(DEMO_BUILDING.building_id, DEMO_BUILDING.name, DEMO_BUILDING.timezone, ts).changes);

    const room = db.prepare(`INSERT INTO rooms (room_id, building_id, name, room_type, capacity, floor_area_m2,
        created_utc, updated_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
    for (const r of DEMO_ROOMS) {
      tally(report.rooms, room.run(r.room_id, DEMO_BUILDING.building_id, r.name, r.room_type, r.capacity,
        r.floor_area_m2 ?? null, ts, ts).changes);
    }

    const device = db.prepare(`INSERT INTO devices (device_id, room_id, name, device_type, quantity, nominal_power_w,
        standby_power_w, power_factor, always_on, control, controls, created_utc, updated_utc)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
    for (const d of DEMO_DEVICES) {
      tally(report.devices, device.run(d.device_id, d.room_id, d.name, d.device_type, d.quantity, d.nominal_power_w,
        d.standby_power_w ?? null, d.power_factor, d.always_on ? 1 : 0, d.control, JSON.stringify(d.controls), ts, ts).changes);
    }

    const policy = db.prepare(`INSERT INTO policies (policy_id, kind, building_id, device_id, created_utc)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
    const hasVersion = db.prepare('SELECT 1 AS present FROM policy_versions WHERE policy_id = ? LIMIT 1');
    for (const p of DEMO_POLICIES) {
      const buildingId = 'building_id' in p.owner ? p.owner.building_id : null;
      const deviceId = 'device_id' in p.owner ? p.owner.device_id : null;
      tally(report.policies, policy.run(p.policy_id, p.kind, buildingId, deviceId, ts).changes);
      // Version 1 only when the policy has no versions yet; later versions are the user's.
      if (hasVersion.get(p.policy_id)) {
        report.policy_versions.existing++;
      } else {
        addPolicyVersion(db, { policy_id: p.policy_id, effective_from_utc: SEED_EFFECTIVE_FROM_UTC, rules: p.rules }, now);
        report.policy_versions.inserted++;
      }
    }
    return report;
  });
}
