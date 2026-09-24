# ACTIVE_TASK — simulation-backend

## Assignment / Layer ID

P010 — F6-S documentation (simulator backend handoff to Kishore Kumar).
Agent: B — Claude Code. Category: foundation handoff + Mohan feature.
Owner: Mohan.

## Scope (this repository)

Documentation ONLY: docs/KISHORE_BACKEND_HANDOFF.md plus HANDOFF.md,
ACTIVE_TASK.md, PROGRESS_LOG.md. No simulator source, migration, contract
or feature changes. (The Python part of P010 is in energy-ml-service.)

## Task status

completed (documentation)

## Review status

pending

## Previous task outcome (preserved)

P008 occupancy/schedule behaviour accepted based on supplied evidence;
run-policy timing defect remains open.

## Current branch

`main` at `6d2630973139c5612d4e8c78cd928bc994ae2ca0` before the P010 docs
commit (== origin/main at start).

## Last checkpoint timestamp, including timezone

2026-09-24 20:46:25 +05:30 (IST) — handoff document written; committing documentation only.

## Completed work

1. Startup checks (both repos at reported baselines, clean, no AGENTS.md).
2. docs/KISHORE_BACKEND_HANDOFF.md: continuity protocol, commit references,
   setup/migrate/seed/test/start commands, routes + pointer to the complete
   API examples, clock/interval/recovery, occupancy/schedules, the OPEN
   run-policy timing defect (required before final historical-export
   acceptance), accepted limitations, remaining simulator work.
3. HANDOFF.md addendum + PROGRESS_LOG entry.

## Open blocker (recorded, NOT fixed in P010)

Run-relative policy effective times: a new run may start before the
effective_from timestamps of policy versions inherited from an earlier run,
while applying those versions immediately. Required before final
historical-export acceptance (see KISHORE_BACKEND_HANDOFF.md §6).

## F6 status

Foundation handoff NOT complete: frontend completion and end-to-end
export/import integration remain separate work.

## Exact next action

Commit + push documentation only; verify remote hash. Next simulator work
belongs to Kishore Kumar: read the continuity files and
KISHORE_BACKEND_HANDOFF.md before implementing the next assigned task.

## Processes started by Agent B

None in this repository.

## Commit reference

Base: `6d26309`. P010 docs: the commit containing this file (hash in the P010 return report).
