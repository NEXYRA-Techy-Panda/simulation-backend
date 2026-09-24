# ACTIVE_TASK — simulation-backend

## Assignment / Layer ID

K001 — K0 (setup and onboarding). Prompt previously issued as P018; renamed to
K001 before execution (no P018 record existed; history not rewritten).
Agent: **K — Kishore's coding agent**. Owner: **Kishore Kumar**.
Category: simulator handoff and local setup.

## Scope (this repository)

Setup, handoff reading, baseline verification and documentation ONLY:
workspace/repo reuse, toolchain and `node:sqlite` checks, database
setup/isolation, the repository's own verification commands, real HTTP
lifecycle checks on a scratch database, plus
`docs/K001_KISHORE_ONBOARDING_EVIDENCE.md`, `docs/HANDOFF.md`,
`docs/ACTIVE_TASK.md`, `docs/PROGRESS_LOG.md`.
**No** application source, migration, contract, schema, seed or lockfile
change. **No** remaining simulator feature started. The run-policy timing
defect was located and reproduced but **not** fixed.

## Task status

completed (setup and onboarding)

## Review status

pending (never self-assigned)

## Previous task outcome (preserved)

P010 documentation completed with review pending (P008 occupancy/schedule
behaviour accepted based on supplied evidence). The run-policy timing defect
remains open — it is required before final historical-export acceptance and is
not an accepted limitation. Recorded in `docs/PROGRESS_LOG.md`.

## Current branch

`main`, clean. HEAD before this task's work: `12c380022cbe5ad813309f29ca4c61fbf6099580`
(== the reported P010 handoff baseline == `origin/main`; `git fetch --all`
clean; `ls-remote --heads origin` matches). No fast-forward was needed and the
repository was reused, not re-cloned. The K001 documentation commit is made on
top of that baseline.

## Last checkpoint timestamp, including timezone

2026-09-24 22:50:00 +05:30 (IST) — K001 verification complete; documentation
written; committing documentation only.

## Applicable contract version

1.0.1 (mirrored, read-only; `contracts/v1/**` and `scripts/verify-contract.mjs`
were not edited).

## Environment (this laptop)

Windows 11 build 26200, Git Bash; git `2.55.0.windows.4`, node `v24.19.0`,
npm `11.17.0` (satisfies `engines: >=24.0.0` and `.nvmrc`); `node:sqlite`
present; ports 3000/4000 free. `npm ci` → 0 vulnerabilities (npm 11 blocked the
esbuild postinstall; `tsx` v4.23.15 still works). No dependency upgrade and no
lockfile regeneration.

## Completed work

1. Renaming continuity: confirmed no P018/K001 record existed in either
   simulator repository; no amendment needed.
2. Startup checks: no `AGENTS.md`; correct origin/branch/HEAD, clean tree,
   fetch clean, Kishore's repo-local identity; the three Mohan-owned repos in
   the same parent folder were left untouched.
3. Read the full handoff and context set (both repos) plus this repo's
   KISHORE_BACKEND_HANDOFF, SIMULATION_ENGINE, P002/P004/P008 evidence and the
   shared contract.
4. Database: `data/` did not exist; `npm run db:setup` twice → idempotent
   (migrations 1,2 / schema v2 / 5 rooms / 18 devices / 20 policies; second run
   inserted 0). All mutations used scratch databases in the OS temp area.
5. Verification: `validate:schema` 24/24, `typecheck` 0, `lint` 0,
   `npm test` **56/56**, `npm run build` 0, `verify:contract` **67/75**
   (8 line-ending manifest hash failures — recorded, not fixed).
6. Live HTTP on the compiled build with a scratch database: health (CORS ok),
   inventory 5/18/20, no-run state without invented zeros, start/pause
   (frozen)/resume/speed, lighting override + clear back to policy, reset with
   the previous run preserved, restart recovery paused, IPC shutdown exit 0,
   POST preflight 204.
7. Reproduced the open run-policy timing defect with concrete timestamps and
   located the affected source.

## Open blocker (recorded, NOT fixed in K001)

Run-relative policy effective times: after a calendar change in one run, a
`reset` creates a new run that starts earlier (fixed initial time) while
immediately applying policy versions whose `effective_from_utc` lies later in
the previous run's timeline; the new run pins no earlier version at all.
Reproduced on this laptop (`pol-office-hours:2` effective
`2025-12-31T19:34:00Z` applied by a run starting `2025-12-31T18:30:00Z`).
Source anchors: `src/engine/engine.ts:351-371`, `src/db/runs.ts:20`/`:42-47`,
`src/engine/engine.ts:630`/`:642-646`, `src/engine/constants.ts:13`,
`src/db/inventory.ts:99`, `src/db/migrations/001_initial.ts:84`.
Details: `docs/K001_KISHORE_ONBOARDING_EVIDENCE.md` §11 and
`docs/KISHORE_BACKEND_HANDOFF.md` §6.

## Reported mismatch (not fixed)

`verify:contract` reports 67/75 on this laptop; all 8 failures are manifest
`hash match:` byte mismatches caused by `core.autocrlf=true` with no
`.gitattributes`. LF-normalised hashes reproduce the manifest values exactly,
so the contract content is correct. Remediation options are in the K001
evidence §8; changing repo/config files was out of scope for a setup task.

## F6 status

Foundation handoff NOT complete: frontend completion and end-to-end
export/import integration remain separate work.

## Exact next action

Implement the run-policy timing correction (KISHORE_BACKEND_HANDOFF.md §6 /
K001 evidence §11) as the next assigned K-layer, including the regression test
for a new 1 January run after a prior schedule change. Do not start Socket.IO,
exports, environment/comfort, faults or other features until assigned.

## Processes started by this task

None remaining. Port 4000 has no `LISTENING` socket. Scratch databases remain
in this laptop's temp area (`…\Temp\nexyra-k001\`) for inspection.

## Commit reference

Base: `12c3800`. K001 docs: the commit containing this file (hash recorded in
the K001 return report after push).
