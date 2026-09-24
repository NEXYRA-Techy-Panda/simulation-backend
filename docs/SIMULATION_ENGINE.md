# Simulation engine (K1) — implementation notes

Status: K1 (P004) engine core, 2026-09-24, review pending. This is the
authoritative simulation clock and first energy loop, **not** schedule
automation or complete office behaviour. Contract 1.0.1 is unchanged.

## Owner decisions (confirmed for P004)

1. An empty device `on_windows` follows the device's referenced office-hours
   schedule (`office_hours_ref`).
2. Manual occupancy is acceptable initially (all rooms start and stay at 0 in
   K1).
3. Inventory may show the latest policies; historical data retains the
   applicable versions (runs pin versions; intervals carry `policy_ref`).
4. Manual device overrides persist until cleared.
5. The existing isolated `node:sqlite` driver is used.
6. Contract 1.0.1 remains unchanged.

## Structure

| File | Role |
|---|---|
| `src/engine/constants.ts` | 10 s step, 60 s interval, speeds, initial time, batch limits, `MANUAL_DEMO_CONFIG` |
| `src/engine/engine.ts` | `SimulationEngine`: lifecycle, deterministic `advanceSteps()`, energy, minute persistence, checkpoints, recovery, lighting control |
| `src/engine/scheduler.ts` | `WallClockScheduler`: monotonic real time × speed → owed steps; bounded batches; yields |
| `src/engine/schedule.ts` | Office-hours/window evaluation in Asia/Kolkata, used **only to measure** `offschedule_on_seconds` |
| `src/routes/simulation.ts` | `GET /state`, `POST /control/{start,pause,resume,reset,speed}`, `POST /devices/:id` |
| `src/db/migrations/002_engine_checkpoints.ts` | Checkpoint table (forward migration; 001 untouched) |

## Clock

- Fixed **10 simulated seconds** per step. Minute intervals are aligned to
  the UTC minute grid.
- The initial simulation time is **2026-01-01 00:00 Asia/Kolkata**, stored as
  `2025-12-31T18:30:00Z`. Every new run starts there (configurable dates come
  later).
- Speeds are 1, 2, 10, 60, 100 and 1000. The default is 1.
- **Scheduling:** `performance.now()` (monotonic) × speed accrues owed
  simulated seconds. Whole steps are processed in batches of at most 120
  (20 simulated minutes). If a backlog remains, the loop yields with
  `setImmediate`; otherwise it waits 50 ms.
  - Owed time is carried forward and never dropped while running: no step is
    skipped.
  - Only **processed** time is exposed. Nothing reports a clock ahead of the
    calculations.
- **Determinism:** `advanceSteps(n)` is independent of wall time. Energy is
  computed from simulated step duration only, so equal processed durations
  give equal energy at every speed.
- **Single loop:** `start()`/`resume()` on a running engine are no-ops, so
  repeated requests never create a second timer.
- **Pause** stops the loop. Any owed-but-unprocessed wall time is discarded,
  simulated time freezes at the last processed step, and the partial-minute
  accumulator is kept.

## Lifecycle

| Request | not_initialized | paused | running |
|---|---|---|---|
| start `{speed?}` | new run → running | running | no-op |
| resume `{speed?}` | **409 CONFLICT** | running | no-op |
| pause | **409 CONFLICT** | no-op | paused |
| reset | new run → paused | old run ended; new run → paused | old run ended; new run → paused |
| speed `{speed}` | sets speed | sets speed | sets speed (time so far counts at the old speed) |
| devices/:id | **409 CONFLICT** | applied | applied |

- **Invalid speed** returns 400 `VALIDATION_ERROR` (`field: speed`).
- **Unknown body fields** return 400.
- **seq** starts at 0 for a new run. It increases with every processed step
  and every authoritative change (device command, status or speed change),
  and resets for a new run.
- **Reset** keeps all old runs, their readings and their checkpoints (marked
  `ended`, final and undeletable).

## Manual-demo run configuration (temporary, synthetic)

The configuration is stored immutably in `simulation_runs.config`:

- **Occupancy:** every room is 0 (manual mode).
- **Environment:** a constant **synthetic** 26.0 °C and 55 % RH (no thermal
  model).
