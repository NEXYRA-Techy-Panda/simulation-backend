# Simulation engine — implementation notes (K1 + K3–K4)

Status (2026-09-24):
- **K1** (P004, accepted based on supplied evidence) delivered the
  authoritative clock and energy loop.
- **K3–K4** (P008, review pending) added occupancy allocation and operating
  schedules.

Contract 1.0.1 is unchanged. Everything marked **[addition]** below goes
beyond the contract's minimum shapes. It is local to this service and does
not change the shared contract bundle.

## Owner decisions

From P004:
1. An empty device `on_windows` follows the referenced office-hours
   schedule.
2. Manual occupancy is acceptable initially.
3. Inventory shows the latest policies; history keeps the applicable
   versions.
4. Manual overrides persist until cleared.
5. The `node:sqlite` driver is used.
6. The contract is unchanged.

From P008 (MVP):
7. **Overnight windows** (`close_local < open_local`) belong to their
   **opening** day. For example, Thu 22:00–06:00 is Thursday's window and
   runs until Fri 06:00.
8. **`open_local == close_local` is invalid** (400). A zero-length or 24-hour
   window is not guessed.
9. **Schedule closing ends automatic operation.** Vacancy grace applies only
   while the schedule permits operation. A manual override can still keep a
   device on.
10. **Explicit `on_windows` further restrict** the referenced office hours
    (intersection). An empty `on_windows` means "follow the office hours".
11. **Calendar/policy changes** take effect at the **next minute boundary**,
    or immediately when the run is exactly on one, so each persisted interval
    has one policy reference. **Occupancy and manual device changes** take
    effect at the current step boundary (the next 10 s step).
12. **Clearing an override** returns the device to its **current policy**
    immediately. This replaces K1's temporary "restore base state".

## Structure

| File | Role |
|---|---|
| `src/engine/constants.ts` | 10 s step, 60 s interval, speeds, initial time, batch limits, `RUN_CONFIG` |
| `src/engine/engine.ts` | lifecycle, deterministic `advanceSteps()`, policy control + grace, occupancy/calendar/device commands, minute persistence, checkpoints, recovery |
| `src/engine/occupancy.ts` | `OccupancyModel`: 20 stable occupants, seeded allocation, capacity checks, meeting/lunch redistribution |
| `src/engine/rng.ts` | seeded mulberry32 (uint32 state, checkpointed); independent `occupancy`/`devices` streams |
| `src/engine/schedule.ts` | permitted-operation windows (Asia/Kolkata, ISO weekdays, overnight → opening day) |
| `src/engine/scheduler.ts` | monotonic wall-clock scheduler (bounded batches, yields, no skipped steps) |
| `src/routes/simulation.ts` | `/state`, `/control/*`, `/occupancy`, `/calendar`, `/devices/:id` |

## Clock and lifecycle (unchanged from K1)

- **Steps and speeds:** fixed 10 s steps at speeds 1/2/10/60/100/1000.
- **Initial time:** new runs start at 2026-01-01 00:00 Asia/Kolkata
  (`2025-12-31T18:30:00Z`).
- **Separation:** the deterministic `advanceSteps()` is kept apart from
  wall-clock scheduling. The state shows only processed time.

| Request | not_initialized | paused | running |
|---|---|---|---|
| start `{speed?, seed?}` | new run → running | running (`seed` → 409) | no-op (`seed` → 409) |
| resume `{speed?}` | 409 CONFLICT | running | no-op |
| pause | 409 CONFLICT | no-op | paused |
| reset `{seed?}` | new run → paused | old run ended → new run paused | same |
| speed `{speed}` | sets | sets | sets |
| occupancy / calendar / devices/:id | 409 CONFLICT | applied | applied |

- **`seed` [addition]:** an optional integer from 0 to 4294967295, accepted
  only when a run is **created** (start from `not_initialized`, or reset). It
  is stored immutably in the run config as `occupancy_seed`. When omitted, a
  random seed is generated and stored, and it is shown in
  `state.occupancy.seed`.
- **`seq`** increases with every processed step and every authoritative
  change, and restarts at 0 for a new run.

## Occupancy model (K3)

- **Occupants:** 20 stable occupants, `occ-01` … `occ-20`. Each is in exactly
  one room or outside (`room_id: null`). The office count equals the sum of
  room counts, and no room exceeds its capacity.
