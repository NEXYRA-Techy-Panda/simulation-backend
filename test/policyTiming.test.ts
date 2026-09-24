/**
 * K002 — run-policy timing.
 *
 * Covers the required regressions for run-scoped policy activation:
 *  - a new run after a previous run's calendar change;
 *  - office-hours and dependent device_schedule revisions together;
 *  - repeated resets;
 *  - mid-run activation at the intended boundary;
 *  - reset BEFORE a pending change activates (documented intended behaviour);
 *  - graceful restart with an active and a pending change;
 *  - prior-run snapshots and readings unchanged;
 *  - a contract-shaped dataset whose references and effective times are valid;
 *  - the pre-K002 inconsistency, left unrepaired and identified as legacy.
 *
 * All databases here are in memory or in a test-owned temp directory; the
 * user's data/ database is never touched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertDataset } from '../src/contract/validators.js';
import { closeDatabase, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { migrations } from '../src/db/migrations/index.js';
import { seedDemoInventory } from '../src/db/seed/seed.js';
import { INITIAL_SIM_TIME_UTC } from '../src/engine/constants.js';
import { SimulationEngine } from '../src/engine/engine.js';
import { deviceOf, fakeClock, fakeEngine, stateOf } from './engineHelpers.js';
import { count, makeTempDir, memoryDb } from './helpers.js';
import { activationMode, buildRunDataset, datasetProblems, deviceRows, intervalCount, pinnedPolicies } from './runDataset.js';

const CAL = { working_days: [1, 2, 3, 4, 5], open_local: '08:30', close_local: '17:30' };
const epoch = (utc: string): number => Date.parse(utc) / 1000;
const runs = (db: ReturnType<typeof memoryDb>): string[] =>
  (db.prepare('SELECT run_id FROM simulation_runs ORDER BY created_utc, run_id').all() as { run_id: string }[]).map((r) => r.run_id);

/** Snapshot of a run's stored history, for "history unchanged" comparisons. */
const snapshot = (db: ReturnType<typeof memoryDb>, runId: string) => ({
  pins: pinnedPolicies(db, runId),
  deviceRows: intervalCount(db, 'device_intervals', runId),
  roomRows: intervalCount(db, 'room_intervals', runId),
  energy: (db.prepare('SELECT COALESCE(SUM(energy_kwh), 0) AS e FROM device_intervals WHERE run_id = ?').get(runId) as { e: number }).e,
  cumulative: db.prepare(`SELECT je.key AS device_id, json_extract(je.value, '$.cumulative_kwh') AS cumulative_kwh
    FROM engine_checkpoints c, json_each(c.state, '$.devices') je WHERE c.run_id = ? ORDER BY je.key`).all(runId),
});