- **Initial state:** controllable loads start **off**. Always-on devices (the
  refrigerator) start **on**.
- **Power:**
  - A device that is on draws its `nominal_power_w`, which already covers the
    whole device or group. The workstation group draws 960 W and is never
    multiplied by quantity.
  - A device that is off draws `standby_power_w`, or 0 if it has none.
  - The refrigerator is a constant 150 W with no cycling.
- **Not implemented:** AC thermal behaviour, refrigerator cycling, automatic
  schedules, occupancy movement, voltage/current (`avg_voltage_v` and
  `avg_current_a` are omitted from intervals).

## Device control (K1)

- `POST /api/v1/devices/:id` accepts exactly one of `{"manual_state":"on"}`,
  `{"manual_state":"off"}` or `{"clear_override":true}`.
- **Supported devices:** only lighting devices that have the `switch` control.
  - Any other device returns 400 `VALIDATION_ERROR`.
  - An unknown device returns 404 `NOT_FOUND`.
  - A command before any run exists returns 409.
- **When it applies:** at the current processed step boundary (the returned
  `sim_time_utc`). It affects later steps only; accumulated energy is never
  changed.
- **Override persistence:** an override lasts until it is cleared. **Clearing
  restores the initial/base state** (lights off). This is temporary: the
  schedule layer will replace it with automatic policy evaluation. No
  schedule controller exists yet.

## Energy and minute persistence

- **Energy per step:** `energy_kwh = power_w × 10 / 3,600,000`. Totals are
  accumulated unrounded, per device, run-relative.
- **Each completed minute** is written in one transaction: 5 room intervals,
  one device interval per device (18 in the seeded inventory), and the
  checkpoint.
- **Device interval fields:**
  - `energy_kwh`, and `cumulative_kwh` at interval end.
  - `avg_power_w` = power-seconds ÷ **actual covered seconds**.
  - `max_power_w`, and `on_fraction`.
  - `override_seconds`, `vacant_on_seconds` (on while its room has 0
    occupants; measured even for always-on devices, matching the fixture)
    and `offschedule_on_seconds` (on outside its policy window).
  - `power_factor`, `policy_ref` (from the version pinned for the run), and
    `partial`.
- **Room intervals** carry occupancy 0/0/0 and the synthetic climate values.
- **Totals:** room and office totals are sums of device values, both in state
  and in the database.
- **Partial minute:**
  - The current partial minute stays in memory and in the checkpoint. It is
    never published as a full minute.
  - **Pause** keeps it.
  - **Reset** publishes it as an edge interval with `partial = 1`, the real
    end time and the real `interval_seconds` (e.g. 30).
  - **Graceful shutdown** checkpoints it (durable partial accumulator) and
    publishes nothing, so after recovery the minute completes normally.

## Checkpoints and restart

- **Contents:** one `engine_checkpoints` row per run, holding processed
  `sim_time_utc`, seq, speed, and JSON state: each device's base state,
  override and cumulative kWh, room occupancy, and the partial accumulator.
- **When written:**
  - with every completed minute, in the same transaction as the intervals;
  - on start/resume, pause, speed change, device command and shutdown;
  - on reset, when the old run is marked `ended`.
- **On startup:**
  1. The server migrates the database.
  2. It recovers the single `active` run as **paused**.
  3. No time advances during downtime.
  4. It never reports `running` until it is explicitly started or resumed.
- **No double counting:** the checkpoint and its intervals commit atomically,
  and interval keys are unique.
- **Crash boundary:** after an abrupt crash (no graceful shutdown), steps
  processed after the last checkpoint are lost. That is at most the steps
  since the last completed minute or command, which is under one simulated
  minute. Recovery restarts from the last checkpoint.

## Remaining work (later layers)

- Schedule automation: office hours, lighting schedules, vacancy grace, and
  replacing clear-override → base state.
- Occupancy allocation and redistribution.
- Comfort/AC behaviour.
- Control for other device types.
- Configurable start dates.
- Socket.IO sequencing/replay.
- Batch history generation.
- CSV/JSON export.
- Fault controls.
