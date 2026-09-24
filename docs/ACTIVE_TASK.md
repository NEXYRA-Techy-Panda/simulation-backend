# ACTIVE_TASK — simulation-backend (branch `mohan/k005-history-prep`, worktree)

> Branch-local continuity for the isolated worktree `K:\simulation-backend-k005`
> on **Mohan's laptop**. Kishore's `main` working copy / laptop keeps its own
> ACTIVE_TASK; this file does not describe it.

## Assignment / Layer ID

**K004-FAST1 — takeover and K005 continuation** (fast-days mode + hourly
recording). Developer **Mohan** | Agent **M-C — Claude Code**. Previous
assignee: Kishore K-B — GLM-5.3.

## Task status

completed (branch preparation; not merged, pushed or deployed)

## Review status

pending (never self-assigned)

## Scope

This worktree and the frontend worktree `K:\simulation-frontend-fast1`
(`mohan/k004-fast1-controls`). No merge into `main`, no push, no deployment,
no edits to other agents' working copies.

## Takeover facts (Mohan's laptop)

GLM (K-B) work is **not reachable here** (remote has only `main` `929e78e`; no
K004 branch/bundle/worktree/handoff). Nothing of GLM's was reused; any GLM work
must be reconciled on Kishore's laptop.

## Previous task outcome (preserved)

- **K005-PREP (M-C): completed, review pending** — batch history jobs on the
  shared engine (`1975c8d`, `92aadd8`, `0464c9a`); evidence
  [K005_HISTORY_GENERATION_PREP_EVIDENCE.md](K005_HISTORY_GENERATION_PREP_EVIDENCE.md).
- **K002 (Kishore): completed, review pending** (from `main` `929e78e`).

## Completed work (K004-FAST1)

1. Per-run recording interval 60 | 3600 s in immutable run config; local-hour
   aggregation of the same 10 s steps; calendar changes at the next recording
   boundary; checkpoints at recording boundaries.
2. `POST /control/advance {days 1..31}`, `POST /control/advance/stop` on the
   existing scheduler (≈1 day/s), single runner per run, `state.advance`.
3. Hourly history jobs; branch-local migration 005.
4. Tests `test/fast.test.ts` 13/13; suite 92/92 (excl. shutdown.test.ts);
   typecheck/lint/build; schema 24/24; contract 75/75.
5. Measured 30-day advance: 30.12 s, 259,200 steps, 12,960 + 3,600 hourly rows.
6. Frontend `FastDaysPanel` (`ebdfdb4`), 27/27 tests, build clean; real-HTTP
   adapter check against this branch passed. Browser not verified.
7. Evidence: [K004_FAST1_TAKEOVER_EVIDENCE.md](K004_FAST1_TAKEOVER_EVIDENCE.md);
   transfer bundles in `K:\k004-fast1-transfer\`.

## Last checkpoint timestamp, including timezone

2026-09-25 05:15 +05:30 (IST) — evidence written; final local commits and
bundles.

## Exact next action

None for M-C. For K-A (integration, on Kishore's laptop): import the bundles
per `K:\k004-fast1-transfer\README.txt` (after Mohan transfers them); review;
mount the history router (K005 evidence §10) and the FastDaysPanel; renumber
migrations 004/005 if needed; reconcile with GLM/K004 climate work and re-run
`test/fast.test.ts` + `test/history.test.ts`; run `shutdown.test.ts` where
port 19001 is free; browser-verify the panel.

## Processes started by M-C

None remaining. Scratch data kept: `%TEMP%\nexyra-k005\…`,
`%TEMP%\nexyra-k004-fast1\…`.

## Commit reference

Backend: base `929e78e`; `1975c8d` `92aadd8` `0464c9a` (K005), `c6794b2` +
a final docs/script commit (K004-FAST1; hash in the transfer README).
Frontend: base `dbcbee9`; `ebdfdb4`. Local only; not pushed.
