# simulation-backend

Simulation authority for the NEXYRA commercial-building energy simulation
and auditing project.

- **Role**: Node.js + Express + TypeScript + Socket.IO + SQLite service owning
  simulation time, occupancy, schedules, device states, readings, aggregation,
  history, CSV/JSON export, and scenario generation.
- **Owner**: Mohan (foundation F0–F6) → Kishore Kumar (after handoff).
- **Local port (proposed)**: `4000`. Serves `simulation-frontend` on `3000`.
- **State at F0 (2026-09-24)**: empty repository — documentation only, no code.
  See `docs/HANDOFF.md` for verified state.

Docs:

- [Project context](docs/PROJECT_CONTEXT.md)
- [Workspace map](docs/WORKSPACE_MAP.md)
- [Handoff](docs/HANDOFF.md)
- [Agent start prompt](docs/AGENT_START_PROMPT.md)
- [Active task](docs/ACTIVE_TASK.md)
- [Progress log](docs/PROGRESS_LOG.md)
- [F1 evidence](docs/F1_EVIDENCE.md)
- [Data contract v1](contracts/v1/CONTRACT.md) (canonical copy in this repo)
- [Service interfaces](contracts/v1/API.md)
