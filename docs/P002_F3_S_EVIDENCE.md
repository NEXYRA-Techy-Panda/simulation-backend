# P002_F3_S_EVIDENCE — simulator SQLite foundation and inventory

Assignment P002, layer F3-S. Agent B (Claude Code); owner Mohan;
2026-09-24. Scope: `simulation-backend` only. Implementation is **completed**
where the checks below pass; review is **pending**. The commit hash is
reported in the P002 return report after the push.

## Starting state

- No `AGENTS.md`. `main` was at `1418f52` (F2-B, accepted based on supplied
  evidence), equal to `origin/main`, with a clean tree.
- Contract 1.0.1 is authoritative. The prose "1.0.0" in CONTRACT.md §1 is a
  known typo and was not edited. `contracts/v1` and `scripts/verify-contract.mjs`
  are unchanged (the verifier still gives 75/75, including manifest hashes).

## Driver: built-in `node:sqlite` (Node 24.21.0, bundled SQLite 3.53.4)

- **Existing dependencies:** none were SQLite-related (express, cors, ajv +
  dev tooling). No new npm dependency was added; `package-lock.json` is
  unchanged by P002.
- **Why not better-sqlite3 13.0.3:** it needs a native addon fetched by an
  install script. npm 11.19 blocks unapproved install scripts, and approving
  one is a security decision. A new unsigned `.node` binary is also exactly
  what Windows Smart App Control blocked for pandas in F2-B. `node:sqlite`
  ships inside Node, so it behaves the same on Windows and on a Linux VPS
  running Node 24.
- **Caveat:** `node:sqlite` is not yet documented as Stable in Node 24.
  Node 24.21.0 prints no experimental warning. Re-check on Node upgrades.
  The driver is isolated in `src/db/connection.ts`.

## Connection factory (`src/db/connection.ts`)

- `openDatabase(path, { busyTimeoutMs })` does the following on every
  connection:
  - `enableForeignKeyConstraints: true` plus `PRAGMA foreign_keys = ON`, then
    **verifies** the result is 1.
  - `PRAGMA busy_timeout` (default 5000 ms).
  - For a file, `journal_mode = WAL` (verified) and `synchronous = NORMAL`.
  - It creates the parent directory and never deletes anything.
- `closeDatabase` is idempotent (`PRAGMA optimize`, then close).
- `transaction()` uses `BEGIN IMMEDIATE`, with rollback on error.

## Migrations (`src/db/migrate.ts`, `src/db/migrations/`)

- Versioned, ordered and forward-only. History is kept in
  `schema_migrations(version, name, checksum, applied_utc)`.
- All pending migrations run in one `BEGIN IMMEDIATE` transaction, followed by
  `PRAGMA foreign_key_check`.
- Idempotent: applied versions are skipped.
- The runner refuses to run, and changes nothing, if an applied migration's
  SQL changed (sha256 checksum, CRLF/LF-insensitive) or if the database holds
  a version this build doesn't know.
- Migration 001 `initial_inventory_runs_readings` is frozen literal SQL. Every
  table is `STRICT`.

| Table | Purpose / key constraints |
|---|---|
| `buildings` | `nexyra-demo-office`; timezone CHECK = Asia/Kolkata |
| `rooms` | contract id CHECK (1–128, `[A-Za-z0-9_-]`); capacity 0–500; FK building |
| `devices` | FK room; device_type enum; quantity 1–1000; power 0–100000 W; pf 0.1–1; always_on 0/1; control enum; controls JSON array |
| `policies` | identity + kind + **owner** (exactly one of building/room/device, each FK); generated `applies_to` (`device:<id>` etc.); immutable (trigger) |
| `policy_versions` | PK (policy_id, version); rules JSON object; immutable (no UPDATE/DELETE); contiguous versions (max+1); device_schedule `office_hours_ref` must name an existing office_hours version (trigger) |
| `current_policy_versions` (view) | latest version per policy |
| `simulation_runs` | run identity + immutable `config` JSON + building/timezone copy; no UPDATE/DELETE |
| `run_rooms`, `run_devices` | per-run **copies** of the inventory at run creation; immutable |
| `run_policies` | exact (policy_id, version) pinned per run; FK to policy_versions; immutable (a mid-run change adds a row) |
| `room_intervals` | PK (run_id, room_id, interval_start_utc); FK (run_id, room_id) → run_rooms; UTC pattern + real-date CHECKs; end > start; fraction 0–1; max ≥ avg; contract ranges |
| `device_intervals` | PK (run_id, device_id, interval_start_utc); FK (run_id, device_id, room_id) → run_devices; FK (run_id, policy_id, policy_version) → run_policies; generated `policy_ref`; max_power ≥ avg_power; durations 0..interval_seconds; contract ranges |
| `schema_migrations` | migration history |

