# P008_K3_K4_EVIDENCE — occupancy allocation and operating schedules

Assignment P008, layers K3–K4. Agent B (Claude Code); owner Mohan;
2026-09-24. Scope: `simulation-backend` only. Implementation is
**completed**; review is **pending**. The commit hash is reported in the
P008 return report after the push. Design, decisions and **complete API
examples for OpenCode** are in [SIMULATION_ENGINE.md](SIMULATION_ENGINE.md).

## Starting state

- No `AGENTS.md`. The baseline was `93da205` (P004, accepted based on
  supplied evidence), equal to `origin/main`, with a clean tree. The
  acceptance was recorded in PROGRESS_LOG first.
- The contract is unchanged (verifier 75/75, including manifest hashes).
- There is **no new migration**. Runtime policy versions use the existing
  `policy_versions` table (append-only, contiguous) and `run_policies`
  (insert-only; update/delete blocked). Checkpoint JSON moved to format 2
  and pre-K3 checkpoints still load.

## Implemented

- **Occupancy (K3):**
  - 20 stable occupants (`occ-01`…`occ-20`), each with a seeded home seat;
    automatic, capacity-respecting allocation that keeps existing
    assignments.
  - Manual mode (`total`) and scheduled mode (`target`, default 14; present
    while office hours are open).
  - Seeded meeting (11–12) and lunch (13–14) redistribution in scheduled
    mode.
  - A seeded, checkpointed mulberry32 occupancy stream, separate from the
    reserved device stream.
  - Clear rejections: 400 for values outside 0–20, 409 above room capacity.
- **Schedules (K4):**
  - Lights run when the office hours are open **and** the room is occupied
    or within grace. Scheduled devices do the same using their referenced
    office hours ∩ `on_windows`. Manual-control devices run only by
    override. The always-on refrigerator always runs.
  - Grace is measured in simulated time and ends at schedule closing.
  - Overrides work on all switch-capable devices, persist, and clear back to
    the current policy.
- **Routes:**
  - `POST /api/v1/occupancy` and `POST /api/v1/calendar`;
  - optional `seed` on start/reset;
  - `GET /api/v1/state` extended with occupancy, calendar, overrides and
    pending changes (additions listed in SIMULATION_ENGINE.md).
- **History:**
  - Calendar changes create new office-hours versions plus new
    `device_schedule` versions, effective at the next minute boundary. They
    are held as pending (checkpointed) and pinned into `run_policies` in the
    same transaction as the completed minute.
  - Occupancy mode changes create occupancy-policy versions.
  - Past intervals keep their references.

## Checks (2026-09-24)