describe('K002 run-scoped policy activation', () => {
  it('a run created after a calendar change adopts the current configuration from its start, without rewriting the global revision record', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start(1, 2026);
      const runA = stateOf(engine).run_id!;
      engine.advanceSteps(599); // 20:09:50Z, one step before a minute boundary
      const ack = engine.setCalendar(CAL);
      assert.equal(ack.applied, false);
      const boundary = String(ack.effective_sim_utc);
      engine.advanceSteps(1); // cross the boundary at 20:10:00Z: the change activates in run A
      assert.equal(epoch(boundary), epoch('2025-12-31T20:10:00Z'));
      engine.advanceSteps(60); // run A keeps producing readings until 20:20Z

      const aPins = pinnedPolicies(db, runA);
      const aOh = aPins.filter((p) => p.policy_id === 'pol-office-hours');
      assert.deepEqual(aOh.map((p) => [p.version, p.active_from_utc, p.effective_from_utc]), [
        [1, INITIAL_SIM_TIME_UTC, '2000-01-01T00:00:00Z'],
        [2, boundary, boundary],
      ]);
      const beforeA = snapshot(db, runA);

      // Reset -> run B starts at the fixed initial instant, 100 minutes BEFORE
      // the boundary at which run A's calendar change took effect.
      engine.reset();
      const runB = stateOf(engine).run_id!;
      assert.equal(stateOf(engine).sim_time_utc, INITIAL_SIM_TIME_UTC);
      assert.notEqual(runB, runA);

      const bPins = pinnedPolicies(db, runB);
      assert.equal(activationMode(db, runB), 'run_scoped');
      const bOh = bPins.filter((p) => p.policy_id === 'pol-office-hours');
      // One revision, active from run B's start, while its GLOBAL record time is
      // still run A's boundary — the revision identity is untouched.
      assert.deepEqual(bOh.map((p) => [p.version, p.active_from_utc, p.effective_from_utc]),
        [[2, INITIAL_SIM_TIME_UTC, boundary]]);
      // Office-hours and every dependent device_schedule revision move together.
      const bSchedules = bPins.filter((p) => p.kind === 'device_schedule');
      assert.equal(bSchedules.length, 11);
      assert.ok(bSchedules.every((p) => p.active_from_utc === INITIAL_SIM_TIME_UTC));
      assert.ok(bSchedules.every((p) => p.rules.office_hours_ref === 'pol-office-hours:2'));

      engine.advanceSteps(180); // 30 simulated minutes of readings in run B

      // Contract-shaped dataset from run B's own snapshots + readings.
      const built = buildRunDataset(db, runB);
      assertDataset(built.dataset); // formal schema validation
      assert.deepEqual(datasetProblems(built), []);
      assert.equal(built.mode, 'run_scoped');
      // Every interval of the open-workspace AC uses the run-scoped activation,
      // not the later global revision time.
      const acRows = deviceRows(built, 'dev-open-ac');
      assert.equal(acRows.length, 30);
      assert.ok(acRows.every((r) => r.policy_ref === 'pol-open-ac:2'));
      assert.equal(built.datasetEffectiveTimes.get('pol-open-ac:2'), INITIAL_SIM_TIME_UTC);
      assert.ok(epoch(built.datasetEffectiveTimes.get('pol-open-ac:2')!) <= epoch(String(acRows[0]!.interval_start_utc)));
      const bRoom = built.dataset.run as { run_start_utc: string };
      assert.equal(bRoom.run_start_utc, INITIAL_SIM_TIME_UTC);
      const bExport = built.dataset.export as { export_start_utc: string };
      assert.equal(bExport.export_start_utc, INITIAL_SIM_TIME_UTC);

      // Run A's history is byte-for-byte what it was before the reset.
      assert.deepEqual(snapshot(db, runA), beforeA);
      assert.equal(activationMode(db, runA), 'run_scoped');

      // Existing behaviour is unaffected: energy reconciles, the always-on
      // exception holds, and a manual override still clears back to policy.
      const s = stateOf(engine);
      const deviceSum = s.devices.reduce((a, d) => a + d.energy_kwh, 0);
      assert.ok(Math.abs(s.office!.energy_kwh - deviceSum) < 1e-12);
      assert.ok(Math.abs(s.rooms.reduce((a, r) => a + r.energy_kwh, 0) - deviceSum) < 1e-12);
      assert.equal(deviceOf(engine, 'dev-pantry-fridge').on, true);
      engine.commandDevice('dev-meeting-light', { kind: 'set', on: true });
      assert.equal(deviceOf(engine, 'dev-meeting-light').on, true);
      engine.commandDevice('dev-meeting-light', { kind: 'clear' });
      assert.equal(deviceOf(engine, 'dev-meeting-light').override, null);
      // The device's reference is a revision pinned in this run.
      assert.ok(bPins.some((p) => p.policy_id === 'pol-meeting-light' && p.active_from_utc === INITIAL_SIM_TIME_UTC));
    } finally {
      closeDatabase(db);
    }
  });

  it('activates a mid-run change exactly at its boundary, and a reset before that boundary makes the minted revision the new baseline', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start(1, 2026);
      const runA = stateOf(engine).run_id!;
      engine.advanceSteps(29); // 18:34:50Z, one step before a minute boundary
      const first = engine.setCalendar(CAL);
      const firstBoundary = String(first.effective_sim_utc);
      assert.equal(first.applied, false);
      assert.equal(firstBoundary, '2025-12-31T18:35:00Z');

      // Before the boundary: the change is pending, pins are unchanged and
      // readings still reference the previous revision.
      let st = stateOf(engine) as unknown as { sim_time_utc: string; pending_changes: unknown[] };
      assert.equal(st.sim_time_utc, '2025-12-31T18:34:50Z');
      assert.equal(st.pending_changes.length, 1);
      assert.ok(!pinnedPolicies(db, runA).some((p) => p.policy_id === 'pol-office-hours' && p.version === 2));

      engine.advanceSteps(1); // exactly 18:35:00Z -> activates
      st = stateOf(engine) as unknown as { sim_time_utc: string; pending_changes: unknown[] };
      assert.equal(st.sim_time_utc, firstBoundary);
      assert.equal(st.pending_changes.length, 0);
      const activated = pinnedPolicies(db, runA).filter((p) => p.policy_id === 'pol-office-hours');
      assert.deepEqual(activated.map((p) => [p.version, p.active_from_utc]), [
        [1, INITIAL_SIM_TIME_UTC], [2, firstBoundary],
      ]);
      // The minute that ENDS at the boundary was published just before the due
      // change applied, so it still used the old revision; the minute that
      // STARTS at the boundary uses the new one.
      engine.advanceSteps(60);
      const rows = deviceRows(buildRunDataset(db, runA), 'dev-open-ac');
      const beforeBoundary = rows.find((r) => r.interval_start_utc === '2025-12-31T18:34:00Z')!;
      assert.equal(beforeBoundary.policy_ref, 'pol-open-ac:1');
      const atBoundary = rows.find((r) => r.interval_start_utc === firstBoundary)!;
      assert.equal(atBoundary.policy_ref, 'pol-open-ac:2');
      assert.deepEqual(datasetProblems(buildRunDataset(db, runA)), []);

      // A second change, minted but NOT yet activated, then a reset.
      engine.advanceSteps(29); // 18:49:50Z, one step before a minute boundary
      const second = engine.setCalendar({ ...CAL, open_local: '07:00' });
      assert.equal(second.applied, false);
      const versionsBefore = count(db, 'policy_versions');
      engine.reset();
      const runB = stateOf(engine).run_id!;
      // Documented intended behaviour: the reset discards the pending schedule
      // for the OLD run, and the already-minted revision becomes run B's
      // baseline, active from run B's start (no new global version is created).
      assert.equal(count(db, 'policy_versions'), versionsBefore);
      const bPins = pinnedPolicies(db, runB);
      const bOh = bPins.filter((p) => p.policy_id === 'pol-office-hours');
      assert.equal(bOh.length, 1);
      assert.equal(bOh[0]!.version, 3);
      assert.equal(bOh[0]!.active_from_utc, INITIAL_SIM_TIME_UTC);
      assert.equal(bOh[0]!.effective_from_utc, String(second.effective_sim_utc));
      engine.advanceSteps(120);
      assert.deepEqual(datasetProblems(buildRunDataset(db, runB)), []);
      // Run A keeps its own pending change and activation history.
      assert.ok(pinnedPolicies(db, runA).some((p) => p.policy_id === 'pol-office-hours' && p.version === 2));
    } finally {
      closeDatabase(db);
    }
  });

  it('repeated resets re-baseline each run at its own start and keep every earlier run intact', () => {
    const db = memoryDb();
    try {
      const { engine } = fakeEngine(db);
      engine.start(1, 2026);
      const runA = stateOf(engine).run_id!;
      engine.advanceSteps(120);
      engine.setCalendar(CAL);
      engine.advanceSteps(60);
      const beforeB = snapshot(db, runA);

      engine.reset();
      const runB = stateOf(engine).run_id!;
      engine.advanceSteps(120);
      const beforeC = snapshot(db, runB);

      engine.reset();
      const runC = stateOf(engine).run_id!;
      engine.advanceSteps(120);

      assert.deepEqual(new Set(runs(db)), new Set([runA, runB, runC]));
      assert.equal(runs(db).length, 3);
      // Each reset re-baselines without minting global revisions.
      for (const run of [runB, runC]) {
        const pins = pinnedPolicies(db, run);
        assert.equal(activationMode(db, run), 'run_scoped');
        assert.ok(pins.length > 0);
        assert.ok(pins.every((p) => p.active_from_utc === INITIAL_SIM_TIME_UTC), `${run} has a pin not active from its start`);
        assert.deepEqual(datasetProblems(buildRunDataset(db, run)), []);
        assert.equal((db.prepare('SELECT run_start_utc FROM simulation_runs WHERE run_id = ?').get(run) as { run_start_utc: string }).run_start_utc, INITIAL_SIM_TIME_UTC);
      }
      // The revision minted in run A keeps its global identity across B and C.
      const globalOfficeHours2 = (db.prepare(`SELECT effective_from_utc FROM policy_versions
          WHERE policy_id = 'pol-office-hours' AND version = 2`).get() as { effective_from_utc: string }).effective_from_utc;
      for (const run of [runB, runC]) {
        const pin = pinnedPolicies(db, run).find((p) => p.policy_id === 'pol-office-hours' && p.version === 2)!;
        assert.equal(pin.effective_from_utc, globalOfficeHours2);
        assert.equal(pin.active_from_utc, INITIAL_SIM_TIME_UTC);
      }
      // Earlier runs are untouched by later resets.
      assert.deepEqual(snapshot(db, runA), beforeB);
      assert.deepEqual(snapshot(db, runB), beforeC);
      // Run A's two revisions keep their own activations.
      assert.deepEqual(pinnedPolicies(db, runA).filter((p) => p.policy_id === 'pol-office-hours').map((p) => [p.version, p.active_from_utc]),
        [[1, INITIAL_SIM_TIME_UTC], [2, '2025-12-31T18:50:00Z']]);
    } finally {
      closeDatabase(db);
    }
  });

  it('a graceful restart restores the same applied and pending policies and still activates at the boundary', () => {
    const { dir, cleanup } = makeTempDir();
    const path = `${dir}/restart.sqlite`;
    let db1: ReturnType<typeof openDatabase> | undefined;
    let db2: ReturnType<typeof openDatabase> | undefined;
    try {
      db1 = openDatabase(path);
      runMigrations(db1);
      seedDemoInventory(db1);
      const engine1 = fakeEngine(db1).engine;
      engine1.start(1, 7);
      const runId = stateOf(engine1).run_id!;
      engine1.advanceSteps(60); // 18:40:00Z
      engine1.setCalendar(CAL); // applies at the boundary it landed on
      engine1.advanceSteps(60); // 18:50:00Z
      engine1.advanceSteps(29); // 18:54:50Z, one step before a minute boundary
      const pendingAck = engine1.setCalendar({ ...CAL, open_local: '07:15' }); // still pending
      assert.equal(pendingAck.applied, false);
      const applied = pinnedPolicies(db1, runId).filter((p) => p.policy_id === 'pol-office-hours').map((p) => [p.version, p.active_from_utc]);
      const pendingBefore = (stateOf(engine1) as unknown as { pending_changes: unknown[] }).pending_changes;
      assert.equal(pendingBefore.length, 1);
      engine1.shutdown();

      db2 = openDatabase(path);
      runMigrations(db2);
      const engine2 = new SimulationEngine(db2, { schedulerDeps: fakeClock().deps });
      const recovered = engine2.recover();
      assert.equal(recovered?.run_id, runId);
      assert.equal(engine2.lifecycle, 'paused');
      // Applied and pending policies survive the restart unchanged.
      assert.deepEqual(pinnedPolicies(db2, runId).filter((p) => p.policy_id === 'pol-office-hours').map((p) => [p.version, p.active_from_utc]), applied);
      assert.deepEqual((engine2.getState() as unknown as { pending_changes: unknown[] }).pending_changes, pendingBefore);
      assert.equal(activationMode(db2, runId), 'run_scoped');

      // The pending change still activates at its recorded boundary with its
      // own run-scoped activation.
      const pendingPin = (pendingAck.policy_refs as string[]).find((r) => r.startsWith('pol-office-hours:'))!;
      const pendingBoundary = String(pendingAck.effective_sim_utc);
      while (stateOf(engine2).sim_time_utc !== pendingBoundary) engine2.advanceSteps(1);
      const after = pinnedPolicies(db2, runId).find((p) => `${p.policy_id}:${p.version}` === pendingPin)!;
      assert.equal(after.active_from_utc, pendingBoundary);
      engine2.advanceSteps(60);
      assert.deepEqual(datasetProblems(buildRunDataset(db2, runId)), []);
      engine2.shutdown();
    } finally {
      if (db2) closeDatabase(db2);
      if (db1) closeDatabase(db1);
      cleanup();
    }
  });
});