- **Home seats (seeded, per run):** seats are listed in allocation priority,
  room by room, one entry per unit of capacity. The order is
  `open_workspace`, `reception`, `manager_cabin`, `meeting_room`, `pantry`,
  then other rooms by id. A seeded shuffle assigns occupants to the first 20
  seats.
- **Arrivals and departures:**
  - An arriving occupant goes to their home room if it has space, otherwise
    to the first room in priority order with space.
  - Which outside occupant arrives, and which present occupant leaves, is
    chosen from the seeded occupancy stream.
  - Everyone else keeps their room.
- **Manual mode** `{mode:"manual", total}`: the total stays present
  regardless of office hours, and there is no redistribution.
- **Scheduled mode** `{mode:"scheduled", target?}`:
  - While the office-hours window is open, `target` occupants are present;
    otherwise 0.
  - Everyone arrives at opening and leaves at closing. There is no staggered
    arrival.
  - `target` defaults to the current `scheduled_target`, which starts at 14.
  - `total` means the manual count only; `target` means the scheduled count
    only. Sending the wrong one gives 400.
- **Redistribution (scheduled mode, open hours only):**
  - **meeting:** 11:00–12:00 local, up to 4 occupants move to the meeting
    room, limited by its free capacity.
  - **lunch:** 13:00–14:00 local, up to 4 occupants move to the pantry.
  - Movers are chosen from the seeded stream and return to their seat (or
    the first free room) at the end. No one is created or lost.
- **Capacity checks:**
  - `total`/`target` outside 0–20 or not an integer gives 400
    `VALIDATION_ERROR`.
  - A value above the run's total room capacity gives 409 `CONFLICT`.
  - Nothing is changed in either case.
- **Reproducibility:** the same seed and the same commands at the same
  simulated times give the same occupancy timeline. The RNG state and all
  assignments are checkpointed, so a restart continues the sequence and
  never rerolls. Device commands never use the occupancy stream; the
  `devices` stream is reserved.
- **Policy versioning:** a **mode** change appends an immutable
  `pol-occupancy` version (`{mode, auto_allocate:true}`), effective at that
  step and pinned to the run. `total`/`target` are runtime state
  (checkpointed); the contract's closed occupancy rules have no field for
  them.

## Operating schedules and vacancy grace (K4)

A device's **automatic** state at step start `t`:

| Policy / control | Automatic on when |
|---|---|
| `always_on` (refrigerator) | always (vacancy ignored) |
| device `control: manual` (projector, microwave) | never; runs only by override |
| `lighting_schedule` (`on_during_hours: true`) | run's current office hours open **and** (room occupied **or** within `vacancy_grace_seconds` of the room becoming vacant) |
| `device_schedule` (AC, fans, workstations, PCs) | referenced office hours ∩ explicit `on_windows` open **and** (occupied **or** within grace; default 300 s) |

- **Precedence:** effective state = override (if set) else automatic. An
  override persists until `{"clear_override": true}`, which returns the
  device to policy at once.
- **Which devices accept overrides:** any device with the `switch` control
  whose policy allows it. The always-on refrigerator (no switch) gets 400.
- **Grace timing:** grace uses **simulated** time. It starts when a room
  goes from occupied to vacant. A room that was never occupied has no grace.
  Closing ends automatic operation even inside grace.
- **Measurements:** `override_seconds`, `vacant_on_seconds` and
  `offschedule_on_seconds` measure what actually happened in each step.
- **Power:** a device that is on draws `nominal_power_w` (the whole group;
  the workstation group is 960 W, never × quantity). A device that is off
  draws `standby_power_w`, or 0.
- **AC:** it follows its operating schedule only. There is no temperature or
  comfort control.
- **Room climate:** a constant synthetic 26 °C / 55 % RH.

## Calendar changes and historical correctness

`POST /api/v1/calendar` (contract fields `working_days`, `open_local`,
`close_local`; optional `overnight` [addition]):

1. **Validation:**
   - `working_days` must be 1–7 unique ISO days.
   - Times must be `HH:MM`.
   - `open_local == close_local` gives 400.
   - `overnight` is derived as `close_local < open_local`. If it is supplied,
     it must match.
2. **New versions,** each with `effective_from_utc` = the next minute
   boundary:
   - a new immutable `pol-office-hours` version;
   - a new version of **every `device_schedule`** whose `office_hours_ref`
     points to that policy, with the reference updated.
   - Lighting policies have no reference; they follow the run's current
     office hours.
3. **Pending until the boundary:** the change is shown in
   `state.pending_changes` [addition] and checkpointed, so it survives
   pause/restart.
