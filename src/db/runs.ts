import { utcNow } from './clock.js';
import { type Database, transaction } from './connection.js';

export interface NewRun {
  run_id: string;
  building_id: string;
  scenario_id: 'original' | 'improved';
  comparison_id?: string | null;
  run_start_utc: string;
  /** Immutable run configuration (JSON object). */
  config: Record<string, unknown>;
}

/**
 * Creates a run and, atomically, its immutable snapshot of the building's
 * current rooms, devices and exact current policy versions. Later edits to
 * current inventory or new policy versions never change what this run means.
 * Used by the future simulation engine; F3-S only exercises it in tests.
 */
export function createRun(db: Database, run: NewRun, now: Date = new Date()): void {
  transaction(db, () => {
    const building = db.prepare('SELECT name, timezone FROM buildings WHERE building_id = ?')
      .get(run.building_id) as { name: string; timezone: string } | undefined;
    if (!building) throw new Error(`Unknown building "${run.building_id}"`);

    db.prepare(`INSERT INTO simulation_runs (run_id, building_id, building_name, timezone, scenario_id,
        comparison_id, run_start_utc, config, created_utc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.run_id, run.building_id, building.name, building.timezone, run.scenario_id,
        run.comparison_id ?? null, run.run_start_utc, JSON.stringify(run.config), utcNow(now));

    db.prepare(`INSERT INTO run_rooms (run_id, room_id, name, room_type, capacity, floor_area_m2)
        SELECT ?, room_id, name, room_type, capacity, floor_area_m2 FROM rooms WHERE building_id = ?`)
      .run(run.run_id, run.building_id);

    db.prepare(`INSERT INTO run_devices (run_id, device_id, room_id, name, device_type, quantity, nominal_power_w,
        standby_power_w, power_factor, always_on, control, controls)
        SELECT ?, d.device_id, d.room_id, d.name, d.device_type, d.quantity, d.nominal_power_w, d.standby_power_w,
               d.power_factor, d.always_on, d.control, d.controls
        FROM devices d JOIN rooms r ON r.room_id = d.room_id WHERE r.building_id = ?`)
      .run(run.run_id, run.building_id);

    db.prepare(`INSERT INTO run_policies (run_id, policy_id, version)
        SELECT ?, c.policy_id, c.version FROM current_policy_versions c
        LEFT JOIN rooms r ON r.room_id = c.room_id
        LEFT JOIN devices d ON d.device_id = c.device_id
        LEFT JOIN rooms dr ON dr.room_id = d.room_id
        WHERE ? IN (c.building_id, r.building_id, dr.building_id)`)
      .run(run.run_id, run.building_id);
  });
}
