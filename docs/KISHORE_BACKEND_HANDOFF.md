# Simulation backend — handoff to Kishore Kumar

Prepared 2026-09-24 by Agent B (Claude Code) for Mohan (assignment P010).
Documentation only: no simulator source, migration or contract was changed
in P010.

## K003 update (2026-09-25, Kishore | K-A — OpenCode)

K002 remains implemented/review pending. K003 now implements the historical
run catalog and strict JSON/standalone-CSV export with a consistent read-only
WAL snapshot, K002 run activation, all six aggregation resolutions, honest
partial/gap handling, bounded streaming and format-independent export identity.
`npm test` is 77/77; contract/schema are 75/75 and 24/24. Pinned auditor pure
import validation accepted both formats, while full auditor DB acceptance is
explicitly unclaimed due the local `better-sqlite3` build tool limitation. See
[K003_EXPORT_EVIDENCE.md](K003_EXPORT_EVIDENCE.md). Historical statements below
that say export is unimplemented are superseded by this addendum.

> **Status of the foundation handoff (F6):** **not complete.** This document
> covers the simulator **backend**. Frontend completion (OpenCode) and
> end-to-end export → auditor import integration are separate, still-open
> work.
>
> **Historical review record:** P008 occupancy/schedule behaviour was accepted
> based on supplied evidence while the run-policy timing defect was still open.
> K002 resolved that defect; current status is in the K003 addendum above.

## 0. Before you implement anything

Every new task starts with this protocol (see
[AGENT_START_PROMPT.md](AGENT_START_PROMPT.md)):

1. Read `AGENTS.md` if one exists (none exists today), then
   [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md),
   [WORKSPACE_MAP.md](WORKSPACE_MAP.md), [HANDOFF.md](HANDOFF.md),
   [ACTIVE_TASK.md](ACTIVE_TASK.md) and the recent
   [PROGRESS_LOG.md](PROGRESS_LOG.md) entries.
2. Read [SIMULATION_ENGINE.md](SIMULATION_ENGINE.md), which has the design,
   decisions and **complete API examples**, and the contract
   (`contracts/v1/CONTRACT.md`, `API.md`). The contract is a shared mirror:
   never edit it on its own.
3. Inspect `git status`, `git log` and the source; preserve any existing
   changes.
4. Write ACTIVE_TASK.md for the new assignment, checkpoint during the work,
   and implement **only** the assigned task.

## 1. Exact commit references

| Layer | Commit | Review |
|---|---|---|
| F1-R2 contract 1.0.1 | `f64ee215d4b3fc5021eadf8ec5eb7aeef290a024` | accepted (supplied evidence) |
| F2-B scaffold | `1418f5214999b984b09f6ef470879520451ae683` | accepted (supplied evidence); graceful shutdown later verified via IPC |
| P002 / F3-S SQLite + inventory | `b0f569ac16503112b25e4a9845d4c861f29a2165` | accepted (supplied evidence) |
| P004 / K1 clock + energy loop | `93da205aa0edbc6cc308c9cce7c1af19216f10df` | accepted (supplied evidence) |
| P008 / K3–K4 occupancy + schedules | `6d2630973139c5612d4e8c78cd928bc994ae2ca0` | P008 behaviour accepted; its then-open timing defect was resolved by K002. |
| P010 handoff docs (this file) | reported in the P010 return report after push | pending |

- Remote: `https://github.com/NEXYRA-Techy-Panda/simulation-backend.git`,
  branch `main`.
- The latest **source** commit is `6d26309`; P010 changed documentation
  only.

## 2. Setup, migrations, seed, tests and startup

- **Requirements:** Node ≥ 24 (verified on 24.21.0), npm (11.19.0). The
  SQLite driver is Node's built-in `node:sqlite` (SQLite 3.53.4); there is no
  native addon.

```sh
npm ci                     # exact dependencies from package-lock.json
npm run db:setup           # = db:migrate + db:seed (idempotent, non-destructive)
npm run dev                # tsx watch src/server.ts → http://localhost:19001
```