4. **At the boundary:** in the same transaction as the completed minute
   (published with the **old** references), the versions are appended to the
   run's `run_policies` with `active_from_utc` = that boundary. Existing
   snapshot rows are never changed. The engine then uses them from that minute
   onward.
5. **History:** earlier intervals keep their references (e.g.
   `pol-open-ac:1`); later ones reference the new versions (e.g.
   `pol-open-ac:2`).

- **Inventory** (`GET /api/v1/inventory`) shows the latest versions
  immediately, including a pending one with a future `effective_from_utc`.
- **Run-scoped activation** (K002). A policy version has two times:
  - `policy_versions.effective_from_utc` — **revision identity**: when the
    immutable revision was created on the global revision history. Immutable,
    never edited.
  - `run_policies.active_from_utc` — **activation within a run**: the instant,
    on this run's timeline, from which the pinned revision governed the run.
    Every revision adopted when a run is created activates at the run's start;
    a revision minted mid-run activates at the minute boundary where it takes
    effect. `device_schedule.office_hours_ref` resolves to the office-hours
    revision pinned in the same run, so a run's references and effective times
    agree with what it actually applied.
- **No run yet:** occupancy, calendar and device commands need a run (409).
  Use reset to create a paused run first.
- **Pre-K002 runs** (pins without a recorded activation) are identified as
  `legacy_unrecorded` and validated against `effective_from_utc` instead; an
  inconsistent one stays invalid for export rather than being rewritten. See
  [K002_POLICY_TIMING_EVIDENCE.md](K002_POLICY_TIMING_EVIDENCE.md).

## Energy, minute persistence, checkpoints (unchanged semantics)

- **Energy:** `energy_kwh = power_w × 10 / 3,600,000` per step, unrounded.
  Minute room/device intervals are written with the checkpoint in one
  transaction.
- **Averages and totals:** averages use actual covered time. Device totals
  sum to room and office totals.
- **Room intervals:** they now carry real occupancy: `occupancy_avg`
  (duration-weighted, may be fractional), `occupancy_max` and
  `occupied_fraction`.
- **Partial minute:** kept by pause, checkpointed by graceful shutdown, and
  published as a `partial` edge interval by reset.
- **Checkpoint format 2:** holds devices (override, cumulative), rooms
  (occupancy, `vacant_since`), occupancy state (seed, RNG state, mode,
  counts, occupants, redistribution), pending changes and the partial
  accumulator.
- **Restart:** it recovers the active run **paused**, with assignments, grace
  timing and pending changes intact. Pre-K3 checkpoints are still readable:
  they get a fresh occupancy model with a seed derived from the run id.
- **Crash loss:** steps after the last checkpoint are lost — under one
  simulated minute.

## API examples (real bodies from the P008 port-4000 demo, temp database)

All responses use the contract envelope `{ "data": …, "meta": { "request_id" } }`
or the error envelope `{ "error": { "code", "message", "field"? } }`. Times
are UTC. 2026-01-01T05:41:20Z is 11:11:20 IST on Thursday.

### Field additions beyond contract 1.0.1

- **Contract minimum for `GET /state`:** `run_id`, `seq`, `sim_time_utc`,
  `rooms[{room_id, occupancy}]`, `devices[{device_id, on, power_w}]`.
- **Top-level additions:** `status`, `speed`, `step_seconds`,
  `office{occupancy, power_w, energy_kwh}`, `partial_interval`.
  - `occupancy{mode, office_count, manual_total, scheduled_target, max_total, capacity_total, seed, occupants[{occupant_id, room_id, home_room_id}], redistribution, policy_ref}`
  - `calendar{policy_ref, working_days, open_local, close_local, overnight, timezone, open_now}`
  - `overrides[{device_id, on}]`
  - `pending_changes[{kind, effective_sim_utc, policy_refs}]`
- **Per-room additions:** `capacity`, `power_w`, `energy_kwh`.
- **Per-device additions:** `room_id`, `control_source` (`policy` or
  `override`), `override`, `policy_ref`, `energy_kwh`.
- **Control responses** add `status` and `speed`.
- **`POST /occupancy`** response: `allocation` is the contract field. It adds
  `mode`, `office_count`, `total` or `target`, `effective_sim_utc`,
  `occupancy_policy_ref` and `seq`. Request additions: `target` (scheduled
  mode) and `seed` (start/reset).
