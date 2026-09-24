# ACTIVE_TASK — simulation-backend (branch `mohan/k005-history-prep`, worktree)

> Branch-local continuity for the isolated K005-PREP worktree. The `main`
> working copy (`K:\NEXYRA\simulation-backend`, owner Kishore / K-A) keeps its
> own ACTIVE_TASK; this file does not describe it.

## Assignment / Layer ID

K005-PREP — simulator monthly history generation (backend batch preparation).
Developer **Mohan** | Agent **M-C — Claude Code**. Supporting simulator batch
5 / approximately 8. K003/K004 integration remains pending (numbering does not
imply those batches are finished).

## Scope

Exclusive write: this worktree only (`K:\simulation-backend-k005`, branch
`mohan/k005-history-prep`). Batch-generation service + job orchestration using
the committed engine; focused persistence (branch-local migration); separate
history-job route module; tests; integration docs. **Not**: frontend, export,
fault injection, Socket.IO, reporting, comparisons, AC model, app/server
rewiring, merge, push or deployment.

## Task status

in_progress

## Review status

pending (never self-assigned)

## Previous task outcome (preserved, from `main` at `929e78e`)

- **K002 (Kishore / K agent): completed, review pending.** LF portability and
  run-scoped policy activation (`003_run_policy_activation`), commit
  `26ba717`; `npm test` 61/61 at that time; export endpoint **not**
  implemented; browser verification not performed; pre-K002 inconsistent runs
  unsupported for export. Its recorded next action was the export endpoint
  (K003, owned by Kishore K-A — not this task).
- `929e78e` (mohan-madhu): fixed listener port 19001 (PORT ignored).

## Current branch

`mohan/k005-history-prep` created from `main`
`929e78e7b6b19bf586e131a6bc256e2b211e3bcf` (== `origin/main` per `git ls-remote`
at task start). Git identity: existing repo-local mohan-madhu (no global change).

## Last checkpoint timestamp, including timezone

2026-09-25 03:15 +05:30 (IST) — implementation group 1 committed locally (engine batch
mode, jobs, routes, 19 tests); next: month run + evidence.

## Design decisions (narrow, documented)

1. Contract route `POST/GET /api/v1/history/jobs` (`from`, `to`,
   `interval_seconds`); additive `month`, `seed`, `occupancy` fields.
2. Only `interval_seconds: 60` (the engine's stored interval); 10 s steps.
3. Occupancy **mode** and **calendar** are global policy revisions: a
   job-specific mode or calendar would mint a global revision, so they are
   rejected; runtime `total`/`target` for the current pinned mode are accepted.
4. Batch runs never write `engine_checkpoints` (the interactive recovery
   source); explicit `history_jobs.run_id` + run config `run_purpose`.
5. Interrupted jobs are marked failed (`JOB_INTERRUPTED`); no resume.

## Environment note

VS Code (pid 26420) holds 127.0.0.1:19001/19002/19003 on this laptop (likely
port forwarding). Not touched. Tests use port 0 only; the pre-existing
`shutdown.test.ts` needs 19001 and cannot pass while it is held.

## Exact next action

Run one representative month generation (scratch DB, ephemeral-port harness),
record results in K005 evidence; update HANDOFF; commit locally.

## Processes started by M-C

None persistent.

## Commit reference

Base `929e78e`. K005-PREP: none yet (local commits only; no push).
