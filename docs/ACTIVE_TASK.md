# ACTIVE_TASK — simulation-backend

## Assignment / Layer ID

P004 — K1 (authoritative simulation clock and first energy loop).
Agent: B — Claude Code. Owner: Mohan.

## Ownership

Exclusive write: `simulation-backend` only. OpenCode owns the frontends;
Codex owns auditor-backend. No sibling repos, parent files or contracts/v1.

## Objective

Backend-authoritative engine: start/pause/resume/reset/speed, fixed 10 s
simulated steps at speeds 1/2/10/60/100/1000 from 2026-01-01 00:00 IST,
correct device energy, transactional minute intervals, checkpoint +
paused recovery, real GET /api/v1/state, manual lighting control via
POST /api/v1/devices/:id. No schedules automation, occupancy movement,
Socket.IO, history generation, export, faults or frontend work.

## Task status

completed

## Review status

pending

## Previous task outcome (preserved)

P002 / F3-S accepted based on supplied evidence (`b0f569a`).

## Current branch

`main` at `b0f569ac16503112b25e4a9845d4c861f29a2165` (== origin/main).

## Last checkpoint timestamp, including timezone

2026-09-24 20:10:42 +05:30 (IST) — P004 implementation completed; committing + pushing.

## Completed work

1. Startup checks; P002 acceptance + owner decisions recorded.
2. Migration 002 engine_checkpoints (001 untouched).
3. Engine (constants, schedule measurement, wall-clock scheduler, engine),
   routes (state, control, speed, devices), ApiError, health via engine,
   server recovery + engine checkpoint on shutdown.
4. Tests: engine (energy, speeds, toggle, reconciliation, pause, repeated
   start, transitions, reset, graceful + crash restart, schedule helper) and
   HTTP (lifecycle, errors, lighting, responsiveness, reset).
5. Live port-4000 demo on a temp DB incl. restart recovery.
6. Docs: SIMULATION_ENGINE.md, P004_K1_EVIDENCE.md, README, HANDOFF, PROGRESS_LOG.

## Checks/results

- verify:contract 75/75; validate:schema 24/24; typecheck 0; lint 0; test 39/39; build 0.
- Live demo: light 0.0030 kWh and office 0.0123333 kWh reconciled with 3 persisted minutes + 20 s partial; restart recovered paused.

## Known limitations

- Manual-demo only: occupancy 0, synthetic climate, lighting-only control,
  clear-override → base state, constant fridge, no AC thermal model, no V/I.
- Crash (no graceful shutdown) can lose < 1 simulated minute since the last checkpoint.
- OS-signal delivery (Ctrl+C / Linux SIGTERM) not exercised; IPC shutdown path verified.
- New runs always start at 2026-01-01 00:00 IST.

## Exact next action

Commit + push P004, verify remote hash, return P004 evidence. Then STOP — next layer (schedules/occupancy/Socket.IO/export) only when assigned.

## Processes started by Agent B

Test child servers and live demo servers (PIDs 14812, 22088 on port 4000) — all exited via graceful IPC shutdown (exit 0). None left running.

## Commit reference

Base: `b0f569a`. P004: the commit containing this file (hash in the P004 return report).