| Command | Result |
|---|---|
| `npm run verify:contract` | 75 passed, 0 failed |
| `npm run validate:schema` | 24 passed, 0 failed |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test` | **56 passed, 0 failed** (39 existing, 4 updated for intended changes, + 17 new) |
| `npm run build` | exit 0 |

The 4 updated expectations are:
- the AC now accepts manual switching, so the refrigerator is the 400 case;
- the not_initialized state has the new null/empty fields;
- the device state has `control_source` and `policy_ref`;
- the cleared light's comment now reads policy instead of base state.

The new tests (in-memory databases or test-owned temp directories, 0 left
behind) cover:

- **Totals 0/1/20:**
  - invariants hold: office = Σ rooms = placed occupants, 20 unique IDs,
    each in at most one room, no room over capacity;
  - total 20 fills workspace 12 / reception 2 / manager 2 / meeting 4 /
    pantry 0;
  - manual count persists at 03:00.
- **Capacity:** with capacities set to 2 (total 10), 10 is OK, while 11
  (manual and scheduled) gives 409. 21, −1, 2.5, a missing total, a
  mode/field mismatch and an unknown mode give 400. State is unchanged.
- **Stable identities:** going 10 → 14 keeps the original 10 in their rooms;
  14 → 6 keeps the remaining 6 in their rooms; the ID list is stable.
- **Partial-occupancy minute:** 1 occupant from 10:00:30 gives the room
  interval occupancy_avg 0.5, occupancy_max 1, occupied_fraction 0.5, and it
  is contract-valid.
- **Opening/closing:**
  - 08:59:50 → 0, 09:00 → 14, 17:59:50 → 14, 18:00 → 0;
  - Friday 10:00 → 14; Saturday and Sunday → 0.
- **Overnight:**
  - Thu 22:00–06:00 is `overnight: true`, applied immediately on a
    boundary;
  - Thu 21:59:50 → 0, 22:00 → 5, Fri 05:59:50 → 5, 06:00 → 0;
  - Fri 22:30 → 0, because the window belongs to Thursday.
- **Redistribution:**
  - At 11:00 the meeting room gains min(4, free seats) movers; the total
    stays 14.
  - At 12:00 everyone is back in their exact seats. The 13:00 lunch puts 4
    in the pantry; at 14:00 everyone is back.
- **Reproducibility:** seed 42 gives the identical 10-minute-sampled
  occupant timeline from 08:00 to 19:00 twice, and the **same timeline with
  light/AC switching**. Seed 43 differs.
- **Grace:**
  - open-hours meeting room with 20 present: light and AC on; at 10:01 the
    total goes to 0;
  - at 10:05:50 still on; at 10:06:00 off (300 s);
  - interval checks: 10:02 on_fraction 1, vacant 60, off-schedule 0; 10:06
    energy 0;
  - the fridge's on_fraction is 1 in every interval.
- **Closing during grace:** vacancy at 17:58 would give grace until 18:03,
  but the light is off at 18:00. An override then keeps it on (override 60,
  off-schedule 60, vacant 60 s).
- **Override vs policy:**
  - override off beats an occupied room and persists;
  - clear gives `on: true`, `control_source: "policy"` and an empty
    `overrides` list;
  - the projector (manual control) runs only by override and is off after
    clear.
- **Calendar versioning:**
  - A change at 10:00:30 is acknowledged as effective 10:01:00, not yet
    applied. It creates 12 refs (`pol-office-hours:2` plus 11 device
    schedules) and appears in pending.
  - At 10:01 the office-hours ref is v2 and nothing is pending.
  - AC rows: 10:00 is `pol-open-ac:1`, 10:01 is `pol-open-ac:2`; earlier
    rows are byte-identical.
  - v2 has `effective_from_utc` 10:01; `pol-open-ac:2` refers to
    office-hours v2; the run pins office hours [1, 2].
  - The new 10:30 closing turns the light and AC off at 10:30.
  - Validation of 8 bad calendars returns 400 with the right field.
- **Restart:**
  - With a file DB, seed 99, and occupancy + calendar changes before
    shutdown, the recovered state equals a never-restarted control run
    (assignments, pending, calendar, light).
  - After resuming, the pending change applies at 10:04. Setting 12 then
    gives **identical** assignments and room counts to the control, so
    there is no reroll.
  - Grace across a restart still ends exactly at 10:06.
- **Energy (scheduled day through lunch):** office = Σ devices (1e-12) = Σ
  rooms. Database per-room and total sums match the state. Pantry occupancy
  was persisted.
- **HTTP:**
  - occupancy with no run gives 409; start with seed 7 works; a seed on an
    existing run gives 409;
  - manual 3 and scheduled 12 (→ `pol-occupancy:2`) work; the calendar
    change works;
  - 400s for total 25, an unknown field, open == close, and seed −1.
- **Earlier behaviour still passes:** 1 kW × 1 h = 1 kWh; identical energy
  at all 6 speeds; pause/partial/reset/crash and graceful restart;
  responsiveness (max health latency 37.4 ms while processing a 1000× backlog
  in this run); the real-process IPC graceful shutdown.

## Live HTTP demonstration (compiled build, port 4000, temp database)

`node dist/server.js` (PID 16576) ran against a scratch `DATABASE_PATH` set
up by `npm run db:setup`. The default `data/` database was not used. Full
request/response bodies are embedded in SIMULATION_ENGINE.md.

1. `POST /control/start {"speed":1000,"seed":2026}` → 200 (run
   `run-20260924T145921Z-4a3b4365`).
2. `POST /occupancy {"mode":"scheduled","target":14}` → 200, office_count 0
   (00:00, closed), `pol-occupancy:2`.
3. Ran at 1000× to 11:11:20 IST, then `pause`. State: 14 people (manager 1,
   meeting 5, workspace 7, reception 1), the **meeting** redistribution
   active (4 movers), office 6428 W, 15.582178 kWh, meeting light on
   (policy).
4. `POST /calendar {"working_days":[1,2,3,4,5],"open_local":"08:30","close_local":"17:30"}`
   → 200: `applied: false`, effective `2026-01-01T05:42:00Z` (11:12 IST), 12
   policy refs. The state showed 1 pending change.
5. `POST /occupancy {"mode":"manual","total":16}` → 200 at 05:41:20Z, with
   allocation manager 1 / meeting 3 / workspace 10 / pantry 0 / reception 2
   and `pol-occupancy:3`. Redistribution ended and the movers returned home.
6. Light off → `control_source: "override"`, on false. Light on → override,
   on true. Clear → `override: null`, on true, `control_source: "policy"`.
7. `POST /control/resume {"speed":60}`; after 2 s the state was running at
   05:43:20Z: office 16, calendar `pol-office-hours:2` 08:30–17:30, nothing
   pending, 15.796444 kWh. Then `pause`.
8. Errors: total 21 → 400 (`total`); 09:00 == 09:00 → 400 (`close_local`);
   fridge off → 400 (`device_id`).
9. IPC shutdown → "engine stopped and checkpointed" → "database closed" →
   exit 0. Port 4000 was free afterwards.

Database readback:
- Office-hours v1 (effective 2000-01-01) and v2 (effective
  `2026-01-01T05:42:00Z`, 08:30–17:30); the run pins [1, 2].
- `dev-open-ac` has 672 rows with `pol-open-ac:1` up to 05:41 and
  `pol-open-ac:2` from 05:42.
- Meeting-room intervals: 05:38–05:40 had avg 5; **05:41 had avg 3.6667**
  (5 for 20 s, then 3 for 40 s: the switch to manual mid-minute), max 5; 05:42
  had avg 3.
- 12,114 device-interval rows totalling 15.760733 kWh. Adding the 20 s
  partial at 6428 W (0.035711 kWh) gives the state's 15.796444 kWh.

**No process is left running.**

## Limitations

- Everyone arrives at opening and leaves at closing. There is no staggered
  arrival, and redistribution is limited to the two predefined rules.
- AC has no comfort/temperature control, the room climate is constant and
  synthetic, and the refrigerator draw is constant.
- A run created later pins the latest policy versions from its own start,
  even when their `effective_from_utc` came from an earlier run's timeline.
- Occupancy, calendar and device commands need an existing run (409
  otherwise). The frontend can call `reset` to create a paused run.
- Crash loss is under one simulated minute. OS-signal shutdown was not
  exercised (the IPC path was).
- `total`/`target` are runtime state (checkpointed), not policy fields,
  because the contract's occupancy rules are closed.

## Not implemented (scope control)

Frontend, Socket.IO, batch history generation, export, fault injection,
realistic thermal simulation and deployment.

## Next-task dependencies

1. **OpenCode (frontend)** uses the exact examples in SIMULATION_ENGINE.md:
   `GET /state` for the occupant dots (stable `occupant_id` and `room_id`),
   plus `/occupancy`, `/calendar` and `/devices/:id`.
2. **Socket.IO** can emit `state.update` with the same payload as
   `GET /state`, keyed by `seq`.
3. **Export** reads run snapshots, all pinned versions (with
   `effective_from_utc`) and intervals.
4. **Comfort/AC** behaviour can build on the schedule gate in `autoOn()`.
