# simulation-backend

Simulation authority for the NEXYRA commercial-building energy simulation
and auditing project.

- **Role**: Node.js + Express + TypeScript + Socket.IO + SQLite service owning
  simulation time, occupancy, schedules, device states, readings, aggregation,
  history, CSV/JSON export, and scenario generation.
- **Owner**: Mohan (foundation F0–F6) → Kishore Kumar (after handoff).
- **Local port**: `4000`. Serves `simulation-frontend` on `3000`.

## Status (P004 / K1, 2026-09-24)

Authoritative simulation clock + first energy loop implemented; review
pending. Routes: `GET /api/v1/health`, `GET /api/v1/inventory`,
`GET /api/v1/state`, `POST /api/v1/control/{start,pause,resume,reset,speed}`,
`POST /api/v1/devices/:id` (lighting `manual_state` on/off, `clear_override`).
Fixed 10 s steps, speeds 1/2/10/60/100/1000, start 2026-01-01 00:00 IST,
minute intervals persisted transactionally, restart recovers the active run
paused. Manual-demo mode only: no schedule execution, occupancy movement,
Socket.IO, history generation, export or fault injection yet. Design:
[SIMULATION_ENGINE.md](docs/SIMULATION_ENGINE.md); evidence:
[P004 K1](docs/P004_K1_EVIDENCE.md), [P002 F3-S](docs/P002_F3_S_EVIDENCE.md).

Quick demo (after `npm run db:setup` and `npm run dev`):

```sh
curl -X POST http://localhost:4000/api/v1/control/start -H "Content-Type: application/json" -d "{\"speed\":60}"
curl -X POST http://localhost:4000/api/v1/devices/dev-meeting-light -H "Content-Type: application/json" -d "{\"manual_state\":\"on\"}"
curl http://localhost:4000/api/v1/state
curl -X POST http://localhost:4000/api/v1/control/pause
```

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

Startup applies pending migrations, recovers the most recent active run as **paused**, and does **not** seed. Compiled CLIs:
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
started with an IPC channel — stops the clock and checkpoints the engine
(including the partial minute), closes HTTP, then the database.

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
- [Simulation engine (K1)](docs/SIMULATION_ENGINE.md)
- [P004 K1 evidence](docs/P004_K1_EVIDENCE.md)
- [Data contract v1](contracts/v1/CONTRACT.md) (canonical copy in this repo)
- [Service interfaces](contracts/v1/API.md)
