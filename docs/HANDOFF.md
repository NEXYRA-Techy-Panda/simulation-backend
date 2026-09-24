# HANDOFF — simulation-backend

## 0. Continuity and current layer (F0.1, 2026-09-24)

- Current layer: **P010 / F6-S documentation** (backend handoff to Kishore
  Kumar) — documentation completed, review **pending**. P008 occupancy/schedule
  behaviour accepted based on supplied evidence; run-policy timing defect
  remains open. F6 foundation handoff NOT complete (frontend completion and
  export/import integration remain separate). Contract: **1.0.1 defined** (canonical
  `simulation-backend/contracts/v1/`, mirrored to siblings; replaces the
  unaccepted 1.0.0 prototype, no backward compatibility claimed).
- Continuity files: [ACTIVE_TASK.md](ACTIVE_TASK.md) and [PROGRESS_LOG.md](PROGRESS_LOG.md).
- Continuation procedure for a replacement agent: read `AGENTS.md` (absent at
  F0.1 — record if still absent), then `PROJECT_CONTEXT.md`, `WORKSPACE_MAP.md`,
  this `HANDOFF.md`, `ACTIVE_TASK.md`, and recent `PROGRESS_LOG.md` entries;
  inspect `git branch/status/log` and source; reconcile docs with code; resume
  the ACTIVE_TASK next action. Do not restart completed work. See
  [AGENT_START_PROMPT.md](AGENT_START_PROMPT.md) for the full protocol.
- Verified vs planned: **verified** = §2 state below (empty repo on `main`,
  no commits, docs-only untracked files, origins/ports/tooling as measured).
  Everything marked "Not implemented" or "planned" is **not** built. This repo
  has NOT completed application setup — F2 has not run.
- Layer clarifications: **F1 is contract work and does not require Python.**
  Python installation/runtime verification belongs to **F2 for
  energy-ml-service**. Auditor Node work can proceed independently; Python is
  required only for the relevant auditor↔Python integration checks (F4).
  Runtime recommendations from F0 (Node `>=20.9`, Python `3.12`, npm,
  venv+pip) remain **provisional until checked against chosen dependency
  versions and official compatibility documentation during F2**.
- F0 review status: accepted by architecture lead based on supplied evidence;
  local files were not directly inspected by the lead.
- F1 addendum (2026-09-24, completed, review pending): contract v1.0.0 defined;
  THIS repo holds the canonical copy under `contracts/v1/` (mirrored to the
  other four; see `contracts/v1/manifest.json`). `node
  scripts/verify-contract.mjs` → 49 passed, 0 failed in all five repos
  (semantic checks only; formal schema validation is F2). Links:
  [contract](contracts/v1/CONTRACT.md), [schema](contracts/v1/dataset.schema.json),
  [CSV](contracts/v1/CSV_COLUMNS.md), [API](contracts/v1/API.md),
  [evidence](F1_EVIDENCE.md), [active task](ACTIVE_TASK.md),
  [progress](PROGRESS_LOG.md).
- Dated corrections (history preserved in PROGRESS_LOG): Python 3.13.15
  (64-bit, pip 26.2.1) verified at the supplied interpreter path — "Python not
  installed" no longer a current blocker (F1 needs no Python); F0.1
  "read-only sibling" wording corrected — F0.1 explicitly covered all five
  repositories; runtime recommendations stay provisional until F2 dependency
  checks; hosting plan — frontends on Vercel, Node backends + Python service
  on Mohan's VPS (no deployment in F1); from F1 onward completed layer work is
  committed and pushed (F0/F0.1 no-push was historical only).
- F1-R1 addendum (2026-09-24, completed, review pending): pre-acceptance
  corrections, version retained at 1.0.0 (not published). THIS repo holds the
  corrected canonical bundle. (A) CSV is self-contained: first-data-row
  `meta_run` envelope, `meta_policy` removed, 27-column header,
  slice-without-envelope rejected. (B) 12 dp kWh exports, unrounded internal
  accumulation, tolerances 1e-9 per-value / n·1e-9 totals / 1e-9
  triple-relative, in-memory 7 W × 44,640-interval budget check (analytic
  5.208 kWh, budget 2.232e-8). Verifier extended: CSV-alone reconstruction +
  full semantic parity, 4 negative checks. 54/54 in all five repos.
  Repo-local identity configured. History preserved in PROGRESS_LOG.