**No fault-label columns exist.** A test introspects every table and view
against the contract's forbidden list.

**Historical stability:** `createRun()` (`src/db/runs.ts`) atomically copies
the building's current rooms and devices and pins the current policy versions.
Later edits to devices, rooms or schedules (which add new versions) can't
change a run's snapshot, and snapshots can't be updated or deleted.

**Policy validation:** `addPolicyVersion()` validates `rules` with Ajv 8.20.0
against the kind-specific `$defs` of the read-only
`contracts/v1/dataset.schema.json` (closed rule sets, so unknown fields and
`fault_active` are rejected). The database adds json_valid/object CHECKs plus
the triggers above.

## Seed (`src/db/seed/`) and its assumptions

- **Contents:** 1 building, the 5 rooms and 18 devices with the stable IDs
  from CONTRACT.md §2.1, and 20 policies at version 1:
  - `pol-office-hours` (building): Mon–Fri `[1..5]`, 09:00–18:00,
    `overnight: false`.
  - `pol-occupancy` (building): `mode: manual`, `auto_allocate: true`
    (assumption).
  - 6 `lighting_schedule` (one per lighting device): `on_during_hours: true`,
    `vacancy_grace_seconds: 300`.
  - 1 `always_on` (refrigerator): `always_on_exception: true`.
  - 11 `device_schedule` (ACs, fans, workstations, PCs, projector, microwave):
    `office_hours_ref: "pol-office-hours:1"`, `on_windows: []`, grace 300,
    `allow_manual_override: true`.
- **Powers** are the contract §2.2 editable demo assumptions: lighting 72 W
  pf 0.9; workstation group 8 × 120 W = **960 W** pf 0.9; AC 1500 W pf 0.95;
  fan 75 W pf 0.8; projector 300/5 W pf 0.9; refrigerator 150 W pf 1.0
  (always_on); microwave 1200/3 W pf 1.0; computers 150/5 W pf 0.9.
- **Group semantics:** `nominal_power_w` / `standby_power_w` are the rating of
  the whole device or group. `quantity` is the member count and is
  informational only. Per-member power = nominal ÷ quantity, and nominal power
  is never multiplied by quantity again.
- **Control:** projector and microwave are `manual`; the refrigerator is
  `always_on` with `controls: []`; everything else is `scheduled` with
  `controls: ["switch"]`.
- **Chosen values:** room_type slugs (`open_workspace`, `meeting_room`,
  `pantry`, `reception`, `manager_cabin`) and the building name "NEXYRA demo
  office" were chosen here.
- **Effective date:** default policies take effect from
  `2000-01-01T00:00:00Z`, so they apply to any simulated date.
- **What the seed doesn't create:** runs, readings or history.
- **Behaviour:** one transaction; inserts only missing rows (`ON CONFLICT DO
  NOTHING`; version 1 only when a policy has no versions); never updates or
  deletes. It refuses to run on an unmigrated database. Re-running an explicit
  seed restores a deleted seed row. No reset command exists; a destructive
  reset would have to be a separate, explicit future operation.

## Startup behaviour and commands

- **On start**, the server (`npm run dev` / `npm start`) opens
  `DATABASE_PATH`, applies pending forward-only migrations, and does **not**
  seed. A migration failure prevents startup. It never deletes data.
