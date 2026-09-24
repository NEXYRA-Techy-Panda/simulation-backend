import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { closeDatabase, type Database, openDatabase } from '../src/db/connection.js';
import { addPolicyVersion, getInventory } from '../src/db/inventory.js';
import { MigrationError, migrationChecksum, runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations/index.js';
import { createRun } from '../src/db/runs.js';
import { seedDemoInventory } from '../src/db/seed/seed.js';
import { count, makeTempDir, memoryDb, sqliteError } from './helpers.js';

const FORBIDDEN = ['fault_active', 'fault_type', 'fault_window', 'fault_windows', 'injected_fault',
  'expected_diagnosis', 'expected_finding', 'is_fault', 'fault_label'];

function withFileDb(fn: (path: string) => void): void {
  const tmp = makeTempDir();
  try {
    fn(join(tmp.dir, 'sim.sqlite'));
  } finally {
    tmp.cleanup();
  }
}

const RUN = { building_id: 'nexyra-demo-office', scenario_id: 'original' as const, run_start_utc: '2026-09-21T03:30:00Z' };

function roomInterval(db: Database, over: Record<string, unknown> = {}): void {
  const r = { run_id: 'run-1', room_id: 'room-meeting', start: '2026-09-21T03:30:00Z', end: '2026-09-21T03:31:00Z',
    occupied_fraction: 1, ...over };
  db.prepare(`INSERT INTO room_intervals (run_id, room_id, interval_start_utc, interval_end_utc, interval_seconds,
      occupancy_avg, occupancy_max, occupied_fraction, avg_temp_c, avg_rh_pct, partial)
      VALUES (@run_id, @room_id, @start, @end, 60, 1, 1, @occupied_fraction, 26, 55, 0)`).run(r as never);
}

function deviceInterval(db: Database, over: Record<string, unknown> = {}): void {
  const d = { run_id: 'run-1', device_id: 'dev-meeting-light', room_id: 'room-meeting', start: '2026-09-21T03:30:00Z',
    end: '2026-09-21T03:31:00Z', avg: 72, max: 72, on_fraction: 1, policy_id: 'pol-meeting-light', policy_version: 1, ...over };
  db.prepare(`INSERT INTO device_intervals (run_id, device_id, room_id, interval_start_utc, interval_end_utc,
      interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh, power_factor, on_fraction,
      override_seconds, vacant_on_seconds, offschedule_on_seconds, policy_id, policy_version, partial)
      VALUES (@run_id, @device_id, @room_id, @start, @end, 60, @avg, @max, 0.0012, 0.0012, 0.9, @on_fraction,
      0, 0, 0, @policy_id, @policy_version, 0)`).run(d as never);
}

describe('connection factory', () => {
  it('enforces foreign keys, busy timeout and WAL on a file database', () => {
    withFileDb((path) => {
      const db = openDatabase(path, { busyTimeoutMs: 4321 });
      try {
        assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
        assert.equal((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 4321);
        assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
      } finally {
        closeDatabase(db);
      }
      closeDatabase(db); // idempotent
    });
  });
});

describe('migrations', () => {
  it('fresh migration succeeds and repeated migration is a no-op', () => {
    withFileDb((path) => {
      const db = openDatabase(path);
      try {
        // K002 adds migration 3 (run-scoped policy activation); K005-PREP/K004-FAST1 add branch-local migrations 4–5 (history jobs).
        assert.deepEqual(runMigrations(db), { applied: [1, 2, 3, 4, 5], currentVersion: 5 });
        assert.deepEqual(runMigrations(db), { applied: [], currentVersion: 5 });
        const tables = (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as { name: string }[])
          .map((r) => r.name);
        for (const t of ['buildings', 'rooms', 'devices', 'policies', 'policy_versions', 'simulation_runs', 'run_rooms',
          'run_devices', 'run_policies', 'room_intervals', 'device_intervals', 'schema_migrations', 'engine_checkpoints',
          'history_jobs']) {
          assert.ok(tables.includes(t), `missing table ${t}`);
        }
        const history = db.prepare('SELECT version, name, checksum FROM schema_migrations').all();
        assert.deepEqual(history.map((h) => ({ ...h })),
          migrations.map((m) => ({ version: m.version, name: m.name, checksum: migrationChecksum(m.sql) })));
      } finally {
        closeDatabase(db);
      }
      const reopened = openDatabase(path);
      try {
        assert.deepEqual(runMigrations(reopened).applied, []);
      } finally {
        closeDatabase(reopened);
      }
    });
  });

  it('refuses an applied migration whose SQL changed, without altering the database', () => {
    const db = memoryDb({ seed: false });
    try {
      const edited = [{ ...migrations[0]!, sql: `${migrations[0]!.sql}\n-- edit` }, ...migrations.slice(1)];
      assert.throws(() => runMigrations(db, edited), /migration 1 .* was modified/);
      assert.throws(() => runMigrations(db, migrations.slice(0, 1)), /unknown to this build/);
      assert.throws(() => runMigrations(db, edited), MigrationError);
      assert.equal(count(db, 'schema_migrations'), migrations.length);
    } finally {
      closeDatabase(db);
    }
  });

  it('checksum ignores CRLF vs LF line endings', () => {
    assert.equal(migrationChecksum('a\r\nb'), migrationChecksum('a\nb'));
  });

  it('defines no fault-label columns anywhere', () => {
    const db = memoryDb({ seed: false });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'view')").all() as { name: string }[];
      const columns = tables.flatMap(({ name }) =>
        (db.prepare(`SELECT name FROM pragma_table_xinfo('${name}')`).all() as { name: string }[]).map((c) => c.name));
      assert.ok(columns.length > 50);
      assert.deepEqual(columns.filter((c) => FORBIDDEN.includes(c)), []);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('seed', () => {
  it('creates exactly 5 rooms and 18 devices, idempotently, preserving user edits', () => {
    withFileDb((path) => {
      let db = openDatabase(path);
      try {
        runMigrations(db);
        const first = seedDemoInventory(db);
        assert.deepEqual(first.rooms, { inserted: 5, existing: 0 });
        assert.deepEqual(first.devices, { inserted: 18, existing: 0 });
        assert.deepEqual(first.policies, { inserted: 20, existing: 0 });
        assert.deepEqual([count(db, 'buildings'), count(db, 'rooms'), count(db, 'devices'), count(db, 'policies'),
          count(db, 'policy_versions'), count(db, 'simulation_runs'), count(db, 'device_intervals'),
          count(db, 'room_intervals')], [1, 5, 18, 20, 20, 0, 0, 0]);

        // User edits: device power, room capacity, a new policy version.
        db.prepare("UPDATE devices SET nominal_power_w = 1400 WHERE device_id = 'dev-open-ac'").run();
        db.prepare("UPDATE rooms SET capacity = 10 WHERE room_id = 'room-open-workspace'").run();
        addPolicyVersion(db, { policy_id: 'pol-office-hours', effective_from_utc: '2026-10-01T00:00:00Z',
          rules: { working_days_iso: [1, 2, 3, 4, 5, 6], open_local: '08:00', close_local: '17:00', overnight: false } });
      } finally {
        closeDatabase(db);
      }

      db = openDatabase(path);
      try {
        const second = seedDemoInventory(db);
        assert.deepEqual(second.rooms, { inserted: 0, existing: 5 });
        assert.deepEqual(second.devices, { inserted: 0, existing: 18 });
        assert.deepEqual(second.policies, { inserted: 0, existing: 20 });
        assert.deepEqual(second.policy_versions, { inserted: 0, existing: 20 });
        assert.deepEqual([count(db, 'rooms'), count(db, 'devices'), count(db, 'policies'), count(db, 'policy_versions')],
          [5, 18, 20, 21]);
        const inv = getInventory(db);
        assert.equal(inv.devices.find((d) => d.device_id === 'dev-open-ac')?.nominal_power_w, 1400);
        assert.equal(inv.rooms.find((r) => r.room_id === 'room-open-workspace')?.capacity, 10);
        const hours = inv.policies.find((p) => p.policy_id === 'pol-office-hours');
        assert.deepEqual([hours?.version, hours?.rules.open_local], [2, '08:00']);
      } finally {
        closeDatabase(db);
      }
    });
  });

  it('refuses to seed an unmigrated database', () => {
    const db = openDatabase(':memory:');
    try {
      assert.throws(() => seedDemoInventory(db), /run migrations first/);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('constraints', () => {
  it('rejects invalid references', () => {
    const db = memoryDb();
    try {
      createRun(db, { ...RUN, run_id: 'run-1', config: {} });
      assert.throws(() => db.prepare(`INSERT INTO devices (device_id, room_id, name, device_type, quantity, nominal_power_w,
          power_factor, always_on, control, created_utc, updated_utc)
          VALUES ('dev-x', 'room-missing', 'X', 'fan', 1, 75, 0.8, 0, 'manual', 't', 't')`).run(),
      sqliteError(/FOREIGN KEY/));
      assert.throws(() => db.prepare("DELETE FROM rooms WHERE room_id = 'room-meeting'").run(), sqliteError(/FOREIGN KEY/));
      assert.throws(() => addPolicyVersion(db, { policy_id: 'pol-missing', effective_from_utc: '2026-01-01T00:00:00Z', rules: {} }),
        /Unknown policy/);
      assert.throws(() => addPolicyVersion(db, { policy_id: 'pol-open-ac', effective_from_utc: '2026-01-01T00:00:00Z',
        rules: { office_hours_ref: 'pol-office-hours:9' } }), sqliteError(/office_hours_ref/));
      assert.throws(() => roomInterval(db, { run_id: 'run-missing' }), sqliteError(/FOREIGN KEY/));
      assert.throws(() => roomInterval(db, { room_id: 'room-missing' }), sqliteError(/FOREIGN KEY/));
      assert.throws(() => deviceInterval(db, { device_id: 'dev-missing' }), sqliteError(/FOREIGN KEY/));
      assert.throws(() => deviceInterval(db, { room_id: 'room-pantry' }), sqliteError(/FOREIGN KEY/)); // wrong room for device
      assert.throws(() => deviceInterval(db, { policy_version: 2 }), sqliteError(/FOREIGN KEY/)); // version not in run
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects policy rules that break the contract, including fault_active', () => {
    const db = memoryDb();
    try {
      const eff = '2026-01-01T00:00:00Z';
      assert.throws(() => addPolicyVersion(db, { policy_id: 'pol-meeting-light', effective_from_utc: eff,
        rules: { on_during_hours: true, vacancy_grace_seconds: 300, fault_active: true } }), /does not match contract/);
      assert.throws(() => addPolicyVersion(db, { policy_id: 'pol-pantry-fridge', effective_from_utc: eff, rules: {} }),
        /does not match contract/);
      assert.throws(() => db.prepare("UPDATE policy_versions SET rules = '{}' WHERE policy_id = 'pol-office-hours'").run(),
        sqliteError(/immutable/));
      assert.throws(() => db.prepare("DELETE FROM policy_versions WHERE policy_id = 'pol-office-hours'").run(),
        sqliteError(/immutable/));
      assert.throws(() => db.prepare(`INSERT INTO policy_versions (policy_id, version, effective_from_utc, rules, created_utc)
          VALUES ('pol-office-hours', 5, '2026-01-01T00:00:00Z', '{}', 't')`).run(), sqliteError(/max\(version\) \+ 1/));
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects duplicate interval identities and out-of-range values', () => {
    const db = memoryDb();
    try {
      createRun(db, { ...RUN, run_id: 'run-1', config: {} });
      roomInterval(db);
      deviceInterval(db);
      assert.throws(() => roomInterval(db), sqliteError(/UNIQUE constraint failed: room_intervals/));
      assert.throws(() => deviceInterval(db, { avg: 70, max: 70 }), sqliteError(/UNIQUE constraint failed: device_intervals/));
      assert.throws(() => deviceInterval(db, { start: '2026-09-21T03:31:00Z', end: '2026-09-21T03:32:00Z', on_fraction: 1.5 }),
        sqliteError(/CHECK/));
      assert.throws(() => deviceInterval(db, { start: '2026-09-21T03:31:00Z', end: '2026-09-21T03:32:00Z', avg: 80, max: 72 }),
        sqliteError(/CHECK/));
      assert.throws(() => roomInterval(db, { start: '2026-09-21T03:31:00Z', end: '2026-09-21T03:31:00Z' }), sqliteError(/CHECK/));
      assert.throws(() => roomInterval(db, { start: '2026-13-21T03:31:00Z' }), sqliteError(/CHECK/));
      assert.equal(count(db, 'room_intervals'), 1);
      assert.equal(count(db, 'device_intervals'), 1);
      const ref = db.prepare('SELECT policy_ref FROM device_intervals').get() as { policy_ref: string };
      assert.equal(ref.policy_ref, 'pol-meeting-light:1');
    } finally {
      closeDatabase(db);
    }
  });
});

describe('run history stability', () => {
  it('pins the inventory and policy versions a run was created with', () => {
    const db = memoryDb();
    try {
      createRun(db, { ...RUN, run_id: 'run-1', config: { step_seconds: 10 } });
      assert.deepEqual([count(db, 'run_rooms'), count(db, 'run_devices'), count(db, 'run_policies')], [5, 18, 20]);

      // Later edits to CURRENT inventory and schedules.
      db.prepare("UPDATE devices SET nominal_power_w = 999, name = 'Renamed' WHERE device_id = 'dev-meeting-light'").run();
      db.prepare("UPDATE rooms SET capacity = 1 WHERE room_id = 'room-meeting'").run();
      addPolicyVersion(db, { policy_id: 'pol-meeting-light', effective_from_utc: '2026-10-01T00:00:00Z',
        rules: { on_during_hours: false, vacancy_grace_seconds: 60 } });

      const snap = db.prepare("SELECT name, nominal_power_w FROM run_devices WHERE run_id = 'run-1' AND device_id = 'dev-meeting-light'")
        .get() as { name: string; nominal_power_w: number };
      assert.deepEqual({ ...snap }, { name: 'Lighting group', nominal_power_w: 72 });
      const room = db.prepare("SELECT capacity FROM run_rooms WHERE run_id = 'run-1' AND room_id = 'room-meeting'").get() as { capacity: number };
      assert.equal(room.capacity, 6);
      const pinned = db.prepare(`SELECT pv.version, pv.rules FROM run_policies rp JOIN policy_versions pv
          ON pv.policy_id = rp.policy_id AND pv.version = rp.version
          WHERE rp.run_id = 'run-1' AND rp.policy_id = 'pol-meeting-light'`).all() as { version: number; rules: string }[];
      assert.deepEqual(pinned.map((p) => [p.version, JSON.parse(p.rules)]), [[1, { on_during_hours: true, vacancy_grace_seconds: 300 }]]);

      // A new run picks up the current state; run-1 is unaffected.
      createRun(db, { ...RUN, run_id: 'run-2', config: {} });
      const v = db.prepare("SELECT version FROM run_policies WHERE run_id = 'run-2' AND policy_id = 'pol-meeting-light'").get() as { version: number };
      assert.equal(v.version, 2);

      // Snapshots, runs and configuration are immutable.
      for (const stmt of [
        "UPDATE run_devices SET nominal_power_w = 1 WHERE run_id = 'run-1'",
        "DELETE FROM run_rooms WHERE run_id = 'run-1'",
        "UPDATE run_policies SET version = 2 WHERE run_id = 'run-1'",
        "UPDATE simulation_runs SET config = '{}' WHERE run_id = 'run-1'",
        "DELETE FROM simulation_runs WHERE run_id = 'run-1'",
        "UPDATE policies SET device_id = 'dev-open-ac' WHERE policy_id = 'pol-meeting-light'",
      ]) {
        assert.throws(() => db.prepare(stmt).run(), sqliteError(/immutable/), stmt);
      }
      assert.throws(() => createRun(db, { ...RUN, run_id: 'run-1', config: {} }), sqliteError(/UNIQUE/));
      assert.equal(count(db, 'simulation_runs'), 2);
    } finally {
      closeDatabase(db);
    }
  });
});

describe('persistence', () => {
  it('keeps committed writes after close and reopen, and leaves no WAL sidecar after a clean close', () => {
    withFileDb((path) => {
      let db = openDatabase(path);
      try {
        runMigrations(db);
        seedDemoInventory(db);
        createRun(db, { ...RUN, run_id: 'run-persist', config: { note: 'persist' } });
        roomInterval(db, { run_id: 'run-persist' });
        db.prepare("UPDATE devices SET standby_power_w = 2 WHERE device_id = 'dev-open-fan'").run();
      } finally {
        closeDatabase(db);
      }
      assert.equal(existsSync(`${path}-wal`), false);

      db = openDatabase(path);
      try {
        assert.deepEqual(runMigrations(db).applied, []);
        assert.equal(count(db, 'room_intervals'), 1);
        const run = db.prepare("SELECT config FROM simulation_runs WHERE run_id = 'run-persist'").get() as { config: string };
        assert.deepEqual(JSON.parse(run.config), { note: 'persist' });
        assert.equal(getInventory(db).devices.find((d) => d.device_id === 'dev-open-fan')?.standby_power_w, 2);
      } finally {
        closeDatabase(db);
      }
    });
  });
});