- F1-R2 addendum (2026-09-24, completed, review pending): version 1.0.1
  (replaces unaccepted 1.0.0 prototype). THIS repo holds the corrected
  canonical bundle: 9dp power precision + fractional checks, V/I average
  semantics, kind-specific closed policy rules, persist-until-cleared
  overrides, concrete Python A/B requests with bounds, full API paths +
  scaffold health states. 75/75 in all five repos; CSV-alone parity unchanged.
  History preserved.
- F2-B addendum (2026-09-24, implementation completed, review **pending**):
  F1-R2 (contract 1.0.1) was accepted by the architecture lead based on
  supplied evidence. Contract 1.0.1 is the baseline, and `contracts/v1` + the
  verifier were left unmodified (verifier 75/75).
  Full evidence: [F2_B_EVIDENCE.md](F2_B_EVIDENCE.md).
  Implemented: Express 5.2.1 + TypeScript 6.0.3 scaffold on Node 24.21.0
  (npm 11.19.0), exact pins + package-lock.json. `src/app.ts` (createApp) is
  separate from `src/server.ts` (listen + SIGINT/SIGTERM graceful shutdown).
  Env config, CORS for one origin, 100kb JSON limit, contract envelopes,
  NOT_FOUND/VALIDATION_ERROR/REQUEST_TOO_LARGE/INTERNAL_ERROR handling. ONLY
  `GET /api/v1/health` → `{"status":"not_initialized","run_id":null,
  "sim_time_utc":null,"contract_version":"1.0.1"}` inside `{data,meta}`.
  Formal schema validation: `npm run validate:schema` (Ajv 8.20.0 Draft
  2020-12, strict) 24/24. typecheck/lint/build exit 0; tests 7/7; live check
  on http://localhost:4000 passed, and the process was stopped.
  Commands: `npm ci`, `npm run dev|build|start|typecheck|lint|test|verify:contract|validate:schema`.
  Env names: PORT (4000), HOST (127.0.0.1), FRONTEND_ORIGIN
  (http://localhost:3000), JSON_BODY_LIMIT (100kb), SHUTDOWN_TIMEOUT_MS (10000).
  Deliberately not implemented: DB/migrations, inventory, simulation state,
  Socket.IO, history/export. Next layer: **F3**, pending its assigned prompt.
- P002 / F3-S addendum (2026-09-24, Agent B — Claude Code, implementation
  completed, review **pending**): F2-B accepted based on supplied evidence.
  Built-in `node:sqlite` (Node 24.21.0, SQLite 3.53.4; no new npm deps).
  Connection factory (verified FK enforcement, busy_timeout, WAL,
  idempotent close); versioned checksum-guarded forward-only migrations
  (`schema_migrations`); migration 001 STRICT tables: buildings, rooms,
  devices, policies (+ owner), immutable contiguous policy_versions, runs with
  immutable config, immutable run_rooms/run_devices/run_policies snapshots,
  room/device interval readings (contract keys, FKs to run snapshots, CHECKs;
  no fault-label columns). Idempotent non-destructive seed: 5 rooms, 18
  devices, 20 policies (nominal power = whole group; workstation 960 W × qty 8
  informational). `GET /api/v1/inventory` DB-backed; health unchanged.
  Startup migrates, never seeds or resets. Commands: `npm run db:setup` |
  `db:migrate` | `db:seed`. Env: DATABASE_PATH (data/simulation.sqlite),
  SQLITE_BUSY_TIMEOUT_MS (5000). Checks: verifier 75/75, schema 24/24,
  typecheck/lint/build 0, tests 22/22; live port-4000 check; graceful
  shutdown verified via IPC "shutdown" (OS-signal delivery not exercised).
  Evidence: [P002_F3_S_EVIDENCE.md](P002_F3_S_EVIDENCE.md). Open: on_windows
  semantics, node:sqlite stability status. Not implemented: clock, occupancy,
  commands, Socket.IO, history, export, fault injection.
- P004 / K1 addendum (2026-09-24, Agent B — Claude Code, implementation
  completed, review **pending**): P002 accepted based on supplied evidence.
  Owner decisions recorded in [SIMULATION_ENGINE.md](SIMULATION_ENGINE.md)
  (empty on_windows follows office hours; manual occupancy; latest policies
  in inventory, versions pinned in history; overrides persist until cleared;
  node:sqlite; contract unchanged). Engine: deterministic advanceSteps()
  (10 s steps) + monotonic wall-clock scheduler (bounded batches, yields,
  no skipped steps, single loop), speeds 1/2/10/60/100/1000, start
  2026-01-01 00:00 IST. Routes: state, control start/pause/resume/reset/speed,
  devices/:id (lighting only). Minute room/device intervals + checkpoint in
  one transaction; migration 002 engine_checkpoints. Reset ends old run
  (partial edge interval, partial=1) and creates a new run (seq 0, paused).
  Restart recovers the active run PAUSED; crash may lose < 1 simulated
  minute since the last checkpoint. Temporary manual-demo assumptions:
  occupancy 0, synthetic 26 °C / 55 % RH, controllable loads off, constant
  fridge, clear-override → base state (to be replaced by schedule
  evaluation). Checks: verifier 75/75, schema 24/24, typecheck/lint/build 0,
  tests 39/39, live port-4000 demo on a temp DB.
  Evidence: [P004_K1_EVIDENCE.md](P004_K1_EVIDENCE.md). Next: schedule layer,
  occupancy, Socket.IO, export — pending assignment.
- P008 / K3–K4 addendum (2026-09-24, Agent B — Claude Code, implementation
  completed, review **pending**): P004 accepted based on supplied evidence.
  Occupancy: 20 stable seeded occupants (occ-01..occ-20) with home seats,
  capacity-respecting allocation preserving assignments, manual (total) and
  scheduled (target, default 14) modes, meeting 11–12 / lunch 13–14
  redistribution, seeded checkpointed occupancy RNG independent of devices;
  400 outside 0–20, 409 above capacity. Schedules: lights and scheduled
  devices on while permitted AND occupied or in simulated-time grace;
  closing ends automatic operation; manual-control devices override-only;
  fridge always on; overrides on switch-capable devices clear back to
  policy. Calendar (POST /calendar) creates office-hours + device_schedule
  versions effective at the next minute boundary (pending, checkpointed,
  pinned into run_policies with the completed minute); overnight belongs to
  its opening day; open == close rejected. No new migration (checkpoint
  format 2). Checks: verifier 75/75, schema 24/24, typecheck/lint/build 0,
  tests 56/56, live port-4000 demo (temp DB). Complete API examples for
  OpenCode: [SIMULATION_ENGINE.md](SIMULATION_ENGINE.md). Evidence:
  [P008_K3_K4_EVIDENCE.md](P008_K3_K4_EVIDENCE.md). Next: Socket.IO, export,
  comfort — pending assignment.
- P010 addendum (2026-09-24, Agent B — Claude Code, documentation only,
  review **pending**): [KISHORE_BACKEND_HANDOFF.md](KISHORE_BACKEND_HANDOFF.md)
  written (setup/commands, routes + authoritative examples, clock/storage/
  recovery, occupancy/schedules, limitations, remaining work, commit refs,
  continuity protocol). OPEN DEFECT (required before final historical-export
  acceptance, not an accepted limitation): run-relative policy effective
  times — a new run may start before the effective_from timestamps of policy
  versions inherited from an earlier run while applying them immediately.
  Remaining simulator work (run-policy timing correction, Socket.IO,
  environment/comfort, history + exports, faults, matched original/improved,
  frontend integration) belongs to Kishore Kumar. No source changed.

## 1. Purpose and owner

- **Purpose**: Simulation authority. Node.js + Express + TypeScript + Socket.IO
  + SQLite service owning simulation time, occupancy (up to 20 occupants, auto
  allocation, manual/scheduled modes, working days/hours, redistribution),
  schedules, device states (5 rooms, 18 devices/groups), readings, aggregation
  (10 s step → 1 min permanent), batch history, CSV/JSON export, Socket.IO
  sequencing/replay/snapshot, fault controls, and original/improved scenario
  generation. Frontend renders only what this backend authorises.
- **Foundation owner (F0–F6)**: Mohan.
- **Long-term owner (after foundation handoff)**: Kishore Kumar.
- Mohan establishes the initial foundation before handing implementation to
  Kishore. This document determines which foundation layers are actually
  complete.

## 2. Current verified state (F0, 2026-09-24)

- Local path (Mohan's machine): `K:\NEXYRA\simulation-backend`
  (portable: `../simulation-backend`).
- Remote: `https://github.com/NEXYRA-Techy-Panda/simulation-backend.git`
  (verified via `git remote -v`; fetch OK).
- Branch: `main`. HEAD: **No commits yet** (empty remote; `ls-remote --heads`
  empty).
- Working tree before F0 docs: clean — only `.git/` present.
- Working tree after F0 docs (uncommitted, for review): new untracked
  `docs/PROJECT_CONTEXT.md`, `docs/WORKSPACE_MAP.md`, `docs/HANDOFF.md`
  (this file), `docs/AGENT_START_PROMPT.md`, `README.md`. Not committed/pushed.
- Parent `K:\NEXYRA` is not a Git repository.
- Instructions: no `AGENTS.md` found at parent or in this repo at F0.
- Tooling: Git `2.55.0.windows.5`, Node `v24.21.0`, npm `11.19.0`. Proposed port
  `4000` free at F0.
- Application state: **Not implemented** — no `package.json`, no source, no
  SQLite file, no migrations.

## 3. Completed layers and evidence

- **F0 (in review)**: cloned empty repo; verified origin/branch/HEAD/status;
  fetched; recorded tooling/ports; created shared + per-repo docs. Evidence:
  git/version/netstat outputs in F0 report; untracked docs files.
- **F1–F6**: Not implemented (see §5).

## 4. Pre-existing implementation discovered during inspection

None. Empty repository (only `.git/`). No source, manifests, configs, docs,
or user changes to preserve.

## 5. Planned next layers

- **F1**: shared contract — telemetry schema (W/kW vs kWh, UTC + Asia/Kolkata,
  run semantics, aggregation preservation, fault-label exclusion), REST +
  Socket.IO events, export intervals (1/5/10/15/30/60 min), sequence/snapshot
  semantics. Backend co-owns this with auditor/ML parties.
- **F2**: Express + TypeScript scaffold via npm; health endpoint shell;
  lint/format; Node pin (`.nvmrc`/`engines`).
- **F3**: SQLite file location (private to this backend, e.g. `./data/*.sqlite`
  — finalise in F3), migrations + seeds for runs/rooms/devices/schedules.
- **F4**: Socket.IO time/occupancy/device/command paths + CORS for
  `http://localhost:3000`; snapshot/history fallback.
- **F5**: reference data (rooms/devices/schedules, speeds 1×–1000×, grace
  periods, always-on, overrides, temp/humidity simplified behaviour).
- **F6**: verified end-to-end with simulation-frontend; handoff to Kishore Kumar.

## 6. Prerequisites

- Git, Node `>=20.9` + npm. SQLite driver decided in F2 (e.g. `better-sqlite3`).
- F1 contract before simulation logic.
- No Python dependency for this repo.

## 7. Actual run/check commands, if implemented

No app commands exist. F0 checks (parent, PowerShell 5.1):

```powershell
git -C simulation-backend rev-parse --show-toplevel
git -C simulation-backend remote -v
git -C simulation-backend branch --show-current; git -C simulation-backend status -sb
git -C simulation-backend rev-parse HEAD   # unknown revision — no commits
git -C simulation-backend log --oneline -5 # no commits yet
git -C simulation-backend fetch --all      # ok
git -C simulation-backend ls-remote --heads origin  # empty
node --version; npm --version; git --version
netstat -ano | Select-String ':3000 |:3001 |:4000 |:4001 |:8000 '  # no matches
```

No `npm run/test`, no migration commands — do not invent results.

## 8. Configuration names without secret values

Proposed only (no `.env` at F0):

- `PORT` → `4000`; `FRONTEND_ORIGIN` / CORS allowlist → `http://localhost:3000`
- `DATABASE_URL` / `SQLITE_PATH` → private file under this repo (F3 finalises;
  never the auditor DB).
- No secrets or credentials.

## 9. Contracts and external dependencies

- **F1 contract**: Not implemented. Must define REST + Socket.IO shapes,
  sequencing, export formats before logic.
- **Planned**: serves simulation-frontend (HTTP + Socket.IO); produces
  CSV/JSON export files for manual upload to auditor. No direct auditor-DB
  access; no Python calls; no browser-DB access.
- **npm deps**: none yet.

## 10. Database/migration status

Not implemented. Separate SQLite DB owned privately by this backend (F3).
No schema, migrations, seeds, or DB files at F0. Must never open the auditor
backend's database.

## 11. Known issues and blockers

1. Empty remote — greenfield start.
2. Node pin undecided (`24.21.0` installed vs `22 LTS` candidate); build not
   yet verified.
3. SQLite driver + file location undecided until F2/F3.
4. F0 docs uncommitted — pending Mohan + lead review.

## 12. Deferred features

Per shared context: live auditor link (file export only in MVP1), autonomous
occupant behaviour, realistic physics, elaborate animations, doodle occupants
(MVP3), sensor/BMS, advanced tariffs, pricing. Fault scenarios beyond selected
controls are finalised later.

## 13. Last verification date and relevant existing commit references

- Date: 2026-09-24. No commits exist. F0 docs are untracked files pending
  review (`git status --short` in repo root).

## 14. Instructions to update this document after every completed layer

After each layer, update date, branch/HEAD, §§2–3/7–11 with actual files,
commands and results; preserve history; keep §§1/12/14 unless scope formally
changes. Return updated sections as evidence.