- **Clean setup:** `npm ci`, then `npm run db:setup` (migrate + seed), then
  `npm run dev`.
- **Separately:** `npm run db:migrate`, `npm run db:seed`. After
  `npm run build`, the compiled equivalents are `node dist/cli/migrate.js`
  and `node dist/cli/seed.js`.
- **Environment variables:** `DATABASE_PATH` (default
  `data/simulation.sqlite`, relative to the working directory, i.e. the repo
  root), `SQLITE_BUSY_TIMEOUT_MS` (5000), plus the F2-B variables `PORT`,
  `HOST`, `FRONTEND_ORIGIN`, `JSON_BODY_LIMIT`, `SHUTDOWN_TIMEOUT_MS`.
- **Ignored files:** `data/` and `.env*` (except `.env.example`) were already
  ignored. P002 adds the `*.sqlite-wal`/`-shm`, `*.sqlite3-wal`/`-shm` and
  `*.db-wal`/`-shm` patterns.
- The user's default `data/` database was **not** created or touched by any
  check.

## Checks (2026-09-24)

| Command | Result |
|---|---|
| `npm run verify:contract` | 75 passed, 0 failed |
| `npm run validate:schema` | 24 passed, 0 failed (Ajv 8.20.0, 2020-12 strict) |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm test` | **22 passed, 0 failed** |
| `npm run build` | exit 0 |

The tests use `:memory:` databases or files in test-owned
`os.tmpdir()/nexyra-sim-test-*` directories, removed afterwards (0 left
behind). They cover:

- **Connection:** foreign_keys = 1, busy_timeout, journal_mode = wal; close is
  idempotent.
- **Migrations:** a fresh migration applies [1]; a repeat applies []; a
  reopen applies []; all 12 tables exist; the history row and checksum are
  correct; an edited migration is refused with the history unchanged;
  line-ending-insensitive checksum; no fault-label columns.
- **Seed:**
  - The first seed inserts 5 rooms, 18 devices and 20 policies/versions; the
    database has 0 runs and 0 readings.
  - After edits (AC 1500→1400 W, workspace capacity 12→10, office hours v2)
    and a close/reopen, re-seeding inserts 0 and keeps the counts (5/18/20,
    21 versions) and the edited values.
  - Seeding an unmigrated database is refused.
- **Invalid references fail:**
  - a device in an unknown room;
  - deleting a room that has devices;
  - an unknown policy;
  - `office_hours_ref` pointing to `pol-office-hours:9`;
  - a room interval for an unknown run or room;
  - a device interval for an unknown device, the wrong room, or a policy
    version not pinned by the run.
- **Rules:** extra fields, `fault_active` and missing required rules are
  rejected (contract `$defs`). Policy-version UPDATE, DELETE and
  non-contiguous versions are rejected.
- **Duplicate identities:** repeated room and device interval keys fail with
  UNIQUE errors. `on_fraction` 1.5, max < avg, end = start and month 13 fail
  their CHECKs. `policy_ref` is generated as `pol-meeting-light:1`.
- **Historical stability:** after editing the current light (999 W,
  renamed), the room (capacity 1) and adding lighting policy v2, run-1 still
  holds 72 W, "Lighting group", capacity 6 and policy v1. run-2 pins v2.
  UPDATE/DELETE on run tables, runs, config and policy owners are rejected; a
  duplicate run_id is rejected.
- **Persistence:** after close and reopen, the run, config, interval and
  device edit are all present. No `-wal` file remains after a clean close.
- **Inventory API (in-process HTTP):** 5/18/20 records, each validated
  against the contract item schemas; workstation 8 / 960 W; fridge
  always_on; the API reflects a database edit (not a static fixture). The
  health/error/CORS/config tests still pass.
- **Graceful shutdown (real child process):** described in the section below.

## CLI sequence (scratch DB, not `data/`)

- `db:migrate` → "applied migrations: 1", schema v1 (exit 0).
- `db:migrate` again → "no pending migrations" (exit 0).
- `db:seed` → buildings 1, rooms 5, devices 18, policies 20, policy_versions
  20 inserted (exit 0).
- `db:seed` again → all 0 inserted / "already present"; totals 5/18/20/20
  (exit 0).

## Live verification (compiled build, real port 4000)

Command: `node dist/server.js` (PID 1344) with `PORT=4000`, `HOST=127.0.0.1`
and a scratch `DATABASE_PATH`, seeded by the CLI run above:

```text
GET http://localhost:4000/api/v1/health -> 200 (ACAO http://localhost:3000)
{"data":{"status":"not_initialized","run_id":null,"sim_time_utc":null,"contract_version":"1.0.1"},"meta":{"request_id":"4bf86f4c-6d17-4983-9d6c-e59e124cf065"}}
GET http://localhost:4000/api/v1/inventory -> 200; 9574-byte body
  rooms 5: room-manager-cabin(2), room-meeting(6), room-open-workspace(12), room-pantry(4), room-reception(2)
  devices 18; e.g. {"device_id":"dev-open-workstations",...,"quantity":8,"nominal_power_w":960,...}
               {"device_id":"dev-pantry-fridge",...,"always_on":true,"control":"always_on","controls":[]}
  policies 20: device_schedule 11, lighting_schedule 6, office_hours 1, occupancy 1, always_on 1
