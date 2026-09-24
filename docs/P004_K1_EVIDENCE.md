# P004_K1_EVIDENCE — authoritative simulation clock and first energy loop

Assignment P004, layer K1. Agent B (Claude Code); owner Mohan; 2026-09-24.
Scope: `simulation-backend` only. Implementation is **completed**; review is
**pending**. The commit hash is reported in the P004 return report after the
push. Design, decisions and semantics are in
[SIMULATION_ENGINE.md](SIMULATION_ENGINE.md).

## Starting state

- No `AGENTS.md`. The baseline was `b0f569a` (P002, accepted based on supplied
  evidence), equal to `origin/main`, with a clean tree.
- The P002 acceptance and the owner decisions were recorded in PROGRESS_LOG
  before any code changed.
- The contract is unchanged: the verifier gives 75/75, including manifest
  hashes.

## What was implemented

- **Routes:**
  - `GET /api/v1/state`;
  - `POST /api/v1/control/{start,pause,resume,reset,speed}`;
  - `POST /api/v1/devices/:id` (lighting only);
  - `GET /api/v1/health`, which now reports the real run and processed time
    once a run exists.
- **Engine and scheduler:**
  - deterministic `advanceSteps()` with fixed 10 s steps;
  - speeds 1/2/10/60/100/1000;
  - initial time 2026-01-01 00:00 IST (`2025-12-31T18:30:00Z`);
  - a monotonic wall-clock scheduler that processes bounded batches (120
    steps) and yields between them;
  - a single loop that never skips steps.
- **Persistence:**
  - Transactional minute room/device intervals, written in the same
    transaction as the checkpoint.
  - Migration **002** `engine_checkpoints`, a forward migration: at most one
    active run, and ended runs are final and undeletable. Migration 001 is
    byte-identical and its checksum is still accepted.
- **Lifecycle:** reset ends the old run (publishing its partial interval
  with `partial = 1`) and creates a new run with seq 0, paused.
- **Recovery:** startup recovers the active run paused. Graceful shutdown
  checkpoints the partial accumulator.

## State response shape

- **Contract fields:** `run_id`, `seq`, `sim_time_utc`,
  `rooms[{room_id, occupancy}]` and `devices[{device_id, on, power_w}]`.
- **Added fields:**
  - top level: `status`, `speed`, `step_seconds`, `office{power_w, energy_kwh}`,
    `partial_interval{start_utc, covered_seconds}`;
  - per room: `power_w`, `energy_kwh`;
  - per device: `room_id`, `override`, `energy_kwh`.
- **Control responses:** `{run_id, seq, sim_time_utc}` plus `status` and
  `speed`. The speed route returns `{speed}`.
- **Device command responses:** `{device_id, override, seq}` plus
  `sim_time_utc`, which is the step boundary the command applied at.

## Checks (2026-09-24)

