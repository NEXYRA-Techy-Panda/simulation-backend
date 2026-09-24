# ACTIVE_TASK — simulation-backend

## Assignment / Layer ID

P002 — F3-S (simulator SQLite foundation and inventory).
Agent: B — Claude Code. Owner: Mohan.

## Objective

Real SQLite foundation: connection factory (FK enforcement, busy timeout,
WAL), versioned idempotent migrations, contract-aligned tables (rooms,
devices, versioned policies, runs + immutable config, run inventory/policy
snapshots, room/device interval readings, migration history), idempotent
non-destructive demo seed (5 rooms, 18 devices), DB-backed
`GET /api/v1/inventory`, health unchanged. No clock, occupancy, commands,
Socket.IO, history, export or fault injection. Stop after P002.

## Task status

completed

## Review status

pending

## Ownership

- Exclusive write access for P002: `simulation-backend` ONLY.
- Codex owns `auditor-backend`; OpenCode owns the frontends. Agent B must
  not edit `auditor-backend`, `energy-ml-service`, the frontends, parent
  files, or the contract snapshot (`contracts/v1`, `scripts/verify-contract.mjs`).

## Previous task outcome (preserved)

F2-B (`1418f52`) accepted by the architecture lead based on supplied
evidence; graceful-shutdown verification outstanding (addressed in P002).
Known documentation typo: CONTRACT.md §1 prose "1.0.0" — schema, manifest
and fixtures (1.0.1) are authoritative; not edited here.

## Current branch

`main` at `1418f5214999b984b09f6ef470879520451ae683` (== origin/main; clean).

## Last checkpoint timestamp, including timezone

2026-09-24 19:55:55 +05:30 (IST) — P002 implementation completed; committing + pushing.

## Applicable contract version

1.0.1 (read-only).

## Completed steps

1. Startup: no AGENTS.md; continuity + contract read; tree clean; in sync.
2. Driver: built-in node:sqlite (no new npm dependency).
3. Connection factory, checksum-guarded migrations, migration 001 schema.
4. Contract-validated policy versions; run snapshots; idempotent seed.
5. DB-backed GET /api/v1/inventory; startup migrates (no seed); IPC shutdown.
6. Checks green (75/75, 24/24, typecheck/lint/build 0, tests 22/22); CLI
   sequence and live port-4000 check on a scratch DB; graceful shutdown via IPC.
7. README, HANDOFF, PROGRESS_LOG, docs/P002_F3_S_EVIDENCE.md updated.

## Files changed

src/db/** (connection, migrate, migrations/001, inventory, runs, seed, clock), src/contract/validators.ts, src/cli/{migrate,seed}.ts, src/env.ts, src/routes/inventory.ts, src/app.ts, src/server.ts, src/config.ts, test/{app,db,shutdown}.test.ts, test/helpers.ts, package.json (scripts), .env.example, .gitignore (WAL/SHM), README.md, docs/*. contracts/v1 + verify-contract.mjs unchanged.

## Verification performed and actual results

verify:contract 75/75; validate:schema 24/24; typecheck 0; lint 0; test 22/22; build 0; db:migrate ×2 and db:seed ×2 idempotent (5/18/20); live http://localhost:4000 health not_initialized + inventory 5/18/20 + 404 envelope; IPC graceful shutdown exit 0 with DB closed.

## Incomplete edits and uncommitted changes

None beyond the P002 commit in progress.

## Blockers or unknowns

- None blocking.
- OS-signal (Ctrl+C / Linux SIGTERM) delivery not exercised by the agent; IPC graceful path verified.
- on_windows [] semantics for scheduled devices undefined in contract 1.0.1.
- node:sqlite not yet documented Stable in Node 24.

## Exact next action

Commit + push P002, verify remote hash, return P002 evidence. Then STOP — next task only when assigned.

## Processes started by Agent B

Test child servers (ephemeral ports) and live check server PID 1344 on port 4000 — all exited via graceful shutdown (exit 0). None left running.

## Commit reference

Base: `1418f52`. P002: the commit containing this file (hash in the P002 return report).
