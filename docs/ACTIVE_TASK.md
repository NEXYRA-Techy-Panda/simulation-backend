# ACTIVE_TASK — simulation-backend

## Assignment / Layer ID

P008 — K3–K4 (occupancy allocation and operating schedules).
Agent: B — Claude Code. Owner: Mohan.

## Ownership

Exclusive write: `simulation-backend` only. OpenCode owns the frontends;
Codex owns auditor-backend. No sibling repos, parent files or contracts/v1.

## Objective

Replace zero-occupancy/manual-demo behaviour with automatic room allocation
(manual + scheduled modes, 0–20, stable seeded occupants, simple
meeting/lunch redistribution), working-day/hour calendar, real schedule and
vacancy-grace device control, overrides returning to policy when cleared,
versioned runtime policy changes effective at the next minute boundary;
POST /api/v1/occupancy and POST /api/v1/calendar; extended state; complete
API examples for OpenCode. Preserve clock/energy/persistence/recovery.

## Task status

completed

## Review status

pending

## Previous task outcome (preserved)

P004 / K1 accepted based on supplied evidence (`93da205`).

## Current branch

`main` at `93da205aa0edbc6cc308c9cce7c1af19216f10df` (== origin/main).

## Last checkpoint timestamp, including timezone

2026-09-24 20:32:33 +05:30 (IST) — P008 implementation completed; committing + pushing.

## Completed work

1. Startup; P004 acceptance + MVP decisions recorded.
2. rng.ts, occupancy.ts, schedule.ts (permitted windows), engine.ts (policy
   control, grace, versioned calendar/occupancy changes, pending changes,
   checkpoint format 2), routes /occupancy, /calendar, seed on start/reset.
3. Tests 56/56 (17 new; 4 existing expectations updated for intended changes).
4. Live port-4000 demo on a temp DB; real bodies embedded in SIMULATION_ENGINE.md.
5. Docs: SIMULATION_ENGINE.md (complete examples), P008_K3_K4_EVIDENCE.md,
   README, HANDOFF, PROGRESS_LOG.

## Checks/results

- verify:contract 75/75; validate:schema 24/24; typecheck 0; lint 0; test 56/56; build 0.
- Live demo: scheduled 14 with meeting redistribution, calendar v2 pending → applied at 11:12 IST, manual 16, light off/on/clear, energy reconciled (15.760733 persisted + 0.035711 partial = 15.796444 kWh).

## Known limitations

- Arrivals/departures at opening/closing only; two predefined redistribution rules.
- No comfort/thermal AC behaviour; synthetic constant climate; constant fridge.
- Later runs pin latest policy versions whose effective_from_utc came from an earlier run's timeline.
- Commands need a run (409); crash loss < 1 simulated minute; OS-signal shutdown unexercised.

## Exact next action

Commit + push P008, verify remote hash, return P008 evidence. Then STOP — next layer only when assigned.

## Processes started by Agent B

Test servers (ephemeral ports) and live demo server PID 16576 on port 4000 — exited via graceful IPC shutdown (exit 0). None left running.

## Commit reference

Base: `93da205`. P008: the commit containing this file (hash in the P008 return report).
