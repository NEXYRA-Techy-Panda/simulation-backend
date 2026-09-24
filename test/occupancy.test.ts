import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { assertRoomInterval } from '../src/contract/validators.js';
import { closeDatabase, type Database, openDatabase } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDemoInventory } from '../src/db/seed/seed.js';
import type { SimulationEngine } from '../src/engine/engine.js';
import { deviceIntervals, deviceOf, fakeEngine, stateOf } from './engineHelpers.js';
import { makeTempDir, memoryDb } from './helpers.js';

interface Occ {
  mode: string; office_count: number; manual_total: number; scheduled_target: number; seed: number;
  occupants: { occupant_id: string; room_id: string | null; home_room_id: string | null }[];
  redistribution: { rule_id: string; room_id: string | null; occupant_ids: string[] } | null;
}
interface FullState {
  sim_time_utc: string;
  rooms: { room_id: string; occupancy: number; capacity: number; energy_kwh: number }[];
  office: { occupancy: number; energy_kwh: number };
  occupancy: Occ;
  calendar: { policy_ref: string; open_local: string; close_local: string; open_now: boolean };
  pending_changes: { effective_sim_utc: string; policy_refs: string[] }[];
  overrides: { device_id: string; on: boolean }[];
}

const full = (e: SimulationEngine): FullState => e.getState() as unknown as FullState;
/** Epoch seconds of an Asia/Kolkata local time, e.g. ist('2026-01-01', '09:00'). */
const ist = (date: string, time: string): number => Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}+05:30`) / 1000;
const simEpoch = (e: SimulationEngine): number => Date.parse(full(e).sim_time_utc) / 1000;
function goTo(e: SimulationEngine, epoch: number): void {
  const steps = (epoch - simEpoch(e)) / 10;
  assert.ok(Number.isInteger(steps) && steps >= 0, `cannot step to ${new Date(epoch * 1000).toISOString()}`);
  e.advanceSteps(steps);
}
const THU = '2026-01-01';
const meetingLightId = 'dev-meeting-light';
const assignments = (e: SimulationEngine): Record<string, string | null> =>
  Object.fromEntries(full(e).occupancy.occupants.map((o) => [o.occupant_id, o.room_id]));
const on = (e: SimulationEngine, id: string): boolean => deviceOf(e, id).on;

/** Office total = Σ rooms = occupants placed; each occupant in ≤ 1 room; capacities respected. */
function checkInvariants(e: SimulationEngine): void {
  const s = full(e);
  const byRoom = new Map<string, number>();
  for (const o of s.occupancy.occupants) if (o.room_id) byRoom.set(o.room_id, (byRoom.get(o.room_id) ?? 0) + 1);
  assert.equal(new Set(s.occupancy.occupants.map((o) => o.occupant_id)).size, 20);
  assert.equal(s.office.occupancy, s.occupancy.office_count);
  assert.equal(s.rooms.reduce((a, r) => a + r.occupancy, 0), s.occupancy.office_count);
  for (const r of s.rooms) {
    assert.equal(r.occupancy, byRoom.get(r.room_id) ?? 0, r.room_id);
    assert.ok(r.occupancy <= r.capacity, `${r.room_id} over capacity`);
  }
}

function started(seed = 42, db: Database = memoryDb()): { db: Database; engine: SimulationEngine } {
  const { engine } = fakeEngine(db);
  engine.start(undefined, seed);
  return { db, engine };
}

describe('manual occupancy', () => {
  it('allocates totals 0, 1 and 20 automatically within capacity', () => {
    const { db, engine } = started();
    try {
      for (const total of [0, 1, 20, 0]) {
        const ack = engine.setOccupancy({ mode: 'manual', total });
        assert.equal(ack.office_count, total);
        assert.equal((ack.allocation as { count: number }[]).reduce((a, r) => a + r.count, 0), total);
        checkInvariants(engine);
      }
      engine.setOccupancy({ mode: 'manual', total: 20 });
      const rooms = Object.fromEntries(full(engine).rooms.map((r) => [r.room_id, r.occupancy]));
      // Priority fill: workspace 12, reception 2, manager 2, meeting 4 (of 6), pantry 0.
      assert.deepEqual(rooms, { 'room-open-workspace': 12, 'room-reception': 2, 'room-manager-cabin': 2, 'room-meeting': 4, 'room-pantry': 0 });
      assert.equal(full(engine).occupancy.mode, 'manual');
      goTo(engine, ist(THU, '03:00')); // manual occupancy persists outside office hours
      assert.equal(full(engine).office.occupancy, 20);
    } finally {
      closeDatabase(db);
    }
  });

  it('rejects impossible counts clearly and changes nothing', () => {
    const db = memoryDb();
    db.prepare('UPDATE rooms SET capacity = 2').run(); // total capacity 10 for this run's snapshot
    const { engine } = started(1, db);
    try {
      engine.setOccupancy({ mode: 'manual', total: 10 });
      assert.throws(() => engine.setOccupancy({ mode: 'manual', total: 11 }), { status: 409, code: 'CONFLICT' });
      assert.throws(() => engine.setOccupancy({ mode: 'scheduled', target: 11 }), { status: 409 });
      assert.throws(() => engine.setOccupancy({ mode: 'manual', total: 21 }), { status: 400, code: 'VALIDATION_ERROR' });
      assert.throws(() => engine.setOccupancy({ mode: 'manual', total: -1 }), { status: 400 });
      assert.throws(() => engine.setOccupancy({ mode: 'manual', total: 2.5 }), { status: 400 });
      assert.throws(() => engine.setOccupancy({ mode: 'manual' }), { status: 400 });
      assert.throws(() => engine.setOccupancy({ mode: 'scheduled', total: 5 }), { status: 400 });
      assert.throws(() => engine.setOccupancy({ mode: 'manual', total: 3, target: 3 }), { status: 400 });
      assert.throws(() => engine.setOccupancy({ mode: 'auto', total: 3 }), { status: 400 });
      assert.equal(full(engine).office.occupancy, 10);
      assert.equal(full(engine).occupancy.mode, 'manual');
      checkInvariants(engine);
    } finally {
      closeDatabase(db);
    }
  });

  it('keeps occupant identities and rooms stable as counts change', () => {
    const { db, engine } = started();
    try {
      engine.setOccupancy({ mode: 'manual', total: 10 });
      const ten = assignments(engine);
      engine.setOccupancy({ mode: 'manual', total: 14 });
      const fourteen = assignments(engine);
      for (const [id, room] of Object.entries(ten)) if (room) assert.equal(fourteen[id], room, id);
      engine.setOccupancy({ mode: 'manual', total: 6 });
      const six = assignments(engine);
      const present6 = Object.entries(six).filter(([, r]) => r);
      assert.equal(present6.length, 6);
      for (const [id, room] of present6) assert.equal(fourteen[id], room, id);
      assert.deepEqual(Object.keys(six), Array.from({ length: 20 }, (_, i) => `occ-${String(i + 1).padStart(2, '0')}`));
    } finally {
      closeDatabase(db);
    }
  });

  it('records a partial-occupancy minute exactly', () => {
    const { db, engine } = started();
    try {
      goTo(engine, ist(THU, '10:00'));
      engine.advanceSteps(3); // 10:00:30
      engine.setOccupancy({ mode: 'manual', total: 1 });
      const room = full(engine).occupancy.occupants.find((o) => o.room_id)!.room_id!;
      engine.advanceSteps(3); // completes 10:00–10:01
      const row = db.prepare(`SELECT * FROM room_intervals WHERE room_id = ? AND interval_start_utc = ?`)
        .get(room, new Date(ist(THU, '10:00') * 1000).toISOString().replace('.000Z', 'Z')) as Record<string, unknown>;
      assert.deepEqual([row.occupancy_avg, row.occupancy_max, row.occupied_fraction, row.interval_seconds], [0.5, 1, 0.5, 60]);
      assertRoomInterval({ ...row, partial: row.partial === 1 });
    } finally {
      closeDatabase(db);
    }
  });
});

describe('scheduled occupancy', () => {
  it('follows opening and closing boundaries and leaves non-working days empty', () => {
    const { db, engine } = started();
    try {
      engine.setOccupancy({ mode: 'scheduled', target: 14 });
      assert.equal(full(engine).office.occupancy, 0); // 00:00 closed
      goTo(engine, ist(THU, '08:59:50'));
      assert.equal(full(engine).office.occupancy, 0);
      engine.advanceSteps(1);
      assert.equal(full(engine).office.occupancy, 14); // 09:00:00 inclusive
      assert.equal(full(engine).calendar.open_now, true);
      goTo(engine, ist(THU, '17:59:50'));
      assert.equal(full(engine).office.occupancy, 14);
      engine.advanceSteps(1);
      assert.equal(full(engine).office.occupancy, 0); // 18:00 exclusive
      goTo(engine, ist('2026-01-02', '10:00')); // Friday
      assert.equal(full(engine).office.occupancy, 14);
      goTo(engine, ist('2026-01-03', '10:00')); // Saturday
      assert.equal(full(engine).office.occupancy, 0);
      goTo(engine, ist('2026-01-04', '12:00')); // Sunday
      assert.equal(full(engine).office.occupancy, 0);
      checkInvariants(engine);
    } finally {
      closeDatabase(db);
    }
  });

  it('attributes an overnight window to its opening day', () => {
    const { db, engine } = started();
    try {
      const ack = engine.setCalendar({ working_days: [4], open_local: '22:00', close_local: '06:00' }); // Thursday night
      assert.deepEqual([ack.applied, ack.effective_sim_utc], [true, '2025-12-31T18:30:00Z']); // exactly on a minute boundary
      assert.equal((ack.calendar as { overnight: boolean }).overnight, true);
      engine.setOccupancy({ mode: 'scheduled', target: 5 });
      goTo(engine, ist(THU, '21:59:50'));
      assert.equal(full(engine).office.occupancy, 0);
      engine.advanceSteps(1);
      assert.equal(full(engine).office.occupancy, 5); // Thu 22:00
      goTo(engine, ist('2026-01-02', '05:59:50'));
      assert.equal(full(engine).office.occupancy, 5); // Fri early morning still Thursday's window
      engine.advanceSteps(1);
      assert.equal(full(engine).office.occupancy, 0); // Fri 06:00
      goTo(engine, ist('2026-01-02', '22:30'));
      assert.equal(full(engine).office.occupancy, 0); // Friday is not a working day
    } finally {
      closeDatabase(db);
    }
  });

  it('redistributes for meeting and lunch without changing the office total', () => {
    const { db, engine } = started();
    try {
      engine.setOccupancy({ mode: 'scheduled', target: 14 });
      goTo(engine, ist(THU, '10:59:50'));
      const before = assignments(engine);
      const meetingBefore = full(engine).rooms.find((r) => r.room_id === 'room-meeting')!.occupancy;
      engine.advanceSteps(1); // 11:00
      let s = full(engine);
      assert.equal(s.office.occupancy, 14);
      assert.equal(s.occupancy.redistribution?.rule_id, 'meeting');
      const moved = Math.min(4, 6 - meetingBefore); // at most 4, never beyond the 6-seat meeting room
      assert.ok(moved > 0);
      assert.equal(s.occupancy.redistribution?.occupant_ids.length, moved);
      assert.equal(s.rooms.find((r) => r.room_id === 'room-meeting')!.occupancy, meetingBefore + moved);
      checkInvariants(engine);
      goTo(engine, ist(THU, '12:00'));
      assert.equal(full(engine).occupancy.redistribution, null);
      assert.deepEqual(assignments(engine), before); // everyone back in their seat
      goTo(engine, ist(THU, '13:00'));
      s = full(engine);
      assert.equal(s.occupancy.redistribution?.rule_id, 'lunch');
      assert.equal(s.rooms.find((r) => r.room_id === 'room-pantry')!.occupancy, 4);
      assert.equal(s.office.occupancy, 14);
      checkInvariants(engine);
      goTo(engine, ist(THU, '14:00'));
      assert.deepEqual(assignments(engine), before);
    } finally {
      closeDatabase(db);
    }
  });

  it('same seed and configuration give the same timeline; device switches do not affect it', () => {
    const timeline = (seed: number, toggles: boolean): string[] => {
      const { db, engine } = started(seed);
      try {
        engine.setOccupancy({ mode: 'scheduled', target: 14 });
        const samples: string[] = [];
        for (let t = ist(THU, '08:00'); t <= ist(THU, '19:00'); t += 600) {
          goTo(engine, t);
          if (toggles && t % 1800 === 0) {
            engine.commandDevice('dev-open-light-a', { kind: 'set', on: (t / 1800) % 2 === 0 });
            engine.commandDevice('dev-meeting-ac', { kind: 'set', on: true });
          }
          checkInvariants(engine);
          samples.push(JSON.stringify(full(engine).occupancy.occupants));
        }
        return samples;
      } finally {
        closeDatabase(db);
      }
    };
    const a = timeline(42, false);
    assert.deepEqual(timeline(42, false), a);
    assert.deepEqual(timeline(42, true), a);
    assert.notDeepEqual(timeline(43, false), a);
  });
});

describe('schedule control and vacancy grace', () => {
  const meetingLight = 'dev-meeting-light';
  const meetingAc = 'dev-meeting-ac';

  it('keeps eligible equipment on through grace, then off; fridge unaffected', () => {
    const { db, engine } = started();
    try {
      goTo(engine, ist(THU, '10:00'));
      assert.deepEqual([on(engine, meetingLight), on(engine, meetingAc)], [false, false]); // open but vacant
      engine.setOccupancy({ mode: 'manual', total: 20 });
      assert.deepEqual([on(engine, meetingLight), on(engine, meetingAc)], [true, true]);
      engine.advanceSteps(6); // 10:01
      engine.setOccupancy({ mode: 'manual', total: 0 }); // meeting room vacant since 10:01:00
      goTo(engine, ist(THU, '10:05:50'));
      assert.deepEqual([on(engine, meetingLight), on(engine, meetingAc)], [true, true]); // grace 300 s
      engine.advanceSteps(1); // 10:06:00
      assert.deepEqual([on(engine, meetingLight), on(engine, meetingAc)], [false, false]);
      assert.equal(on(engine, 'dev-pantry-fridge'), true);
      goTo(engine, ist(THU, '10:07'));
      const rows = deviceIntervals(db, stateOf(engine).run_id!, meetingLight);
      const at = (hhmm: string) => rows.find((r) => r.interval_start_utc === new Date(ist(THU, hhmm) * 1000).toISOString().replace('.000Z', 'Z'))!;
      assert.deepEqual([at('10:00').on_fraction, at('10:00').vacant_on_seconds], [1, 0]);
      assert.deepEqual([at('10:02').on_fraction, at('10:02').vacant_on_seconds, at('10:02').offschedule_on_seconds], [1, 60, 0]);
      assert.deepEqual([at('10:06').on_fraction, at('10:06').energy_kwh], [0, 0]);
      const fridge = deviceIntervals(db, stateOf(engine).run_id!, 'dev-pantry-fridge');
      assert.ok(fridge.every((r) => r.on_fraction === 1));
    } finally {
      closeDatabase(db);
    }
  });

  it('schedule closing stops automatic operation even during grace; override still wins', () => {
    const { db, engine } = started();
    try {
      goTo(engine, ist(THU, '17:00'));
      engine.setOccupancy({ mode: 'manual', total: 20 });
      goTo(engine, ist(THU, '17:58'));
      engine.setOccupancy({ mode: 'manual', total: 0 }); // grace would run to 18:03
      goTo(engine, ist(THU, '17:59:50'));
      assert.equal(on(engine, meetingLight), true);
      engine.advanceSteps(1); // 18:00 closing
      assert.deepEqual([on(engine, meetingLight), on(engine, meetingAc)], [false, false]);
      engine.commandDevice(meetingLight, { kind: 'set', on: true });
      engine.advanceSteps(6);
      assert.equal(on(engine, meetingLight), true);
      const row = deviceIntervals(db, stateOf(engine).run_id!, meetingLight).at(-1)!;
      assert.deepEqual([row.on_fraction, row.override_seconds, row.offschedule_on_seconds, row.vacant_on_seconds], [1, 60, 60, 60]);
    } finally {
      closeDatabase(db);
    }
  });

  it('override beats policy and clear returns to the current policy immediately', () => {
    const { db, engine } = started();
    try {
      goTo(engine, ist(THU, '10:00'));
      engine.setOccupancy({ mode: 'manual', total: 20 });
      assert.equal(on(engine, meetingLight), true);
      const off = engine.commandDevice(meetingLight, { kind: 'set', on: false });
      assert.deepEqual([off.on, off.control_source], [false, 'override']);
      engine.advanceSteps(12);
      assert.equal(on(engine, meetingLight), false); // persists
      const cleared = engine.commandDevice(meetingLight, { kind: 'clear' });
      assert.deepEqual([cleared.on, cleared.control_source, cleared.override], [true, 'policy', null]);
      assert.deepEqual(full(engine).overrides, []);
      goTo(engine, ist(THU, '20:00'));
      engine.commandDevice('dev-meeting-projector', { kind: 'set', on: true }); // manual-control device
      assert.equal(on(engine, 'dev-meeting-projector'), true);
      engine.commandDevice('dev-meeting-projector', { kind: 'clear' });
      assert.equal(on(engine, 'dev-meeting-projector'), false); // manual devices never auto-run
    } finally {
      closeDatabase(db);
    }
  });
});

describe('versioned calendar changes', () => {
  it('apply at the next minute boundary with new versions; earlier readings keep their references', () => {
    const { db, engine } = started();
    try {
      goTo(engine, ist(THU, '10:00'));
      engine.setOccupancy({ mode: 'manual', total: 20 });
      engine.advanceSteps(3); // 10:00:30
      const runId = stateOf(engine).run_id!;
      const ack = engine.setCalendar({ working_days: [1, 2, 3, 4, 5], open_local: '09:00', close_local: '10:30' });
      const eff = new Date(ist(THU, '10:01') * 1000).toISOString().replace('.000Z', 'Z');
      assert.deepEqual([ack.applied, ack.effective_sim_utc], [false, eff]);
      const refs = ack.policy_refs as string[];
      assert.equal(refs[0], 'pol-office-hours:2');
      assert.equal(refs.length, 12); // office hours + 11 device schedules that reference it
      assert.ok(refs.includes('pol-open-ac:2'));
      assert.equal(full(engine).pending_changes[0]?.effective_sim_utc, eff);
      assert.equal(full(engine).calendar.policy_ref, 'pol-office-hours:1'); // not yet in force

      engine.advanceSteps(3); // 10:01 boundary
      assert.deepEqual(full(engine).pending_changes, []);
      assert.equal(full(engine).calendar.policy_ref, 'pol-office-hours:2');
      const beforeRows = JSON.stringify(deviceIntervals(db, runId, 'dev-open-ac'));
      engine.advanceSteps(6);
      const ac = deviceIntervals(db, runId, 'dev-open-ac');
      assert.equal(JSON.stringify(ac.slice(0, -1)), beforeRows); // history untouched
      assert.equal(ac.find((r) => r.interval_start_utc === '2026-01-01T04:30:00Z')?.policy_ref, 'pol-open-ac:1');
      assert.equal(ac.find((r) => r.interval_start_utc === '2026-01-01T04:31:00Z')?.policy_ref, 'pol-open-ac:2');

      const v2 = db.prepare("SELECT effective_from_utc, rules FROM policy_versions WHERE policy_id = 'pol-office-hours' AND version = 2").get() as { effective_from_utc: string; rules: string };
      assert.equal(v2.effective_from_utc, eff);
      assert.equal(JSON.parse((db.prepare("SELECT rules FROM policy_versions WHERE policy_id = 'pol-open-ac' AND version = 2").get() as { rules: string }).rules).office_hours_ref, 'pol-office-hours:2');
      const pinned = db.prepare("SELECT version FROM run_policies WHERE run_id = ? AND policy_id = 'pol-office-hours' ORDER BY version").all(runId) as { version: number }[];
      assert.deepEqual(pinned.map((p) => p.version), [1, 2]);

      // New hours take effect: closing at 10:30 ends automatic operation.
      goTo(engine, ist(THU, '10:29:50'));
      assert.deepEqual([on(engine, meetingLightId), on(engine, 'dev-open-ac')], [true, true]);
      engine.advanceSteps(1);
      assert.deepEqual([on(engine, meetingLightId), on(engine, 'dev-open-ac')], [false, false]);
    } finally {
      closeDatabase(db);
    }
  });

  it('validates calendar payloads', () => {
    const { db, engine } = started();
    try {
      const bad: [Record<string, unknown>, string][] = [
        [{ working_days: [], open_local: '09:00', close_local: '18:00' }, 'working_days'],
        [{ working_days: [1, 1], open_local: '09:00', close_local: '18:00' }, 'working_days'],
        [{ working_days: [0, 8], open_local: '09:00', close_local: '18:00' }, 'working_days'],
        [{ working_days: [1], open_local: '9:00', close_local: '18:00' }, 'open_local'],
        [{ working_days: [1], open_local: '09:00', close_local: '24:00' }, 'close_local'],
        [{ working_days: [1], open_local: '09:00', close_local: '09:00' }, 'close_local'],
        [{ working_days: [1], open_local: '22:00', close_local: '06:00', overnight: false }, 'overnight'],
        [{ working_days: [1], open_local: '09:00', close_local: '18:00', overnight: true }, 'overnight'],
      ];
      for (const [body, field] of bad) {
        assert.throws(() => engine.setCalendar(body as never), (e: { status?: number; field?: string }) => e.status === 400 && e.field === field, JSON.stringify(body));
      }
      assert.equal(full(engine).calendar.policy_ref, 'pol-office-hours:1');
    } finally {
      closeDatabase(db);
    }
  });
});


describe('restart and energy', () => {
  it('restart preserves assignments, RNG continuity, grace timing and pending changes', () => {
    const ops = (e: SimulationEngine): void => {
      goTo(e, ist(THU, '10:00'));
      e.setOccupancy({ mode: 'manual', total: 20 });
      goTo(e, ist(THU, '10:01'));
      e.setOccupancy({ mode: 'manual', total: 7 }); // meeting room may empty → grace
      goTo(e, ist(THU, '10:03:30'));
      e.setCalendar({ working_days: [1, 2, 3, 4, 5], open_local: '09:00', close_local: '17:00' }); // pending 10:04
    };
    const after = (e: SimulationEngine) => {
      const s = full(e);
      return { assign: assignments(e), pending: s.pending_changes.length, cal: s.calendar.policy_ref, light: on(e, meetingLightId) };
    };

    // Control: never restarted.
    const control = started(99);
    ops(control.engine);
    const controlAtPause = after(control.engine);
    goTo(control.engine, ist(THU, '10:04'));
    control.engine.setOccupancy({ mode: 'manual', total: 12 });
    const controlFinal = { ...after(control.engine), rooms: full(control.engine).rooms.map((r) => r.occupancy) };
    closeDatabase(control.db);

    const tmp = makeTempDir();
    try {
      const path = join(tmp.dir, 'sim.sqlite');
      let db = openDatabase(path);
      runMigrations(db);
      seedDemoInventory(db);
      let engine = started(99, db).engine;
      ops(engine);
      assert.deepEqual(after(engine), controlAtPause);
      engine.shutdown();
      closeDatabase(db);

      db = openDatabase(path);
      try {
        runMigrations(db);
        engine = fakeEngine(db).engine;
        engine.recover();
        assert.deepEqual(after(engine), controlAtPause); // same assignments, pending change kept
        assert.equal(full(engine).pending_changes.length, 1);
        engine.resume();
        goTo(engine, ist(THU, '10:04'));
        assert.equal(full(engine).calendar.policy_ref, 'pol-office-hours:2');
        engine.setOccupancy({ mode: 'manual', total: 12 });
        assert.deepEqual({ ...after(engine), rooms: full(engine).rooms.map((r) => r.occupancy) }, controlFinal); // no reroll
        checkInvariants(engine);
      } finally {
        closeDatabase(db);
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('restart keeps vacancy-grace timing in simulated time', () => {
    const tmp = makeTempDir();
    try {
      const path = join(tmp.dir, 'sim.sqlite');
      let db = openDatabase(path);
      runMigrations(db);
      seedDemoInventory(db);
      let engine = started(5, db).engine;
      goTo(engine, ist(THU, '10:00'));
      engine.setOccupancy({ mode: 'manual', total: 20 });
      goTo(engine, ist(THU, '10:01'));
      engine.setOccupancy({ mode: 'manual', total: 0 });
      goTo(engine, ist(THU, '10:03'));
      engine.shutdown();
      closeDatabase(db);
      db = openDatabase(path);
      try {
        engine = fakeEngine(db).engine;
        engine.recover();
        goTo(engine, ist(THU, '10:05:50'));
        assert.equal(on(engine, meetingLightId), true);
        engine.advanceSteps(1);
        assert.equal(on(engine, meetingLightId), false); // grace ended at 10:06 exactly
      } finally {
        closeDatabase(db);
      }
    } finally {
      tmp.cleanup();
    }
  });

  it('energy still reconciles device → room → office with occupancy and schedules', () => {
    const { db, engine } = started();
    try {
      engine.setOccupancy({ mode: 'scheduled', target: 14 });
      goTo(engine, ist(THU, '08:50'));
      goTo(engine, ist(THU, '14:10')); // opening, meeting, lunch redistribution
      const s = full(engine);
      const runId = stateOf(engine).run_id!;
      const devSum = stateOf(engine).devices.reduce((a, d) => a + d.energy_kwh, 0);
      assert.ok(Math.abs(s.office.energy_kwh - devSum) < 1e-12);
      assert.ok(Math.abs(s.rooms.reduce((a, r) => a + r.energy_kwh, 0) - devSum) < 1e-9);
      const byRoom = db.prepare('SELECT room_id, sum(energy_kwh) AS e FROM device_intervals WHERE run_id = ? GROUP BY room_id').all(runId) as { room_id: string; e: number }[];
      for (const r of byRoom) assert.ok(Math.abs(r.e - s.rooms.find((x) => x.room_id === r.room_id)!.energy_kwh) < 1e-8, r.room_id);
      const total = (db.prepare('SELECT sum(energy_kwh) AS e FROM device_intervals WHERE run_id = ?').get(runId) as { e: number }).e;
      assert.ok(Math.abs(total - s.office.energy_kwh) < 1e-8);
      assert.ok(s.office.energy_kwh > 5); // loads actually ran during office hours
      const occ = db.prepare("SELECT max(occupancy_max) AS m, sum(occupancy_avg) AS a FROM room_intervals WHERE run_id = ? AND room_id = 'room-pantry'").get(runId) as { m: number; a: number };
      assert.ok(occ.m >= 1 && occ.a > 0); // lunch redistribution persisted
    } finally {
      closeDatabase(db);
    }
  });
});

describe('HTTP occupancy and calendar routes', () => {
  it('accepts documented payloads and rejects invalid ones with contract errors', async () => {
    const db = memoryDb();
    const { engine } = fakeEngine(db);
    const server: Server = createApp(loadConfig({}), { db, engine }).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; field?: string } } };
    };
    try {
      assert.equal((await post('/occupancy', { mode: 'manual', total: 3 })).status, 409); // no run yet
      assert.equal((await post('/control/start', { seed: 7 })).status, 200);
      assert.deepEqual((await post('/control/start', { seed: 8 })).body.error?.code, 'CONFLICT'); // seed only at creation
      const occ = await post('/occupancy', { mode: 'manual', total: 3 });
      assert.equal(occ.status, 200);
      assert.equal(occ.body.data?.office_count, 3);
      assert.equal((occ.body.data?.allocation as unknown[]).length, 5);
      const sched = await post('/occupancy', { mode: 'scheduled', target: 12 });
      assert.deepEqual([sched.body.data?.mode, sched.body.data?.target, sched.body.data?.occupancy_policy_ref], ['scheduled', 12, 'pol-occupancy:2']);
      const cal = await post('/calendar', { working_days: [1, 2, 3, 4, 5, 6], open_local: '08:30', close_local: '17:30' });
      assert.equal(cal.status, 200);
      assert.equal(cal.body.data?.effective_sim_utc, '2025-12-31T18:30:00Z');
      for (const [path, body, field] of [
        ['/occupancy', { mode: 'manual', total: 25 }, 'total'],
        ['/occupancy', { mode: 'manual', total: 3, extra: 1 }, 'extra'],
        ['/calendar', { working_days: [1], open_local: '10:00', close_local: '10:00' }, 'close_local'],
        ['/control/reset', { seed: -1 }, 'seed'],
      ] as const) {
        const r = await post(path, body);
        assert.deepEqual([r.status, r.body.error?.code, r.body.error?.field], [400, 'VALIDATION_ERROR', field], JSON.stringify(body));
      }
    } finally {
      engine.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      closeDatabase(db);
    }
  });
});