| Command | Purpose |
|---|---|
| `npm run db:migrate` | forward-only, checksum-guarded migrations (001 schema, 002 engine checkpoints, 003 run-policy activation) |
| `npm run db:seed` | inserts **missing** demo inventory only (5 rooms, 18 devices, 20 policies); never overwrites edits |
| `npm run build` / `npm start` | `tsc` → `dist/`; `node dist/server.js` |
| `node dist/cli/migrate.js` / `node dist/cli/seed.js` | compiled equivalents (VPS) |
| `npm test` | 77 tests (node:test via tsx; temp/in-memory databases only) |
| `npm run typecheck` / `npm run lint` | `tsc --noEmit` / ESLint |
| `npm run verify:contract` / `npm run validate:schema` | contract semantic checks (75) / Ajv JSON Schema 2020-12 checks (24) |

- **Startup** applies pending migrations and recovers the most recent
  active run as **paused**. It never seeds, resets or deletes data.
- **Configuration** (`.env.example`): the HTTP port is fixed in source at
  `19001` and `PORT` is ignored; `HOST` (127.0.0.1),
  `FRONTEND_ORIGIN` (http://localhost:3000), `JSON_BODY_LIMIT` (100kb),
  `SHUTDOWN_TIMEOUT_MS` (10000), `DATABASE_PATH` (`data/simulation.sqlite`,
  git-ignored), `SQLITE_BUSY_TIMEOUT_MS` (5000).
- **Graceful shutdown:** Ctrl+C / SIGTERM, or an IPC `"shutdown"` message.
  It stops the clock, checkpoints, closes HTTP and then the database.
  Linux SIGTERM delivery has not been exercised yet; verify it on the VPS.
- **Never** run destructive experiments against `data/simulation.sqlite`.
  Point `DATABASE_PATH` at a temporary file instead.

## 3. Current routes (full paths; contract envelope)

| Route | Behaviour |
|---|---|
| `GET /api/v1/health` | `not_initialized` (null run/time) until a run exists, then `ok` with the real run id and processed time |
| `GET /api/v1/inventory` | database-backed rooms, devices and the latest policy versions |
| `GET /api/v1/runs?page=1&page_size=50` | historical run catalog with committed persisted coverage and exportability; never uses live sim time as coverage |
| `GET /api/v1/export?run_id=...&format=json\|csv&from=...&to=...&interval_seconds=...` | raw contract-1.0.1 JSON or standalone CSV from one read-only WAL snapshot |
| `POST /api/v1/export` | same closed export fields as JSON for additive API parity |
| `GET /api/v1/state` | authoritative snapshot: lifecycle, seq, sim time, rooms, devices, office totals, occupancy (stable occupants), calendar, overrides, pending changes, partial interval |
| `POST /api/v1/control/start` `{speed?, seed?}` | new run (seed only here or on reset) or resume |
| `POST /api/v1/control/pause` / `resume {speed?}` / `reset {seed?}` / `speed {speed}` | lifecycle; speeds 1/2/10/60/100/1000 |
| `POST /api/v1/occupancy` | `{"mode":"manual","total":0..20}` or `{"mode":"scheduled","target":0..20}` |
| `POST /api/v1/calendar` | `{"working_days":[1..7],"open_local":"HH:MM","close_local":"HH:MM","overnight"?}` → new policy versions effective at the next minute boundary |
| `POST /api/v1/devices/:id` | `{"manual_state":"on"|"off"}` or `{"clear_override":true}` (switch-capable devices) |

**Authoritative API examples:** [SIMULATION_ENGINE.md → API
examples](SIMULATION_ENGINE.md#api-examples-real-bodies-from-the-p008-port-4000-demo-temp-database).
It has 13 complete, real request/response bodies, including paused and
running `GET /state`, and lists every field that goes beyond contract 1.0.1.
Treat those examples as the reference for frontend work.

## 4. Clock, interval storage and recovery

- **Clock:**
  - Fixed 10-simulated-second steps. The deterministic `advanceSteps()` in
    `src/engine/engine.ts` is separate from the monotonic wall-clock
    `WallClockScheduler`, which processes batches of at most 120 steps and
    yields in between.
  - No step is skipped, and only processed time is exposed.
  - New runs start at 2026-01-01 00:00 Asia/Kolkata
    (`2025-12-31T18:30:00Z`).
- **Energy:** `power_w × 10 / 3,600,000` per step, accumulated unrounded.
  - A device that is on draws `nominal_power_w`, which is the **whole
    group** (the workstation group is 960 W; never × quantity).
  - A device that is off draws `standby_power_w`, or 0.
- **Storage:** each completed minute writes room + device interval rows and
  the engine checkpoint **in one transaction**.
  - Averages use the actual covered seconds.
  - Device totals reconcile to room and office totals.
  - Intervals carry `policy_ref` (the version applied).
- **Partial minute:** pause keeps it; graceful shutdown checkpoints it; reset
  publishes it as an edge interval with `partial = 1` and its real duration.
- **Immutability:**
  - Runs pin a frozen copy of the inventory (`run_rooms`, `run_devices`) and
    the policy versions (`run_policies`).
  - Runs, snapshots and policy versions cannot be updated or deleted
    (triggers).
  - Reset ends the old run (the `ended` checkpoint is final) and creates a
    new run.
- **Recovery:**
  - The active run is restored **paused** from `engine_checkpoints` (format
    2): processed time, seq, speed, overrides, cumulative counters,
    occupancy state (seed, RNG state, assignments, redistribution), room
    vacancy timestamps, pending changes and the partial accumulator.
  - No time passes during downtime.
  - A crash without graceful shutdown loses at most the steps since the last
    checkpoint (under one simulated minute).

## 5. Occupancy and schedule behaviour

- **Occupants:** 20 stable occupants (`occ-01`…`occ-20`), each with a seeded
  home seat.
- **Allocation:** automatic and capacity-respecting; it keeps existing
  assignments. The office count equals the sum of room counts.
- **Modes:**
  - manual (`total`, persists outside hours);
  - scheduled (`target`, default 14; everyone arrives at opening and leaves
    at closing).
- **Redistribution:** meeting 11:00–12:00 (up to 4 people to the meeting
  room) and lunch 13:00–14:00 (up to 4 to the pantry), scheduled mode only.
- **Randomness:** a seeded, checkpointed occupancy RNG stream, independent of
  device control.
- **Invalid counts:** 400 outside 0–20; 409 above room capacity.
- **Device control:**
  - Lights and scheduled devices run while their schedule permits **and**
    the room is occupied or within the vacancy grace (simulated time).
  - **Closing ends automatic operation**, even during grace.
  - Manual-control devices (projector, microwave) run only by override.
  - The refrigerator is always on.
  - Overrides persist until cleared; clearing returns to the current policy.
  - AC follows its schedule only; there is no comfort control.
- **Calendar changes:**
  - They create immutable office-hours versions plus versions of every
    referencing `device_schedule`, effective at the next minute boundary.
  - They stay pending (checkpointed) until then.
  - At the boundary they are pinned to the run together with the completed
    minute. Past intervals keep their references.
- **Overnight windows** belong to their opening day. `open == close` is
  rejected.

## 6. RESOLVED (K002) — run-relative policy effective times

> **Was:** a new run could start before the `effective_from_utc` timestamps of
> policy versions inherited from an earlier run, while applying those versions
> immediately.

**Resolved in K002** (Agent K — Kishore's coding agent) with run-scoped
activation. This section keeps the mechanism for reference and records the
resolution. Evidence:
[K002_POLICY_TIMING_EVIDENCE.md](K002_POLICY_TIMING_EVIDENCE.md).

### Mechanism

1. Run A changes the calendar at simulated time T_A, for example
   `2026-01-01T04:31:00Z`. `setCalendar()` creates `pol-office-hours:2`, and
   new `device_schedule` versions, with `effective_from_utc = T_A`.
2. `reset` → `createNewRun()` → `createRun()` (`src/db/runs.ts`) pins the
   **current** (latest) policy versions into the new run B.
3. Run B starts at `INITIAL_SIM_TIME_UTC` (`2025-12-31T18:30:00Z`), which is
   **before** T_A, but applies v2 immediately. B's intervals then reference a
   version whose `effective_from_utc` is later than the interval itself.
4. An export of run B would therefore claim a policy that was "not yet
   effective" while it was actually being applied. The deterministic
   analysis service (`energy-ml-service`, P010) **rejects** such input with
   400 ("a future policy cannot apply retroactively"). That is correct, and
   it means affected exports cannot be analysed until this is fixed.

### Resolution (K002)

- **Semantics:** run-scoped activation. `run_policies.active_from_utc` records,
  per run, the instant from which a pinned revision governed **that** run —
  the run's start for a revision adopted at creation, the minute boundary for a
  revision minted mid-run. `policy_versions.effective_from_utc` stays the
  immutable **revision identity** (which run's timeline produced it) and is
  never edited. A revision a run inherits keeps its identity while its
  run-scoped activation is its start.
- **History:** prior runs are untouched. Migration 003 only **adds** the column;
  existing pins keep `NULL`, meaning "activation not recorded". Such runs are
  identified as `legacy_unrecorded` and validated against the global revision
  times; an inconsistent one stays **invalid for export** rather than being
  backfilled or rewritten. Migrations 001/002 were not edited.
- **Dependencies:** `device_schedule.office_hours_ref` now resolves to the
  office-hours revision pinned in the same run, so references and effective
  times agree with actual application.
- **Regression test / dataset:** a new run at January 1 after a prior run's
  later-timeline change is asserted to reference only revisions effective at or
  before each interval, with the prior run's history unchanged, and a
  contract-1.0.1-shaped dataset is built **in a test** and schema-validated.
  K003 now uses the same run-scoped mapping in the production exporter; a
  post-calendar reset export regression and pinned-auditor pure validation are
  recorded in `K003_EXPORT_EVIDENCE.md`.

## 7. Known limitations (accepted for now)

- Everyone arrives at opening and leaves at closing. There is no staggered
  arrival or role-based movement, and only the two redistribution rules
  exist.
- The room climate is constant and synthetic (26 °C / 55 % RH). There is no
  thermal or comfort model, the refrigerator draw is constant, and there is
  no voltage/current modelling.
- New runs always start on 2026-01-01; configurable start dates are not
  implemented.
- Occupancy, calendar and device commands need an existing run (409
  otherwise). Clients can `reset` to create a paused run.
- `total`/`target` are runtime state, not policy fields, because the
  contract's occupancy rules are closed.
- A crash can lose under one simulated minute. Linux SIGTERM has not been
  exercised.
- The run-policy timing defect was **resolved** in K002 (§6); it is no longer
  an open correctness issue.

## 8. Remaining simulator work (Kishore)

None of this is implemented:

1. ~~Run-policy timing correction~~ — **done in K002** (§6).
2. **Socket.IO delivery and recovery:** `state.update` keyed by `seq`,
   command acks, replay/snapshot fallback (contract API.md).
3. **Environment and comfort controls:** room temperature/humidity commands
   (`POST /api/v1/environment`) and AC comfort behaviour.
4. **Batch history generation:** `/api/v1/history/jobs` for month/custom-range
   generation. K003 historical export of already committed runs is complete.
5. **Fault scenarios**, which must never leak into exports.
6. **Matched original/improved simulation:** the same occupancy/environment
   timeline, using the independent occupancy RNG stream.
7. **Remaining frontend integration,** together with OpenCode's UI work.

## 9. Related services

- **energy-ml-service** (`36f5832`, P010): `POST /v1/analyze` is a
  deterministic vacant-beyond-grace rule (`method: "rule"`; no model). It
  takes at most 2,000 device and 2,000 room intervals per request, so
  exports must be windowed with preceding context by the auditor.
- **auditor-backend** (Codex): implementing imports. Exports must satisfy the
  contract and the §6 run-scoped activation semantics (implemented in K002);
  pre-K002 runs flagged `legacy_unrecorded` remain unsupported.