- **`POST /calendar`** response: the contract says "new policy version
  refs". It returns `policy_refs`, `effective_sim_utc`, `applied`,
  `calendar` and `seq`. Request addition: optional `overnight`.
- **`POST /devices/:id`** response: `device_id`, `override` and `seq` are
  contract fields. It adds `sim_time_utc`, `on` and `control_source`.

### Start with a seed

Request:

```http
POST /api/v1/control/start
Content-Type: application/json

{
  "speed": 1000,
  "seed": 2026
}
```

Response `200`:

```json
{
  "data": {
    "run_id": "run-20260924T145921Z-4a3b4365",
    "seq": 1,
    "sim_time_utc": "2025-12-31T18:30:00Z",
    "status": "running",
    "speed": 1000
  },
  "meta": {
    "request_id": "576dbdbd-58c7-4a6f-aa37-f8eea7688218"
  }
}
```

### Occupancy — scheduled

Request:

```http
POST /api/v1/occupancy
Content-Type: application/json

{
  "mode": "scheduled",
  "target": 14
}
```

Response `200`:

```json
{
  "data": {
    "allocation": [
      {
        "room_id": "room-manager-cabin",
        "count": 0
      },
      {
        "room_id": "room-meeting",
        "count": 0
      },
      {
        "room_id": "room-open-workspace",
        "count": 0
      },
      {
        "room_id": "room-pantry",
        "count": 0
      },
      {
        "room_id": "room-reception",
        "count": 0
      }
    ],
    "mode": "scheduled",
    "office_count": 0,
    "target": 14,
    "effective_sim_utc": "2025-12-31T18:30:00Z",
    "occupancy_policy_ref": "pol-occupancy:2",
    "seq": 2
  },
  "meta": {
    "request_id": "0c82d2fe-5250-4696-980f-181a110e8621"
  }
}
```

### Occupancy — manual

Request:

```http
POST /api/v1/occupancy
Content-Type: application/json

{
  "mode": "manual",
  "total": 16
}
```

Response `200`:

```json
{
  "data": {
    "allocation": [
      {
        "room_id": "room-manager-cabin",
        "count": 1
      },
      {
        "room_id": "room-meeting",
        "count": 3
      },
      {
        "room_id": "room-open-workspace",
        "count": 10
      },
      {
        "room_id": "room-pantry",
        "count": 0
      },
      {
        "room_id": "room-reception",
        "count": 2
      }
    ],
    "mode": "manual",
    "office_count": 16,
    "total": 16,
    "effective_sim_utc": "2026-01-01T05:41:20Z",
    "occupancy_policy_ref": "pol-occupancy:3",
    "seq": 4033
  },
  "meta": {
    "request_id": "b8076598-7870-4825-9634-98f3aebc1147"
  }
}
```

### Calendar update (pending until the next minute boundary)

Request:

```http
POST /api/v1/calendar
Content-Type: application/json

{
  "working_days": [
    1,
    2,
    3,
    4,
    5
  ],
  "open_local": "08:30",
  "close_local": "17:30"
}
```

Response `200`:

```json
{
  "data": {
    "policy_refs": [
      "pol-office-hours:2",
      "pol-manager-ac:2",
      "pol-manager-pc:2",
      "pol-meeting-ac:2",
      "pol-meeting-projector:2",
      "pol-open-ac:2",
      "pol-open-fan:2",
      "pol-open-workstations:2",
      "pol-pantry-fan:2",
      "pol-pantry-microwave:2",
      "pol-reception-fan:2",
      "pol-reception-pc:2"
    ],
    "effective_sim_utc": "2026-01-01T05:42:00Z",
    "applied": false,
    "calendar": {
      "working_days": [
        1,
        2,
        3,
        4,
        5
      ],
      "open_local": "08:30",
      "close_local": "17:30",
      "overnight": false
    },
    "seq": 4032
  },
  "meta": {
    "request_id": "a328ef04-c381-44ed-a330-fda31b954b66"
  }
}
```

### Manual light off / on / clear

Request:

```http
POST /api/v1/devices/dev-meeting-light
Content-Type: application/json

{
  "manual_state": "off"
}
```

Response `200`:

```json
{
  "data": {
    "device_id": "dev-meeting-light",
    "override": {
      "active": true,
      "on": false
    },
    "seq": 4034,
    "sim_time_utc": "2026-01-01T05:41:20Z",
    "on": false,
    "control_source": "override"
  },
  "meta": {
    "request_id": "dc993710-59ea-44de-855b-b160215ee45a"
  }
}
```