GET http://localhost:4000/api/v1/nope -> 404 {"error":{"code":"NOT_FOUND","message":"No route for GET /api/v1/nope"}}
server log: "database …live.sqlite: schema v1" / "listening on http://127.0.0.1:4000"
shutdown message → "shutdown message received; closing server" → "database closed; exiting" → exit code 0
```

After the run, port 4000 was free and only `live.sqlite` remained (the WAL was
checkpointed and removed). **No process is left running.**

## Graceful shutdown: result and limitation

- **Verified:** the graceful path (`server.close()` → `closeDatabase()` →
  exit 0) through the supported IPC mechanism. When the server has an IPC
  channel (process managers, tests), a `"shutdown"` message triggers the same
  `shutdown()` function as SIGINT/SIGTERM. This was verified twice: in
  `test/shutdown.test.ts` (tsx source) and live on port 4000 (compiled
  build).
- **Not exercised:** OS signal delivery itself. On Windows, Ctrl+C in an
  interactive console raises SIGINT, but this agent has no console to press
  it in. `process.kill` / `Stop-Process` on Windows terminate without
  running handlers. SIGTERM on the Linux VPS should be verified at
  deployment.

## Ambiguities and limitations (contract not modified)

1. The contract doesn't define what `on_windows: []` means for a `scheduled`
   device (follow office hours, or no automatic on-time). The seed uses the
   schema default `[]`, and the device's `control` field distinguishes
   manual from scheduled. The engine layer must decide.
2. The contract doesn't enumerate `room_type` values, the building name, the
   `controls` vocabulary or the default occupancy mode. The values above are
   assumptions.
3. `GET /api/v1/inventory` returns the **latest** version of each policy.
   Full version history is kept in the database but not exposed yet.
4. The database doesn't enforce `interval_seconds = end − start`, because
   partial-edge semantics are unspecified. It enforces end > start and
   durations ≤ interval_seconds.
5. Current inventory rows can still be edited (by design). Readings tables
   aren't append-only yet. Policies and runs, once referenced, can't be
   deleted (FK/triggers), so there is no reset. A destructive reset remains a
   future explicit operation.
6. The `node:sqlite` stability caveat above.

## Deliberately not implemented

Simulation clock, occupancy engine, device commands, Socket.IO, history
generation, export, fault injection, run creation over HTTP, and any seeded
runs or readings. `auditor-backend`, `energy-ml-service`, the frontends,
parent files and the contract were not touched.

## Next-task dependencies

- The engine/F4+ layers build on `createRun()`, snapshot tables and the
  interval tables.
- The on_windows semantics need a decision.
- CSV/JSON export should read from the run snapshots plus the intervals.
- Frontend (OpenCode/Agent A) can consume `GET /api/v1/inventory` once
  `npm run db:setup` has been run on the machine.