| Command | Result |
|---|---|
| `npm run verify:contract` | 75 passed, 0 failed |
| `npm run validate:schema` | 24 passed, 0 failed |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test` | **39 passed, 0 failed** (22 earlier + 17 new) |
| `npm run build` | exit 0 |

All tests use `:memory:` databases or test-owned temp directories, which
were removed afterwards (0 left). The new tests cover:

- **1 kW over one hour:** a test load on for 360 steps gives exactly
  1 kWh, within 1e-12 in state. The 60 minute rows sum to 1 kWh, the last
  cumulative value is 1, and every row has avg = max = 1000 W and
  on_fraction 1. The fridge is separately 0.15 kWh. Office = Σ devices = Σ
  rooms = 1 + 0.15 + 0.018 (standby).
- **Every speed:** 1/2/10/60/100/1000, driven through the scheduler with a
  fake monotonic clock for exactly one simulated hour of real time, each
  processed 360 steps and 3600 s, the load used 1 kWh, and **office energy
  was bit-identical across all speeds**.
- **Toggle:**
  - minute 1 is off and its row is unchanged after the toggle;
  - minute 2 is on: 0.0012 kWh, avg/max 72;
  - minute 3 is half on: 0.0006 kWh, avg 36, max 72, on_fraction 0.5,
    override_seconds 60;
  - vacant and off-schedule seconds were measured correctly (00:01 IST
    Thursday is outside office hours, and all rooms are vacant).
- **Reconciliation over 10 minutes:**
  - every device's cumulative difference equals its interval energy, and its
    interval sum equals its state energy;
  - the database total equals office energy;
  - per-room database sums equal the state room energies;
  - all 180 device rows and 50 room rows validate against the contract
    **interval item schemas** (Ajv).
- **Pause:**
  - 30 s processed, then paused: the partial covers 30 s;
  - a further hour of fake real time changed nothing (tick processed 0
    steps and state was identical apart from seq);
  - resume completed **one** 60 s non-partial interval with the full
    minute's energy.
- **Repeated start/resume:** 3× start and 2× resume are no-ops (seq
  unchanged). 6 s of real time at 10× processed exactly 6 steps (60 s).
- **Invalid transitions:**
  - pause, resume or a device command with no run gives 409 CONFLICT;
  - speed 5 or 3 gives 400; state stays `not_initialized`;
  - unknown device gives 404; AC or refrigerator control gives 400.
- **Reset:**
  - new run_id, paused, seq 0, initial time; energy and overrides start
    fresh;
  - the old run keeps a full minute plus a **30 s partial edge interval**
    (end 18:31:30Z, `partial = 1`, avg 1000 W over the actual 30 s,
    contract-valid);
  - the old checkpoint is `ended` and can't be reactivated; 2 runs are kept.
- **Graceful restart:** 2.5 minutes, then `shutdown()`, close and reopen:
  the run is recovered **paused** with the same time, seq, speed (1000),
  30 s partial and override, and still 2 intervals. Resume plus 3 steps
  completes minute 3 as a full 60 s interval with the correct cumulative
  value.
- **Crash restart:** 2.5 minutes with no shutdown, then reopen: the run is
  recovered paused at the last minute checkpoint (18:32:00Z). The 30 s since
  it are lost (the documented boundary). Energy equals the persisted
  cumulative value, and continuing creates no duplicate keys.
- **HTTP:**
  - `not_initialized` state/health before any run; 409s on run-dependent
    calls;
  - body validation returns 400 with the offending field;
  - start at 60× gives the contract response;
  - light on/clear works and exposes state; clearing restores base "off";
  - health becomes `ok` with the real run;
  - device error cases (404/400);
  - reset returns seq 0 and the initial time.
- **Responsiveness:**
  - at 1000× with **one real hour of owed time** (360,000 steps) injected
    instantly, health stayed responsive while the backlog was processed;
  - the measured **maximum health latency was 27.6 ms** (18.3 ms in an
    earlier run), with ~54,000 simulated seconds processed within the test
    window;
  - exposed time only moved forward and stayed at the processed value, not
    the owed target;
  - pause then froze time.
- **Earlier tests still pass:** health/inventory/error/CORS/config, P002
  database tests (now expecting migrations [1, 2]), and the real-process
  IPC graceful-shutdown test.

## Live HTTP demonstration (compiled build, port 4000, temp database)

A temp database was set up with `npm run db:setup` (`DATABASE_PATH` in the
agent scratchpad, not `data/`). Commands ran against `node dist/server.js`,
PID 14812:

```text
GET  /api/v1/health -> 200 {"status":"not_initialized","run_id":null,"sim_time_utc":null,"contract_version":"1.0.1"}
POST /api/v1/control/start {"speed":60} -> 200
     {"run_id":"run-20260924T143842Z-5101d0a8","seq":1,"sim_time_utc":"2025-12-31T18:30:00Z","status":"running","speed":60}
GET  /api/v1/state -> running, seq 6, sim 18:30:50Z, partial 50 s; meeting light off 0 W;
     fridge 150 W 0.0020833 kWh; office 168 W 0.0023333 kWh
POST /api/v1/devices/dev-meeting-light {"manual_state":"on"} -> 200
     {"device_id":"dev-meeting-light","override":{"active":true,"on":true},"seq":7,"sim_time_utc":"2025-12-31T18:30:50Z"}
