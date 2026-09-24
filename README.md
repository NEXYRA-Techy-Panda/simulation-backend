# simulation-backend

Simulation authority for the NEXYRA commercial-building energy simulation
and auditing project.

- **Role**: Node.js + Express + TypeScript + Socket.IO + SQLite service owning
  simulation time, occupancy, schedules, device states, readings, aggregation,
  history, CSV/JSON export, and scenario generation.
- **Owner**: Mohan (foundation F0–F6) → Kishore Kumar (after handoff).
- **Local port**: `4000`. Serves `simulation-frontend` on `3000`.

## Status (P002 / F3-S, 2026-09-24)

SQLite foundation + inventory implemented; review pending. Routes:
`GET /api/v1/health` (engine still `not_initialized`, no run invented) and
`GET /api/v1/inventory` (database-backed rooms, devices, latest policy
versions). Not implemented: simulation clock, occupancy engine, device
commands, Socket.IO, history, export, fault injection (later layers).
Evidence: [P002 F3-S evidence](docs/P002_F3_S_EVIDENCE.md),
[F2-B evidence](docs/F2_B_EVIDENCE.md).

## Setup and commands (Windows PowerShell or Linux shell; Node >= 24, npm)

```sh
npm ci                     # exact versions from package-lock.json
npm run db:setup           # = db:migrate + db:seed (both idempotent, non-destructive)
npm run dev                # tsx watch src/server.ts  -> http://localhost:4000
```

| Script | What it does |
|---|---|
| `db:migrate` | apply pending forward-only migrations (`schema_migrations` history; refuses edited migrations) |
| `db:seed` | insert MISSING demo inventory only (5 rooms, 18 devices, 20 policies); never overwrites edits |
| `dev` / `build` / `start` | watch mode / `tsc` to `dist/` / `node dist/server.js` |
| `typecheck` / `lint` / `test` | tsc --noEmit / eslint / node:test via tsx (temp DBs only) |
| `verify:contract` / `validate:schema` | contract checks (read-only bundle) / formal JSON Schema 2020-12 (Ajv) |

Startup applies pending migrations but does **not** seed. Compiled CLIs:
`node dist/cli/migrate.js`, `node dist/cli/seed.js`. No reset command exists
— nothing deletes data. Driver: built-in `node:sqlite` (no native addon).

Checks: `curl http://localhost:4000/api/v1/health`,
`curl http://localhost:4000/api/v1/inventory`.

## Configuration

Copy `.env.example` to `.env` for local overrides (`.env` is git-ignored;
real environment variables take precedence). Variables: `PORT` (4000),
`HOST` (127.0.0.1), `FRONTEND_ORIGIN` (http://localhost:3000; the only CORS
origin — CORS is not authentication), `JSON_BODY_LIMIT` (100kb),
`SHUTDOWN_TIMEOUT_MS` (10000), `DATABASE_PATH` (`data/simulation.sqlite`,
relative to the working directory; `data/` and WAL/SHM sidecars are
git-ignored), `SQLITE_BUSY_TIMEOUT_MS` (5000). Local development scaffold
only — not approval to expose endpoints publicly.

Graceful shutdown: Ctrl+C / SIGTERM, or an IPC `"shutdown"` message when
started with an IPC channel — closes HTTP, then the database.

Docs:

- [Project context](docs/PROJECT_CONTEXT.md)
- [Workspace map](docs/WORKSPACE_MAP.md)
- [Handoff](docs/HANDOFF.md)
- [Agent start prompt](docs/AGENT_START_PROMPT.md)
- [Active task](docs/ACTIVE_TASK.md)
- [Progress log](docs/PROGRESS_LOG.md)
- [F1 evidence](docs/F1_EVIDENCE.md)
- [F2-B evidence](docs/F2_B_EVIDENCE.md)
- [P002 F3-S evidence](docs/P002_F3_S_EVIDENCE.md)
- [Data contract v1](contracts/v1/CONTRACT.md) (canonical copy in this repo)
- [Service interfaces](contracts/v1/API.md)
