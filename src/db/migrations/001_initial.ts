import type { Migration } from './types.js';

// FROZEN once applied anywhere: the runner stores a checksum of this SQL and
// refuses to start if it changes. Schema changes go in a new migration.
//
// Conventions (contract 1.0.1, dataset.schema.json):
// - ids: 1–128 chars of [A-Za-z0-9_-]; UTC timestamps: YYYY-MM-DDTHH:MM:SSZ
//   (pattern + a real calendar value via unixepoch()).
// - Power in W, energy in kWh (REAL, 12 dp export precision fits a double).
// - devices.nominal_power_w is the WHOLE device/group rating; quantity is the
//   member count and is never multiplied into it again (8 x 120 W => 960 W).
// - Policy versions and run snapshots are immutable (triggers). Runs pin the
//   exact inventory and policy versions they were created with, so later
//   edits to current inventory/schedules cannot change historical meaning.
// - Telemetry tables have closed column sets: no fault-label columns exist.
const sql = `
CREATE TABLE buildings (
  building_id TEXT PRIMARY KEY
    CHECK (length(building_id) BETWEEN 1 AND 128 AND building_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  name TEXT NOT NULL CHECK (length(name) >= 1),
  timezone TEXT NOT NULL CHECK (timezone = 'Asia/Kolkata'),
  created_utc TEXT NOT NULL
) STRICT;

CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY
    CHECK (length(room_id) BETWEEN 1 AND 128 AND room_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  building_id TEXT NOT NULL REFERENCES buildings (building_id),
  name TEXT NOT NULL CHECK (length(name) >= 1),
  room_type TEXT NOT NULL CHECK (length(room_type) >= 1),
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 0 AND 500),
  floor_area_m2 REAL CHECK (floor_area_m2 IS NULL OR floor_area_m2 > 0),
  created_utc TEXT NOT NULL,
  updated_utc TEXT NOT NULL
) STRICT;
CREATE INDEX rooms_building ON rooms (building_id);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY
    CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  room_id TEXT NOT NULL REFERENCES rooms (room_id),
  name TEXT NOT NULL CHECK (length(name) >= 1),
  device_type TEXT NOT NULL CHECK (device_type IN
    ('lighting', 'ac', 'fan', 'refrigerator', 'microwave', 'projector', 'computer', 'workstation_group')),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  nominal_power_w REAL NOT NULL CHECK (nominal_power_w BETWEEN 0 AND 100000),
  standby_power_w REAL CHECK (standby_power_w IS NULL OR standby_power_w BETWEEN 0 AND 100000),
  power_factor REAL NOT NULL CHECK (power_factor BETWEEN 0.1 AND 1.0),
  always_on INTEGER NOT NULL CHECK (always_on IN (0, 1)),
  control TEXT NOT NULL CHECK (control IN ('manual', 'scheduled', 'always_on')),
  controls TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(controls) AND json_type(controls) = 'array'),
  created_utc TEXT NOT NULL,
  updated_utc TEXT NOT NULL
) STRICT;
CREATE INDEX devices_room ON devices (room_id);

-- Policy identity, kind and owner (exactly one of building/room/device).
CREATE TABLE policies (
  policy_id TEXT PRIMARY KEY
    CHECK (length(policy_id) BETWEEN 1 AND 128 AND policy_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  kind TEXT NOT NULL CHECK (kind IN
    ('office_hours', 'lighting_schedule', 'device_schedule', 'always_on', 'occupancy')),
  building_id TEXT REFERENCES buildings (building_id),
  room_id TEXT REFERENCES rooms (room_id),
  device_id TEXT REFERENCES devices (device_id),
  applies_to TEXT GENERATED ALWAYS AS (CASE
    WHEN device_id IS NOT NULL THEN 'device:' || device_id
    WHEN room_id IS NOT NULL THEN 'room:' || room_id
    ELSE 'building:' || building_id END) VIRTUAL,
  created_utc TEXT NOT NULL,
  CHECK ((building_id IS NOT NULL) + (room_id IS NOT NULL) + (device_id IS NOT NULL) = 1)
) STRICT;
CREATE INDEX policies_device ON policies (device_id);
CREATE INDEX policies_room ON policies (room_id);
CREATE INDEX policies_building ON policies (building_id);
CREATE TRIGGER policies_immutable BEFORE UPDATE ON policies
BEGIN SELECT RAISE(ABORT, 'policy identity, kind and owner are immutable'); END;

-- Immutable, contiguous policy versions; rules are kind-specific JSON
-- (structure validated against the contract $defs by the application).
CREATE TABLE policy_versions (
  policy_id TEXT NOT NULL REFERENCES policies (policy_id),
  version INTEGER NOT NULL CHECK (version >= 1),
  effective_from_utc TEXT NOT NULL CHECK (effective_from_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
    AND unixepoch(effective_from_utc) IS NOT NULL),
  rules TEXT NOT NULL CHECK (json_valid(rules) AND json_type(rules) = 'object'),
  created_utc TEXT NOT NULL,
  PRIMARY KEY (policy_id, version)
) STRICT;
CREATE TRIGGER policy_versions_contiguous BEFORE INSERT ON policy_versions
WHEN NEW.version <> coalesce((SELECT max(version) FROM policy_versions WHERE policy_id = NEW.policy_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'policy versions must be inserted as max(version) + 1'); END;
CREATE TRIGGER policy_versions_office_hours_ref BEFORE INSERT ON policy_versions
WHEN (SELECT kind FROM policies WHERE policy_id = NEW.policy_id) = 'device_schedule'
  AND NOT EXISTS (
    SELECT 1 FROM policy_versions pv JOIN policies p ON p.policy_id = pv.policy_id
    WHERE p.kind = 'office_hours'
      AND pv.policy_id || ':' || pv.version = json_extract(NEW.rules, '$.office_hours_ref'))
BEGIN SELECT RAISE(ABORT, 'device_schedule office_hours_ref must name an existing office_hours policy version'); END;
CREATE TRIGGER policy_versions_no_update BEFORE UPDATE ON policy_versions
BEGIN SELECT RAISE(ABORT, 'policy versions are immutable; insert a new version'); END;
CREATE TRIGGER policy_versions_no_delete BEFORE DELETE ON policy_versions
BEGIN SELECT RAISE(ABORT, 'policy versions are immutable'); END;

CREATE VIEW current_policy_versions AS
SELECT p.policy_id, pv.version, p.applies_to, p.kind, pv.effective_from_utc, pv.rules,
       p.building_id, p.room_id, p.device_id
FROM policies p
JOIN policy_versions pv ON pv.policy_id = p.policy_id
WHERE pv.version = (SELECT max(version) FROM policy_versions x WHERE x.policy_id = p.policy_id);

-- Simulation runs: identity + immutable configuration. A reset creates a new run.
CREATE TABLE simulation_runs (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 128),
  building_id TEXT NOT NULL REFERENCES buildings (building_id),
  building_name TEXT NOT NULL CHECK (length(building_name) >= 1),
  timezone TEXT NOT NULL CHECK (timezone = 'Asia/Kolkata'),
  scenario_id TEXT NOT NULL CHECK (scenario_id IN ('original', 'improved')),
  comparison_id TEXT CHECK (comparison_id IS NULL OR length(comparison_id) BETWEEN 1 AND 128),
  run_start_utc TEXT NOT NULL CHECK (run_start_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
    AND unixepoch(run_start_utc) IS NOT NULL),
  config TEXT NOT NULL CHECK (json_valid(config) AND json_type(config) = 'object'),
  created_utc TEXT NOT NULL
) STRICT;
CREATE TRIGGER simulation_runs_no_update BEFORE UPDATE ON simulation_runs
BEGIN SELECT RAISE(ABORT, 'simulation runs and their configuration are immutable'); END;
CREATE TRIGGER simulation_runs_no_delete BEFORE DELETE ON simulation_runs
BEGIN SELECT RAISE(ABORT, 'simulation runs are immutable history'); END;

-- Run-specific inventory snapshots (copied, not referenced, from current inventory).
CREATE TABLE run_rooms (
  run_id TEXT NOT NULL REFERENCES simulation_runs (run_id),
  room_id TEXT NOT NULL
    CHECK (length(room_id) BETWEEN 1 AND 128 AND room_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  name TEXT NOT NULL,
  room_type TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 0 AND 500),
  floor_area_m2 REAL CHECK (floor_area_m2 IS NULL OR floor_area_m2 > 0),
  PRIMARY KEY (run_id, room_id)
) STRICT;

CREATE TABLE run_devices (
  run_id TEXT NOT NULL,
  device_id TEXT NOT NULL
    CHECK (length(device_id) BETWEEN 1 AND 128 AND device_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  room_id TEXT NOT NULL,
  name TEXT NOT NULL,
  device_type TEXT NOT NULL CHECK (device_type IN
    ('lighting', 'ac', 'fan', 'refrigerator', 'microwave', 'projector', 'computer', 'workstation_group')),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  nominal_power_w REAL NOT NULL CHECK (nominal_power_w BETWEEN 0 AND 100000),
  standby_power_w REAL CHECK (standby_power_w IS NULL OR standby_power_w BETWEEN 0 AND 100000),
  power_factor REAL NOT NULL CHECK (power_factor BETWEEN 0.1 AND 1.0),
  always_on INTEGER NOT NULL CHECK (always_on IN (0, 1)),
  control TEXT NOT NULL CHECK (control IN ('manual', 'scheduled', 'always_on')),
  controls TEXT NOT NULL CHECK (json_valid(controls) AND json_type(controls) = 'array'),
  PRIMARY KEY (run_id, device_id),
  UNIQUE (run_id, device_id, room_id),
  FOREIGN KEY (run_id, room_id) REFERENCES run_rooms (run_id, room_id)
) STRICT;

-- Exact (immutable) policy versions in force for a run. A mid-run change adds
-- another version row; existing rows never change.
CREATE TABLE run_policies (
  run_id TEXT NOT NULL REFERENCES simulation_runs (run_id),
  policy_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (run_id, policy_id, version),
  FOREIGN KEY (policy_id, version) REFERENCES policy_versions (policy_id, version)
) STRICT;

CREATE TRIGGER run_rooms_no_update BEFORE UPDATE ON run_rooms
BEGIN SELECT RAISE(ABORT, 'run snapshots are immutable'); END;
CREATE TRIGGER run_rooms_no_delete BEFORE DELETE ON run_rooms
BEGIN SELECT RAISE(ABORT, 'run snapshots are immutable'); END;
CREATE TRIGGER run_devices_no_update BEFORE UPDATE ON run_devices
BEGIN SELECT RAISE(ABORT, 'run snapshots are immutable'); END;
CREATE TRIGGER run_devices_no_delete BEFORE DELETE ON run_devices
BEGIN SELECT RAISE(ABORT, 'run snapshots are immutable'); END;
CREATE TRIGGER run_policies_no_update BEFORE UPDATE ON run_policies
BEGIN SELECT RAISE(ABORT, 'run snapshots are immutable'); END;
CREATE TRIGGER run_policies_no_delete BEFORE DELETE ON run_policies
BEGIN SELECT RAISE(ABORT, 'run snapshots are immutable'); END;

-- Interval readings. Keys per contract: (run_id, room_id|device_id, interval_start_utc).
CREATE TABLE room_intervals (
  run_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  interval_start_utc TEXT NOT NULL CHECK (interval_start_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
    AND unixepoch(interval_start_utc) IS NOT NULL),
  interval_end_utc TEXT NOT NULL CHECK (interval_end_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
    AND unixepoch(interval_end_utc) IS NOT NULL),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 1),
  occupancy_avg REAL NOT NULL CHECK (occupancy_avg BETWEEN 0 AND 1000),
  occupancy_max INTEGER NOT NULL CHECK (occupancy_max BETWEEN 0 AND 1000),
  occupied_fraction REAL NOT NULL CHECK (occupied_fraction BETWEEN 0 AND 1),
  avg_temp_c REAL NOT NULL CHECK (avg_temp_c BETWEEN -30 AND 60),
  avg_rh_pct REAL NOT NULL CHECK (avg_rh_pct BETWEEN 0 AND 100),
  partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
  PRIMARY KEY (run_id, room_id, interval_start_utc),
  FOREIGN KEY (run_id, room_id) REFERENCES run_rooms (run_id, room_id),
  CHECK (unixepoch(interval_end_utc) > unixepoch(interval_start_utc)),
  CHECK (occupancy_max >= occupancy_avg)
) STRICT;
CREATE INDEX room_intervals_run_time ON room_intervals (run_id, interval_start_utc);

CREATE TABLE device_intervals (
  run_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  interval_start_utc TEXT NOT NULL CHECK (interval_start_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
    AND unixepoch(interval_start_utc) IS NOT NULL),
  interval_end_utc TEXT NOT NULL CHECK (interval_end_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
    AND unixepoch(interval_end_utc) IS NOT NULL),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 1),
  avg_power_w REAL NOT NULL CHECK (avg_power_w BETWEEN 0 AND 100000),
  max_power_w REAL NOT NULL CHECK (max_power_w BETWEEN 0 AND 100000),
  energy_kwh REAL NOT NULL CHECK (energy_kwh BETWEEN 0 AND 100000),
  cumulative_kwh REAL NOT NULL CHECK (cumulative_kwh BETWEEN 0 AND 100000000),
  avg_voltage_v REAL CHECK (avg_voltage_v IS NULL OR avg_voltage_v BETWEEN 0 AND 500),
  avg_current_a REAL CHECK (avg_current_a IS NULL OR avg_current_a BETWEEN 0 AND 500),
  power_factor REAL NOT NULL CHECK (power_factor BETWEEN 0.1 AND 1.0),
  on_fraction REAL NOT NULL CHECK (on_fraction BETWEEN 0 AND 1),
  override_seconds REAL NOT NULL CHECK (override_seconds >= 0 AND override_seconds <= interval_seconds),
  vacant_on_seconds REAL NOT NULL CHECK (vacant_on_seconds >= 0 AND vacant_on_seconds <= interval_seconds),
  offschedule_on_seconds REAL NOT NULL
    CHECK (offschedule_on_seconds >= 0 AND offschedule_on_seconds <= interval_seconds),
  policy_id TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  policy_ref TEXT GENERATED ALWAYS AS (policy_id || ':' || policy_version) VIRTUAL,
  partial INTEGER NOT NULL CHECK (partial IN (0, 1)),
  PRIMARY KEY (run_id, device_id, interval_start_utc),
  FOREIGN KEY (run_id, device_id, room_id) REFERENCES run_devices (run_id, device_id, room_id),
  FOREIGN KEY (run_id, policy_id, policy_version) REFERENCES run_policies (run_id, policy_id, version),
  CHECK (unixepoch(interval_end_utc) > unixepoch(interval_start_utc)),
  CHECK (max_power_w >= avg_power_w)
) STRICT;
CREATE INDEX device_intervals_run_time ON device_intervals (run_id, interval_start_utc);
CREATE INDEX device_intervals_policy ON device_intervals (run_id, policy_id, policy_version);
`;

export const migration001: Migration = { version: 1, name: 'initial_inventory_runs_readings', sql };