(2.5 s real at 60x)
POST /api/v1/control/pause -> 200 {"run_id":"run-20260924T143842Z-5101d0a8","seq":23,"sim_time_utc":"2025-12-31T18:33:20Z","status":"paused","speed":60}
GET  /api/v1/state -> paused, sim 18:33:20Z, partial 20 s; meeting light on 72 W, 0.003000 kWh;
     fridge 150 W 0.0083333 kWh; office 240 W (150 + 72 + 18 standby), 0.0123333 kWh
(1 s later) sim still 18:33:20Z (unchanged: true)
POST /api/v1/devices/dev-open-ac {"manual_state":"on"} -> 400 VALIDATION_ERROR
     "Manual control of ac devices is not supported yet (K1 supports lighting with the switch control)"
IPC shutdown -> "engine stopped and checkpointed" -> "database closed; exiting" -> exit 0
```

Persisted meeting-light minute intervals:

| start (UTC) | s | energy kWh | cumulative | avg W | max W | on_fraction | override/vacant/offschedule s | policy_ref |
|---|---|---|---|---|---|---|---|---|
| 18:30:00 | 60 | 0.0002 | 0.0002 | 12 | 72 | 0.1667 | 10/10/10 | pol-meeting-light:1 |
| 18:31:00 | 60 | 0.0012 | 0.0014 | 72 | 72 | 1 | 60/60/60 | pol-meeting-light:1 |
| 18:32:00 | 60 | 0.0012 | 0.0026 | 72 | 72 | 1 | 60/60/60 | pol-meeting-light:1 |

- **Rows:** 54 device-interval rows (18 × 3 minutes, Σ 0.011 kWh) and 15
  room-interval rows.
- **Checkpoint:** `active`, seq 23, 18:33:20Z, speed 60, partial 20 s.
- **Reconciliation:**
  - light: 0.0026 persisted + 20 s × 72 W (0.0004) = 0.0030 in state;
  - office: 0.011 + 20 s × 240 W (0.0013333) = 0.0123333.

**Restart** (`node dist/server.js`, PID 22088, same database):
- the log shows "recovered run run-20260924T143842Z-5101d0a8 at
  2025-12-31T18:33:20Z (seq 23) as paused";
- state was identical: paused, same time, seq, energy and override;
- health was `ok` with that run;
- IPC shutdown exited 0.

Afterwards port 4000 was free and only `demo.sqlite` remained in the scratch
directory. **No process is left running.**

## Limitations

- **Temporary manual-demo behaviour:**
  - no occupancy (all rooms 0);
  - constant synthetic climate;
  - only lighting is controllable;
  - clear-override restores the base state;
  - constant refrigerator load;
  - no AC thermal model;
  - no voltage/current.
  Schedules are **measured** (`offschedule_on_seconds`) but never
  **executed**.
- **Crash loss:** after an abrupt crash, up to one simulated minute of
  uncheckpointed steps can be lost. Graceful shutdown loses nothing.
- **OS signals:** Ctrl+C (SIGINT) and Linux SIGTERM delivery was not
  exercised by the agent. The same `shutdown()` path was verified via IPC.
- **Pause discards owed wall time:** any unprocessed backlog at pause is
  dropped as wall time, never as simulated steps.
- **Start date:** new runs always start at 2026-01-01 00:00 IST
  (configurable dates are a later task).

## Not implemented (scope control)

Automatic occupancy allocation, scheduled redistribution, lighting-schedule
execution, comfort control, Socket.IO, month generation/export, fault
injection, frontend changes and deployment.

## Next-task dependencies

1. The schedule layer replaces clear-override → base with policy evaluation
   (`src/engine/schedule.ts` already evaluates windows) and adds vacancy
   grace.
2. Occupancy allocation feeds `rooms[].occupancy`; vacant-on measurement
   already uses it.
3. Socket.IO can emit `state.update` from engine seq changes. Snapshot and
   history reads come from `getState()` and the interval tables.
4. Export reads the run snapshots plus the intervals (partial edge rows
   already marked).
5. Frontend (OpenCode) can poll `GET /api/v1/state` and call the control and
   lighting routes.