Request:

```http
POST /api/v1/devices/dev-meeting-light
Content-Type: application/json

{
  "manual_state": "on"
}
```

Response `200`:

```json
{
  "data": {
    "device_id": "dev-meeting-light",
    "override": {
      "active": true,
      "on": true
    },
    "seq": 4035,
    "sim_time_utc": "2026-01-01T05:41:20Z",
    "on": true,
    "control_source": "override"
  },
  "meta": {
    "request_id": "7258516d-6a83-4bb5-9b07-fd647d27f595"
  }
}
```

Request:

```http
POST /api/v1/devices/dev-meeting-light
Content-Type: application/json

{
  "clear_override": true
}
```

Response `200`:

```json
{
  "data": {
    "device_id": "dev-meeting-light",
    "override": null,
    "seq": 4036,
    "sim_time_utc": "2026-01-01T05:41:20Z",
    "on": true,
    "control_source": "policy"
  },
  "meta": {
    "request_id": "f686f8af-e7d2-4194-aa3a-2ad5a3ee82da"
  }
}
```

### Resume at another speed

Request:

```http
POST /api/v1/control/resume
Content-Type: application/json

{
  "speed": 60
}
```

Response `200`:

```json
{
  "data": {
    "run_id": "run-20260924T145921Z-4a3b4365",
    "seq": 4038,
    "sim_time_utc": "2026-01-01T05:41:20Z",
    "status": "running",
    "speed": 60
  },
  "meta": {
    "request_id": "993490e1-d754-4ec6-9197-826ef45ff31f"
  }
}
```

### Errors

Request:

```http
POST /api/v1/occupancy
Content-Type: application/json

{
  "mode": "manual",
  "total": 21
}
```

Response `400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "total must be an integer from 0 to 20",
    "field": "total"
  }
}
```

Request:

```http
POST /api/v1/calendar
Content-Type: application/json

{
  "working_days": [
    1,
    2,
    3,
    4,
    5
  ],
  "open_local": "09:00",
  "close_local": "09:00"
}
```

Response `400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "open_local and close_local must differ (zero/24-hour windows are not supported)",
    "field": "close_local"
  }
}
```

Request:

```http
POST /api/v1/devices/dev-pantry-fridge
Content-Type: application/json

{
  "manual_state": "off"
}
```

