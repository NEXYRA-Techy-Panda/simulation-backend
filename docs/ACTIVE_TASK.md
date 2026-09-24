# ACTIVE_TASK — simulation-backend

## prompt_id

K003 — historical JSON/CSV export (resumed under Kishore | K-A — OpenCode).

## agent / owner

- Developer: Kishore Kumar
- Agent: K-A — OpenCode
- Previous owner label: Agent K (Kishore's coding agent)
- Exclusive scope: `simulation-backend` only for this task.

## status

in_progress — implementation and focused verification complete; continuity,
final diff review, commit and push remain.

Review status: pending (never self-approved).

## baseline and previous outcome

- Resumed clean `main` at deployment baseline `929e78e7b6b19bf586e131a6bc256e2b211e3bcf`.
- K002 remains complete, review pending: schema v3, LF contract checkout, and
  run-scoped policy activation are preserved.
- No pre-existing K003 source/evidence or unfinished edits were found.

## implemented checkpoint

- Added paginated `GET /api/v1/runs` with committed row coverage and explicit
  no-data / exportability reasons.
- Added strict raw-file `GET` and `POST /api/v1/export` for JSON/standalone CSV,
  run, half-open UTC window, and 60/300/600/900/1800/3600-second aggregation.
- Production uses a separate read-only SQLite connection and one WAL read
  transaction per export. The engine's unpublished partial accumulator is never
  flushed or exported.
- Run snapshots and K002 activation are used. Legacy-null pins are validated
  against global history and rejected when inconsistent; they are never repaired.
- Gaps, invalid coverage, mixed policy refs in a coarse bucket and incompatible
  measurements fail before file headers. Energy/power/fraction aggregation and
  final cumulative counters follow contract v1.0.1.
- Format-independent SHA-256 selection/content identity allows equivalent JSON
  and CSV to deduplicate while changed content/range/resolution gets a new ID.
- Limits: 31 days, 1,000,000 source device rows, 1,000,000 source room rows,
  two concurrent exports. JSON/CSV bodies stream with backpressure.

## verification checkpoint — actual

- `npm test`: 77/77 passed.
- `npm run typecheck`: passed.
- `npm run lint`: passed with zero warnings/errors.
- `npm run build`: passed.
- `npm run verify:contract`: 75/75.
- `npm run validate:schema`: 24/24.
- Real temporary simulator HTTP export: 18 device rows, energy
  `0.0027999999990000004` kWh, one shared JSON/CSV export ID.
- Pinned auditor `67998d5` pure import/validation accepted both files with zero
  errors and the same semantic fingerprint
  `ecaead52a2ae5f2b1f41eb41e8b2a0af651f9a72b91583566fce109da2a0d38d`.
- Full auditor DB/HTTP re-import is **not claimed**: isolated `npm ci` could not
  build pinned `better-sqlite3@13.0.3` because no usable Python/node-gyp runtime
  exists on this laptop. Mohan-owned trees were not changed or run.

## files changed so far

- `src/app.ts`, `src/server.ts`, `src/db/connection.ts`
- `src/export/{types,time,dataset,serialize}.ts`
- `src/routes/exports.ts`
- `test/export.test.ts`, `test/export.http.test.ts`,
  `test/export.snapshot.test.ts`
- K003 evidence and continuity/README/engine documentation (in progress)

No migration, dependency, lockfile, contract, production database or deployment
configuration was changed.

## safety / processes

All databases and browser/backend checks used task-owned temporary resources.
Local frontend :3100 and backend :19001 processes were stopped; ports were
verified clear. No production simulator command, database, Nginx, PM2,
webhook or deployment action was used.

## exact next action

Finalize K003 evidence/handoff/README/engine docs, rerun all gates after the
final diff, inspect staged files, commit and push only backend K003 files, then
verify the remote hash. Do not begin K004.
