# ACTIVE_TASK — simulation-backend

## Assignment / Layer ID

K002 — K1 (contract checkout portability and run-policy timing).
Agent: **K — Kishore's coding agent**. Owner: **Kishore Kumar**.
Category: simulator implementation, tests and documentation.

## Scope (this repository)

Two workstreams and their evidence:

1. Restore exact contract verification on Windows **without** weakening hashes
   (targeted `.gitattributes`, restore the confirmed-unmodified hashed paths from
   their exact blobs).
2. Fix new runs applying policy versions before their recorded activation, while
   preserving all previous run history.

Permitted writes: simulator implementation, tests, migrations and documentation.
**No** contract/schema/fixture change, **no** Socket.IO, export implementation,
environment controls, animations or new frontend features. Frontend changes are
line-ending configuration and documentation only. Mohan's three repositories and
parent files were not touched. No force-push, reset or history discard.

## Task status

completed (both workstreams; simulator and export pipeline are **not** complete)

## Review status

pending (never self-assigned)

## Previous task outcome (preserved)

- **K001 (K0 — setup and onboarding): completed, review pending.** Setup,
  baseline verification and documentation only; no source/migration/contract
  change. Evidence: `docs/K001_KISHORE_ONBOARDING_EVIDENCE.md`. It recorded the
  open policy-timing defect, the CRLF verifier mismatch and the pending browser
  checks. Its commit `1f43a5e` is published.
- **P010 documentation:** completed with review pending (P008
  occupancy/schedule behaviour accepted based on supplied evidence).
- The K001-discovered tasks (LF portability, policy timing) are the K002 work
  below.

## Current branch

`main`. HEAD at the start of K002 implementation:
`f7b134bfed86e6a56dafc335c512d61e82c403b1` (the K001 line-ending commit), equal
to `origin/main` after K001 was pushed. `git fetch` was clean. K002's own commits
are made on top of that.

## Last checkpoint timestamp, including timezone

2026-09-24 23:23:00 +05:30 (IST) — K002 implementation, tests and checks
complete; documentation written; committing.

## Applicable contract version

1.0.1 (mirrored, read-only; `contracts/v1/**`, its schema/fixtures and
`scripts/verify-contract.mjs` content were not edited — only their checkout
attributes).

## Environment (this laptop)

Windows 11 build 26200, Git Bash; git `2.55.0.windows.4`, node `v24.19.0`,
npm `11.17.0`. `core.autocrlf=true` comes from the **system** Git config
(`file:C:/Program Files/Git/etc/gitconfig`); no global Git configuration was
changed.

## Completed work

1. **LF portability:** added the two-rule `.gitattributes` to both simulator
   repositories; restored `contracts/v1/**` + `scripts/verify-contract.mjs` from
   their exact blobs after confirming no edits would be lost. Working tree and a
   fresh clone (inheriting `core.autocrlf=true`) both show 0 CR bytes and
   **75/75** in each repository. Contract semantics, the manifest and every hash
   check are unchanged. Recommendation recorded for Mohan's three mirrors.
2. **Run-policy timing:** forward migration
   `003_run_policy_activation` adds `run_policies.active_from_utc` (run-scoped
   activation) plus a `BEFORE INSERT` trigger requiring a UTC value.
   `createRun` activates pinned revisions at the run's start; mid-run calendar
   and occupancy changes activate at their boundary; `rebuildPolicies` resolves
   `device_schedule.office_hours_ref` to the office-hours revision pinned in the
   same run. `policy_versions.effective_from_utc` remains the immutable revision
   identity and is never edited.
3. **History preservation:** existing pins keep `NULL` (no backfill). Such runs
   are identified as `legacy_unrecorded` and validated against the global
   revision times; an inconsistent pre-K002 run stays **invalid for export**
   rather than being rewritten.
4. **Verification:** `npm test` **61/61** (56 pre-existing + 5 new),
   `typecheck` / `lint` / `build` exit 0, `validate:schema` 24/24,
   `verify:contract` 75/75.
5. **Real HTTP reproduction** on a scratch database (compiled build, port 4173):
   calendar change in run A activated at `2025-12-31T21:06:00Z`; run A kept v1
   before it and v2 from it; a reset run B starting `2025-12-31T18:30:00Z` pinned
   the same revision active from its own start with the global identity
   untouched (0 pins without activation, 0 intervals applying a policy before
   its activation, 11/11 dependent schedules resolving, no new revision minted);
   restart recovered run B paused at its checkpointed time with identical pins.

## Open blocker (recorded)

None for publishing. Remaining work is **not** an accepted completeness claim:
the production export endpoint is not implemented, browser verification was not
possible in this session, and pre-K002 inconsistent runs stay unsupported.

## F6 status

Foundation handoff NOT complete: frontend completion and end-to-end
export/import integration remain separate work.

## Exact next action

Implement the historical export endpoint (`POST/GET /api/v1/export`, contract's
self-contained CSV/JSON formats) so a run's stored snapshots and readings can be
served as a contract-1.0.1 dataset with run-scoped effective times, and validate
it against `energy-ml-service` `POST /v1/analyze`. Do not start Socket.IO,
environment/comfort, faults or other features until assigned.

## Processes started by this task

None remaining. Port 4173 has no `LISTENING` socket (the two servers started for
the HTTP reproduction were stopped). Scratch databases remain in this laptop's
temp area (`…\Temp\nexyra-k002\`) for inspection.

## Commit reference

Base: `f7b134b`. K002 implementation + migration + tests + docs:
`26ba7174d7f0d5f55a6ca821e501bb5d2cef6d30` (pushed to `main`). A short follow-up
documentation commit records this hash.