describe('K002 pre-existing runs', () => {
  /** The pre-K002 pinning rule: newest global revision, no activation recorded. */
  function legacyRun(db: ReturnType<typeof memoryDb>, runId: string, buildingId: string): void {
    db.prepare(`INSERT INTO simulation_runs (run_id, building_id, building_name, timezone, scenario_id,
        comparison_id, run_start_utc, config, created_utc) VALUES (?, ?, 'NEXYRA demo office', 'Asia/Kolkata',
        'original', NULL, '2025-12-31T18:30:00Z', '{}', 't')`).run(runId, buildingId);
    db.prepare(`INSERT INTO run_rooms (run_id, room_id, name, room_type, capacity, floor_area_m2)
        SELECT ?, room_id, name, room_type, capacity, floor_area_m2 FROM rooms WHERE building_id = ?`).run(runId, buildingId);
    db.prepare(`INSERT INTO run_devices (run_id, device_id, room_id, name, device_type, quantity, nominal_power_w,
        standby_power_w, power_factor, always_on, control, controls)
        SELECT ?, d.device_id, d.room_id, d.name, d.device_type, d.quantity, d.nominal_power_w, d.standby_power_w,
        d.power_factor, d.always_on, d.control, d.controls FROM devices d JOIN rooms r ON r.room_id = d.room_id
        WHERE r.building_id = ?`).run(runId, buildingId);
    db.prepare(`INSERT INTO run_policies (run_id, policy_id, version)
        SELECT ?, c.policy_id, c.version FROM current_policy_versions c
        LEFT JOIN rooms r ON r.room_id = c.room_id
        LEFT JOIN devices d ON d.device_id = c.device_id
        LEFT JOIN rooms dr ON dr.room_id = d.room_id
        WHERE ? IN (c.building_id, r.building_id, dr.building_id)`).run(runId, buildingId);
  }

  function legacyInterval(db: ReturnType<typeof memoryDb>, runId: string, deviceId: string, policyRef: string): void {
    const [policyId, version] = policyRef.split(':') as [string, string];
    const roomId = (db.prepare('SELECT room_id FROM run_devices WHERE run_id = ? AND device_id = ?').get(runId, deviceId) as { room_id: string }).room_id;
    db.prepare(`INSERT INTO device_intervals (run_id, device_id, room_id, interval_start_utc, interval_end_utc,
        interval_seconds, avg_power_w, max_power_w, energy_kwh, cumulative_kwh, avg_voltage_v, avg_current_a,
        power_factor, on_fraction, override_seconds, vacant_on_seconds, offschedule_on_seconds, policy_id,
        policy_version, partial) VALUES (?, ?, ?, '2025-12-31T18:30:00Z', '2025-12-31T18:31:00Z', 60,
        72, 72, 0.0012, 0.0012, NULL, NULL, 0.9, 1, 0, 60, 60, ?, ?, 0)`)
      .run(runId, deviceId, roomId, policyId, Number(version));
  }

  it('identifies migrated pre-K002 runs without repairing them, and keeps inconsistent ones unsupported', () => {
    const { dir, cleanup } = makeTempDir();
    const path = `${dir}/legacy.sqlite`;
    const db = openDatabase(path);
    try {
      // A database created before K002. Migrate and seed at the CURRENT version
      // (the seeder refuses an older schema), then undo migration 3 — whose only
      // delta is the activation column and its trigger — and its history row, so
      // the file is shaped exactly like a pre-K002 database (versions 1 and 2
      // applied, no activation column). runMigrations() below then applies
      // migration 3 to it for real.
      runMigrations(db, migrations);
      seedDemoInventory(db);
      // K005-PREP: also undo branch-local migration 4 (history jobs) so the file is a v2 database.
      db.exec(`DROP TRIGGER engine_checkpoints_not_history_run;
        DROP TABLE history_jobs;
        DELETE FROM schema_migrations WHERE version = 4;`);
      db.exec(`DROP TRIGGER run_policies_activation_required;
        ALTER TABLE run_policies DROP COLUMN active_from_utc;
        DELETE FROM schema_migrations WHERE version = 3;`);
      assert.equal((db.prepare('SELECT coalesce(max(version), 0) AS v FROM schema_migrations').get() as { v: number }).v, 2);
      const buildingId = (db.prepare('SELECT building_id FROM buildings LIMIT 1').get() as { building_id: string }).building_id;

      // The GOOD legacy run was created BEFORE the calendar change, so its pins
      // (version 1, effective 2000-01-01) are already effective for its reading.
      legacyRun(db, 'run-legacy-ok', buildingId);
      legacyInterval(db, 'run-legacy-ok', 'dev-meeting-light', 'pol-meeting-light:1');

      // Then a calendar change minted office-hours version 2 and a new version
      // of EVERY device_schedule that references it (exactly what setCalendar
      // does), all stamped effective at 20:10 on the earlier run's timeline.
      db.prepare(`INSERT INTO policy_versions (policy_id, version, effective_from_utc, rules, created_utc)
          VALUES ('pol-office-hours', 2, '2025-12-31T20:10:00Z', ?, 't')`)
        .run(JSON.stringify({ working_days_iso: [1, 2, 3, 4, 5], open_local: '08:30', close_local: '17:30', overnight: false }));
      const schedules = db.prepare(`SELECT policy_id, rules FROM current_policy_versions WHERE kind = 'device_schedule'`)
        .all() as { policy_id: string; rules: string }[];
      assert.ok(schedules.length > 0, 'the demo inventory should have device_schedule policies');
      for (const s of schedules) {
        const rules = JSON.parse(s.rules) as Record<string, unknown>;
        if (rules.office_hours_ref !== 'pol-office-hours:1') continue;
        db.prepare(`INSERT INTO policy_versions (policy_id, version, effective_from_utc, rules, created_utc)
            VALUES (?, 2, '2025-12-31T20:10:00Z', ?, 't')`)
          .run(s.policy_id, JSON.stringify({ ...rules, office_hours_ref: 'pol-office-hours:2' }));
      }
      assert.ok(schedules.some((s) => s.policy_id === 'pol-open-ac'));

      // The BAD legacy run was created AFTER that change: it pins the newest
      // revisions but still starts at 18:30, so its reading applies a revision
      // 110 minutes before that revision's global effective time (the K002
      // defect).
      legacyRun(db, 'run-legacy-bad', buildingId);
      legacyInterval(db, 'run-legacy-bad', 'dev-open-ac', 'pol-open-ac:2');

      const versionsBefore = count(db, 'policy_versions');
      const badRowsBefore = intervalCount(db, 'device_intervals', 'run-legacy-bad');
      // Counted directly: pinnedPolicies() reads the activation column, which
      // does not exist until migration 3 is applied below.
      const badPinsBefore = (db.prepare('SELECT COUNT(*) AS n FROM run_policies WHERE run_id = ?').get('run-legacy-bad') as { n: number }).n;

      // Upgrade to the current schema.
      const result = runMigrations(db);
      assert.deepEqual(result, { applied: [3, 4], currentVersion: 4 }); // 4: K005-PREP branch-local history jobs

      // Both runs are identified as pre-K002 (no activation recorded) ...
      assert.equal(activationMode(db, 'run-legacy-bad'), 'legacy_unrecorded');
      assert.equal(activationMode(db, 'run-legacy-ok'), 'legacy_unrecorded');
      assert.ok(pinnedPolicies(db, 'run-legacy-ok').every((p) => p.active_from_utc === null));

      // ... and validated against the global revision times: the bad run is
      // still inconsistent (unsupported for historical export) and says so.
      const bad = buildRunDataset(db, 'run-legacy-bad');
      const badProblems = datasetProblems(bad);
      assert.ok(badProblems.some((p) => p.includes('before its effective time')), badProblems.join('; '));
      // The good legacy run remains valid under the same rule.
      assert.deepEqual(datasetProblems(buildRunDataset(db, 'run-legacy-ok')), []);

      // Nothing was silently repaired: no versions, rows or pins changed and
      // no activation was backfilled.
      assert.equal(count(db, 'policy_versions'), versionsBefore);
      assert.equal(intervalCount(db, 'device_intervals', 'run-legacy-bad'), badRowsBefore);
      assert.equal(pinnedPolicies(db, 'run-legacy-bad').length, badPinsBefore);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM run_policies WHERE active_from_utc IS NULL').get() as { n: number }).n, badPinsBefore * 2);

      // New pins must record a run-scoped activation.
      assert.throws(() => db.prepare(`INSERT INTO run_policies (run_id, policy_id, version) VALUES ('run-legacy-bad', 'pol-meeting-light', 1)`).run(),
        /run-scoped activation/);
    } finally {
      closeDatabase(db);
      cleanup();
    }
  });
});