Response `400`:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Device \"dev-pantry-fridge\" does not accept manual switching (no switch control, always-on exception, or overrides disallowed by policy)",
    "field": "device_id"
  }
}
```

### GET /api/v1/state — paused (meeting redistribution active, calendar change pending)

Request:

```http
GET /api/v1/state
```

Response `200`:

```json
{
  "data": {
    "status": "paused",
    "speed": 1000,
    "run_id": "run-20260924T145921Z-4a3b4365",
    "seq": 4032,
    "sim_time_utc": "2026-01-01T05:41:20Z",
    "step_seconds": 10,
    "rooms": [
      {
        "room_id": "room-manager-cabin",
        "occupancy": 1,
        "capacity": 2,
        "power_w": 1722,
        "energy_kwh": 3.8142666666667346
      },
      {
        "room_id": "room-meeting",
        "occupancy": 5,
        "capacity": 6,
        "power_w": 1577,
        "energy_kwh": 3.4968777777778413
      },
      {
        "room_id": "room-open-workspace",
        "occupancy": 7,
        "capacity": 12,
        "power_w": 2679,
        "energy_kwh": 5.864033333333383
      },
      {
        "room_id": "room-pantry",
        "occupancy": 0,
        "capacity": 4,
        "power_w": 153,
        "energy_kwh": 1.7119000000000577
      },
      {
        "room_id": "room-reception",
        "occupancy": 1,
        "capacity": 2,
        "power_w": 297,
        "energy_kwh": 0.6951000000000118
      }
    ],
    "devices": [
      {
        "device_id": "dev-manager-ac",
        "room_id": "room-manager-cabin",
        "on": true,
        "power_w": 1500,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-manager-ac:1",
        "energy_kwh": 3.2833333333333914
      },
      {
        "device_id": "dev-manager-light",
        "room_id": "room-manager-cabin",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-manager-light:1",
        "energy_kwh": 0.15760000000000246
      },
      {
        "device_id": "dev-manager-pc",
        "room_id": "room-manager-cabin",
        "on": true,
        "power_w": 150,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-manager-pc:1",
        "energy_kwh": 0.37333333333334057
      },
      {
        "device_id": "dev-meeting-ac",
        "room_id": "room-meeting",
        "on": true,
        "power_w": 1500,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-meeting-ac:1",
        "energy_kwh": 3.2833333333333914
      },
      {
        "device_id": "dev-meeting-light",
        "room_id": "room-meeting",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-meeting-light:1",
        "energy_kwh": 0.15760000000000246
      },
      {
        "device_id": "dev-meeting-projector",
        "room_id": "room-meeting",
        "on": false,
        "power_w": 5,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-meeting-projector:1",
        "energy_kwh": 0.055944444444447114
      },
      {
        "device_id": "dev-open-ac",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 1500,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-ac:1",
        "energy_kwh": 3.2833333333333914
      },
      {
        "device_id": "dev-open-fan",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 75,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-fan:1",
        "energy_kwh": 0.16416666666666876
      },
      {
        "device_id": "dev-open-light-a",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-light-a:1",
        "energy_kwh": 0.15760000000000246
      },
      {
        "device_id": "dev-open-light-b",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-light-b:1",
        "energy_kwh": 0.15760000000000246
      },
      {
        "device_id": "dev-open-workstations",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 960,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-workstations:1",
        "energy_kwh": 2.101333333333318
      },
      {
        "device_id": "dev-pantry-fan",
        "room_id": "room-pantry",
        "on": false,
        "power_w": 0,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-pantry-fan:1",
        "energy_kwh": 0
      },
      {
        "device_id": "dev-pantry-fridge",
        "room_id": "room-pantry",
        "on": true,
        "power_w": 150,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-pantry-fridge:1",
        "energy_kwh": 1.6783333333333923
      },
      {
        "device_id": "dev-pantry-light",
        "room_id": "room-pantry",
        "on": false,
        "power_w": 0,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-pantry-light:1",
        "energy_kwh": 0
      },
      {
        "device_id": "dev-pantry-microwave",
        "room_id": "room-pantry",
        "on": false,
        "power_w": 3,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-pantry-microwave:1",
        "energy_kwh": 0.03356666666666541
      },
      {
        "device_id": "dev-reception-fan",
        "room_id": "room-reception",
        "on": true,
        "power_w": 75,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-reception-fan:1",
        "energy_kwh": 0.16416666666666876
      },
      {
        "device_id": "dev-reception-light",
        "room_id": "room-reception",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-reception-light:1",
        "energy_kwh": 0.15760000000000246
      },
      {
        "device_id": "dev-reception-pc",
        "room_id": "room-reception",
        "on": true,
        "power_w": 150,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-reception-pc:1",
        "energy_kwh": 0.37333333333334057
      }
    ],
    "office": {
      "occupancy": 14,
      "power_w": 6428,
      "energy_kwh": 15.582177777778025
    },
    "occupancy": {
      "mode": "scheduled",
      "office_count": 14,
      "manual_total": 0,
      "scheduled_target": 14,
      "max_total": 20,
      "capacity_total": 26,
      "seed": 2026,
      "occupants": [
        {
          "occupant_id": "occ-01",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-02",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-03",
          "room_id": "room-manager-cabin",
          "home_room_id": "room-manager-cabin"
        },
        {
          "occupant_id": "occ-04",
          "room_id": "room-reception",
          "home_room_id": "room-reception"
        },
        {
          "occupant_id": "occ-05",
          "room_id": null,
          "home_room_id": "room-manager-cabin"
        },
        {
          "occupant_id": "occ-06",
          "room_id": null,
          "home_room_id": "room-meeting"
        },
        {
          "occupant_id": "occ-07",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-08",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-09",
          "room_id": "room-meeting",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-10",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-11",
          "room_id": null,
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-12",
          "room_id": "room-meeting",
          "home_room_id": "room-reception"
        },
        {
          "occupant_id": "occ-13",
          "room_id": null,
          "home_room_id": "room-meeting"
        },
        {
          "occupant_id": "occ-14",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-15",
          "room_id": "room-meeting",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-16",
          "room_id": "room-meeting",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-17",
          "room_id": null,
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-18",
          "room_id": "room-meeting",
          "home_room_id": "room-meeting"
        },
        {
          "occupant_id": "occ-19",
          "room_id": null,
          "home_room_id": "room-meeting"
        },
        {
          "occupant_id": "occ-20",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        }
      ],
      "redistribution": {
        "rule_id": "meeting",
        "room_id": "room-meeting",
        "occupant_ids": [
          "occ-09",
          "occ-12",
          "occ-15",
          "occ-16"
        ]
      },
      "policy_ref": "pol-occupancy:2"
    },
    "calendar": {
      "policy_ref": "pol-office-hours:1",
      "working_days": [
        1,
        2,
        3,
        4,
        5
      ],
      "open_local": "09:00",
      "close_local": "18:00",
      "overnight": false,
      "timezone": "Asia/Kolkata",
      "open_now": true
    },
    "overrides": [],
    "pending_changes": [
      {
        "kind": "calendar",
        "effective_sim_utc": "2026-01-01T05:42:00Z",
        "policy_refs": [
          "pol-office-hours:2",
          "pol-manager-ac:2",
          "pol-manager-pc:2",
          "pol-meeting-ac:2",
          "pol-meeting-projector:2",
          "pol-open-ac:2",
          "pol-open-fan:2",
          "pol-open-workstations:2",
          "pol-pantry-fan:2",
          "pol-pantry-microwave:2",
          "pol-reception-fan:2",
          "pol-reception-pc:2"
        ]
      }
    ],
    "partial_interval": {
      "start_utc": "2026-01-01T05:41:00Z",
      "covered_seconds": 20
    }
  },
  "meta": {
    "request_id": "815a0ad2-bb63-48e0-b407-139fdefaa362"
  }
}
```

### GET /api/v1/state — running (after manual 16, new calendar in force)

Request:

```http
GET /api/v1/state
```

Response `200`:

```json
{
  "data": {
    "status": "running",
    "speed": 60,
    "run_id": "run-20260924T145921Z-4a3b4365",
    "seq": 4050,
    "sim_time_utc": "2026-01-01T05:43:20Z",
    "step_seconds": 10,
    "rooms": [
      {
        "room_id": "room-manager-cabin",
        "occupancy": 1,
        "capacity": 2,
        "power_w": 1722,
        "energy_kwh": 3.8716666666667368
      },
      {
        "room_id": "room-meeting",
        "occupancy": 3,
        "capacity": 6,
        "power_w": 1577,
        "energy_kwh": 3.54944444444451
      },
      {
        "room_id": "room-open-workspace",
        "occupancy": 10,
        "capacity": 12,
        "power_w": 2679,
        "energy_kwh": 5.953333333333387
      },
      {
        "room_id": "room-pantry",
        "occupancy": 0,
        "capacity": 4,
        "power_w": 153,
        "energy_kwh": 1.7170000000000585
      },
      {
        "room_id": "room-reception",
        "occupancy": 2,
        "capacity": 2,
        "power_w": 297,
        "energy_kwh": 0.7050000000000121
      }
    ],
    "devices": [
      {
        "device_id": "dev-manager-ac",
        "room_id": "room-manager-cabin",
        "on": true,
        "power_w": 1500,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-manager-ac:2",
        "energy_kwh": 3.333333333333394
      },
      {
        "device_id": "dev-manager-light",
        "room_id": "room-manager-cabin",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-manager-light:1",
        "energy_kwh": 0.16000000000000253
      },
      {
        "device_id": "dev-manager-pc",
        "room_id": "room-manager-cabin",
        "on": true,
        "power_w": 150,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-manager-pc:2",
        "energy_kwh": 0.3783333333333407
      },
      {
        "device_id": "dev-meeting-ac",
        "room_id": "room-meeting",
        "on": true,
        "power_w": 1500,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-meeting-ac:2",
        "energy_kwh": 3.333333333333394
      },
      {
        "device_id": "dev-meeting-light",
        "room_id": "room-meeting",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-meeting-light:1",
        "energy_kwh": 0.16000000000000253
      },
      {
        "device_id": "dev-meeting-projector",
        "room_id": "room-meeting",
        "on": false,
        "power_w": 5,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-meeting-projector:2",
        "energy_kwh": 0.05611111111111379
      },
      {
        "device_id": "dev-open-ac",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 1500,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-ac:2",
        "energy_kwh": 3.333333333333394
      },
      {
        "device_id": "dev-open-fan",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 75,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-fan:2",
        "energy_kwh": 0.16666666666666882
      },
      {
        "device_id": "dev-open-light-a",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-light-a:1",
        "energy_kwh": 0.16000000000000253
      },
      {
        "device_id": "dev-open-light-b",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-light-b:1",
        "energy_kwh": 0.16000000000000253
      },
      {
        "device_id": "dev-open-workstations",
        "room_id": "room-open-workspace",
        "on": true,
        "power_w": 960,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-open-workstations:2",
        "energy_kwh": 2.13333333333332
      },
      {
        "device_id": "dev-pantry-fan",
        "room_id": "room-pantry",
        "on": false,
        "power_w": 0,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-pantry-fan:2",
        "energy_kwh": 0
      },
      {
        "device_id": "dev-pantry-fridge",
        "room_id": "room-pantry",
        "on": true,
        "power_w": 150,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-pantry-fridge:1",
        "energy_kwh": 1.683333333333393
      },
      {
        "device_id": "dev-pantry-light",
        "room_id": "room-pantry",
        "on": false,
        "power_w": 0,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-pantry-light:1",
        "energy_kwh": 0
      },
      {
        "device_id": "dev-pantry-microwave",
        "room_id": "room-pantry",
        "on": false,
        "power_w": 3,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-pantry-microwave:2",
        "energy_kwh": 0.0336666666666654
      },
      {
        "device_id": "dev-reception-fan",
        "room_id": "room-reception",
        "on": true,
        "power_w": 75,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-reception-fan:2",
        "energy_kwh": 0.16666666666666882
      },
      {
        "device_id": "dev-reception-light",
        "room_id": "room-reception",
        "on": true,
        "power_w": 72,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-reception-light:1",
        "energy_kwh": 0.16000000000000253
      },
      {
        "device_id": "dev-reception-pc",
        "room_id": "room-reception",
        "on": true,
        "power_w": 150,
        "control_source": "policy",
        "override": null,
        "policy_ref": "pol-reception-pc:2",
        "energy_kwh": 0.3783333333333407
      }
    ],
    "office": {
      "occupancy": 16,
      "power_w": 6428,
      "energy_kwh": 15.796444444444706
    },
    "occupancy": {
      "mode": "manual",
      "office_count": 16,
      "manual_total": 16,
      "scheduled_target": 14,
      "max_total": 20,
      "capacity_total": 26,
      "seed": 2026,
      "occupants": [
        {
          "occupant_id": "occ-01",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-02",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-03",
          "room_id": "room-manager-cabin",
          "home_room_id": "room-manager-cabin"
        },
        {
          "occupant_id": "occ-04",
          "room_id": "room-reception",
          "home_room_id": "room-reception"
        },
        {
          "occupant_id": "occ-05",
          "room_id": null,
          "home_room_id": "room-manager-cabin"
        },
        {
          "occupant_id": "occ-06",
          "room_id": "room-meeting",
          "home_room_id": "room-meeting"
        },
        {
          "occupant_id": "occ-07",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-08",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-09",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-10",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-11",
          "room_id": null,
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-12",
          "room_id": "room-reception",
          "home_room_id": "room-reception"
        },
        {
          "occupant_id": "occ-13",
          "room_id": "room-meeting",
          "home_room_id": "room-meeting"
        },
        {
          "occupant_id": "occ-14",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-15",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-16",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-17",
          "room_id": null,
          "home_room_id": "room-open-workspace"
        },
        {
          "occupant_id": "occ-18",
          "room_id": "room-meeting",
          "home_room_id": "room-meeting"
        },
        {
          "occupant_id": "occ-19",
          "room_id": null,
          "home_room_id": "room-meeting"
        },
        {
          "occupant_id": "occ-20",
          "room_id": "room-open-workspace",
          "home_room_id": "room-open-workspace"
        }
      ],
      "redistribution": null,
      "policy_ref": "pol-occupancy:3"
    },
    "calendar": {
      "policy_ref": "pol-office-hours:2",
      "working_days": [
        1,
        2,
        3,
        4,
        5
      ],
      "open_local": "08:30",
      "close_local": "17:30",
      "overnight": false,
      "timezone": "Asia/Kolkata",
      "open_now": true
    },
    "overrides": [],
    "pending_changes": [],
    "partial_interval": {
      "start_utc": "2026-01-01T05:43:00Z",
      "covered_seconds": 20
    }
  },
  "meta": {
    "request_id": "533ab816-a676-41c9-bc3a-5b2e25a429df"
  }
}
```

## Remaining work (later layers)

- Comfort/temperature-based AC control and thermal behaviour.
- Staggered arrivals or role-based movement (not planned for MVP1).
- Configurable start dates.
- Socket.IO sequencing and replay.
- Batch month generation.
- CSV/JSON export.
- Fault controls.
