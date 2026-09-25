# PROGRESS_LOG — simulation-backend

Append-only. Newest entry at the bottom. Correct outdated facts with a dated
correction entry; do not rewrite history.

---

## 2026-09-24 — F0 (reconstructed)

- Layer ID: F0 (repository setup and mapping).
- Developer/agent: F0 implementation agent (prior session; identity not recorded
  in supplied report). Reconstructed 2026-09-24 during F0.1 from F0 docs and the
  supplied F0 report — commands below are **reported**, not re-run by the F0.1 agent.
- Objective: clone the five repos into sibling folders, verify origins/branches,
  record tooling/ports, create shared context + per-repo handoff + onboarding
  prompt + README. No scaffolding, installs, schemas, or features.
- Changes: cloned `simulation-backend` from
  `https://github.com/NEXYRA-Techy-Panda/simulation-backend.git` into
  `../simulation-backend` (branch `main`, no commits — empty remote). Created
  untracked `README.md`, `docs/PROJECT_CONTEXT.md`, `docs/WORKSPACE_MAP.md`,
  `docs/HANDOFF.md`, `docs/AGENT_START_PROMPT.md`. Same pattern in siblings.
- Decisions/reasons: five independent repos; npm for JS/TS; ports 3000/4000/3001/
  4001/8000 proposed; Node `>=20.9` / Python `3.12` provisional until F2 checks.
- Commands/checks (as reported in F0 evidence): `git clone`, `rev-parse`,
  `remote -v`, `branch/status`, `rev-parse HEAD` / `log` (no commits),
  `fetch --all`, `ls-remote --heads` (empty), version checks (Node v24.21.0, npm
  11.19.0, Git 2.55.0.windows.5; Python unavailable), `netstat` (ports free).
  Parent confirmed not a Git repo.
- Unresolved at F0 close: Python missing; Node pin undecided; docs uncommitted;
  F1 contract pending.
- Next action (as closed): return F0 evidence; await review.
- Review status and evidence source: **Accepted by architecture lead based on
  supplied evidence; local files were not directly inspected by the lead.**
- Commit references: none (no commits at F0).

---

## 2026-09-24 17:47:57 +05:30 (IST) — F0.1 (actual)

- Layer ID: F0.1 (durable agent continuity, docs only).
- Developer/agent: F0.1 implementation agent (this session).
- Objective: continuity files + onboarding protocol for agent replacement.
- Changes (this repo): created `docs/ACTIVE_TASK.md`; this `docs/PROGRESS_LOG.md`;
  pending: `HANDOFF.md`, `AGENT_START_PROMPT.md`, `README.md` updates + final
  ACTIVE_TASK update.
- Decisions/reasons: verify-then-edit; preserve F0 untracked docs; per-repo
  task identity (Mohan foundation → Kishore handoff at F6 for this repo).
- Commands/checks and actual results (from `K:\NEXYRA`): AGENTS.md absent
  everywhere; `main` branch; correct origin; `status --short` → only
  `?? README.md`, `?? docs/`; `log` → no commits; file listing matches F0 report.
- Unresolved items: remaining F0.1 edits; review pending; no commits (by design).
- Next action: update HANDOFF/START_PROMPT/README; mark ACTIVE_TASK completed;
  readiness check; return F0.1 evidence. Do not begin F1.
- Review status and evidence source: pending; evidence is this file set + F0.1
  return report (working tree inspected directly).
- Commit references: none.

---

## 2026-09-24 17:51:10 +05:30 (IST) — F0.1 completion checkpoint (actual)

- Layer ID: F0.1. Task status: completed. Review status: pending (never
  self-assigned).
- Changes since the 17:47 entry: HANDOFF.md §0 set to completed; README links
  added; ACTIVE_TASK.md marked completed with full record; verification suite
  run (branch/origin/status/log per repo, 35-path link check, no-artifact scan,
  secret scan — all clean).
- Uncommitted changes: all F0 + F0.1 docs remain untracked by design; no commits.
- Next action: Return F0.1 evidence for architecture review; do not begin F1
  until its prompt is supplied.
- Commit references: none.

---

## 2026-09-24 18:02:31 +05:30 (IST) — F1 started (actual)

- Layer ID: F1 (versioned shared data + interface contract, design only).
- Developer/agent: F1 implementation agent (this session).
- Objective: define contract v1.0.0 (canonical in simulation-backend,
  mirrored to siblings) with fixtures + dependency-free verification; no
  application code.
- F0.1 outcome preserved above (completed; review pending at F0.1 close).
  F0/F0.1 review: accepted by architecture lead based on supplied evidence;
  local files were not directly inspected by the lead.
- Startup state: no AGENTS.md; all repos on `main`, correct origins, no
  commits, only untracked F0/F0.1 docs; fetch OK. Matches report.
- Owner updates applied/planned: Python 3.13.15 verified at supplied
  interpreter path (PATH shim stale, not modified); F0.1 "read-only" wording
  to be corrected; commit+push authorised from F1; hosting plan recorded
  (frontends Vercel, backends+Python on Mohan's VPS; no deployment in F1).
- Blockers/unknowns: no git user.name/user.email configured and no `gh` —
  commit/push will be attempted at completion; if auth fails, hashes and the
  exact remediation will be reported, nothing invented.
- Next action: author canonical contract bundle in
  `simulation-backend/contracts/v1/` + `scripts/verify-contract.mjs`.
- Review status: pending. Commit references: none yet.

---

## 2026-09-24 18:40:00 +05:30 (IST) — F1 contract authored + verified (actual)

- Changes: canonical bundle authored in THIS repo (`contracts/v1/` +
  `scripts/verify-contract.mjs` + `.gitignore`); mirrored to four siblings.
- Verification: `node scripts/verify-contract.mjs` → 49 passed, 0 failed in
  all five repos. Semantic checks only; formal schema validation is F2.
- Next action: continuity doc updates, then commit + push per repo.
- Review status: pending. Commit references: none yet.

---

## 2026-09-24 18:29:39 +05:30 (IST) — F1 commit/push blocked (actual)

- Contract work complete and verified (49/49 in all five repos); canonical
  bundle + mirrors + continuity docs + evidence files done.
- `git add` staged 18 task-owned files in THIS repo; `git commit` failed
  (exit 128): "Author identity unknown", no user.name/user.email.
- Asked Mohan twice for identity values; no name/email strings supplied, so
  nothing was configured and nothing was invented. No commit created anywhere;
  no push attempted (push auth still untested). Other four repos remain fully
  untracked (unstaged); all work preserved in working trees + this staged index.
- To unblock: `git config user.name/user.email` (repo-local or global), then
  per repo `git add`, `git commit -m "docs: establish foundation and v1 data
  contracts"`, `git push -u origin main`, verifying each remote hash.
  No force-push.
- Task status set to blocked (commit/push step only); review pending.

---

## 2026-09-24 18:37:52 +05:30 (IST) — F1-R1 started (actual)

- Layer ID: F1-R1 (targeted pre-acceptance corrections, canonical repo). F1
  implementation completed; architecture review: changes_requested. No
  approval, no F2.
- Prior publishing resolved: F1 committed + pushed in all five repos with
  verified remote hashes.
- Objective: (A) self-contained CSV via first-row metadata envelope, drop
  meta_policy; (B) 12 dp kWh export precision with consistent tolerances +
  in-memory 7 W rounding check; extend verifier with CSV-alone reconstruction,
  full semantic parity, and negative checks. Version stays 1.0.0.
- Startup: no AGENTS.md; all repos on `main`, clean trees at F1 commits;
  repo-local identity configured in all five (global untouched).
- Next action: author correction A in THIS repo's `contracts/v1/`.
- Review status: pending. Commit references: F1 pushed (see ACTIVE_TASK).

---

## 2026-09-24 18:43:07 +05:30 (IST) — F1-R1 corrections verified in canonical repo (actual)

- Correction A: CSV is self-contained (first-row meta_run envelope, no
  meta_policy); CSV_COLUMNS.md + CONTRACT.md §5/§6 + API export note updated;
  reference.csv rewritten (27 cols); fixture V/I/pf made an exact triple
  (200 V × 3/1.5 A × 1.0).
- Correction B: 12 dp kWh export precision, tolerances 1e-9 per-value /
  n·1e-9 totals / 1e-9 triple-relative; in-memory 7 W × 44,640-interval budget
  check (analytic 5.208 kWh, budget 2.232e-8); expected.json rounding_budget.
- Verifier: CSV-alone reconstruction + full semantic parity vs oracle,
  duplicate handling, 4 negative checks, rounding budget.
- Result: 54 passed, 0 failed in simulation-backend; manifest regenerated.
- Next action: mirror to four siblings, verify, update continuity docs,
  commit + push.
- Review status: pending. Commit references: F1 pushed; F1-R1 none yet.

---

## 2026-09-24 18:43:07 +05:30 (IST) — F1-R1 completed (actual)

- Corrections authored, mirrored, verified 54/54 in all five repos.
- Continuity updated: ACTIVE_TASK completed, HANDOFF F1-R1 addendum,
  F1_EVIDENCE F1-R1 section. Review pending; no approval claimed.
- Next action: commit, push `main`, verify remote hash; return F1-R1 evidence.
  Do not begin F2.
- Commit references: F1 pushed; F1-R1 recorded after push.

---

## 2026-09-24 19:01:33 +05:30 (IST) — F1-R2 started (actual)

- Layer ID: F1-R2 (canonical repo). F1-R1 completed; review changes_requested
  after direct inspection of 3000b9d (54/54 confirmed; CSV accepted).
- Objective: 9dp power precision + fractional checks; V/I semantics;
  kind-specific policy rules; persist-until-cleared overrides; concrete Python
  requests; full API paths + health states; version 1.0.1.
- Startup: no AGENTS.md; clean tree; fetch clean; repo-local identity present.
- Next action: author corrections in THIS repo's `contracts/v1/`.
- Review status: pending.

---

## 2026-09-24 19:07:48 +05:30 (IST) — F1-R2 completed (actual)

- Corrections authored, mirrored, verified 75/75 in all five repos.
- Continuity updated: ACTIVE_TASK completed, HANDOFF F1-R2 addendum,
  F1_EVIDENCE F1-R2 section. Review pending; no approval claimed.
- Next action: commit, push `main`, verify remote hash; return F1-R2 evidence.
  Do not begin F2.
- Commit references: F1-R1 pushed; F1-R2 recorded after push.

---

## 2026-09-24 19:07:48 +05:30 (IST) — F1-R2 corrections verified in canonical repo (actual)

- Schema 1.0.1 with kind-specific closed rules (+link rule documented in
  CONTRACT §2.5); power 9dp + fractional checks ×6 intervals; V/I average
  semantics with constant-fixture label; persist-until-cleared overrides with
  set/clear payloads; concrete Python A/B requests with bounds (intervals_ref
  removed); full API paths + scaffold health states; fixtures/envelope at 1.0.1.
- Result: 75 passed, 0 failed in simulation-backend; manifest regenerated.
- Next action: mirror to four siblings, verify, update continuity docs,
  commit + push.
- Review status: pending. Commit references: F1-R1 pushed; F1-R2 none yet.

---

## 2026-09-24 19:20:00 +05:30 (IST) — F2-B started (actual)

- Layer ID: F2-B (backend application foundations), Agent B, developer Mohan.
- Previous outcome preserved: F1-R2 completed + pushed at `f64ee215d4b3fc5021eadf8ec5eb7aeef290a024`;
  accepted by the architecture lead based on supplied evidence. Contract
  1.0.1 is the implementation baseline and is read-only during F2-B.
- Startup: no AGENTS.md; clean tree; origin in sync; verifier 75/75.
- Ownership: Agent B owns the three backend repos only; Agent A owns the
  frontends concurrently.
- Next action: scaffold, install, verify, document, commit + push.
- Review status: pending.

---

## 2026-09-24 19:35:36 +05:30 (IST) — F2-B checkpoint (actual)

- Node backends scaffolded; verify:contract 75/75, validate:schema 24/24
  (Ajv 8.20.0, Draft 2020-12 strict), typecheck/lint/test/build exit 0.
- energy-ml-service .venv created (Python 3.13.15); pinned requirements;
  pip check clean; pytest 8 passed; fresh-venv repro install freeze identical.
- Environment incident: pandas import initially failed —
  "DLL load failed while importing parsing: An Application Control policy has
  blocked this file" (Windows Smart App Control). Mohan changed the Windows
  setting; re-test: numpy/scipy/scikit-learn/pandas import OK,
  scripts/check_env.py exit 0. No workaround in code.
- Next action: live HTTP checks on 4000/4001/8000, docs, commit + push.

---

## 2026-09-24 19:39:10 +05:30 (IST) — F2-B completed (actual)

- Layer ID: F2-B. Task status: implementation completed; review pending
  (never self-assigned).
- Results: verify:contract 75/75; validate:schema 24/24 (Ajv 8.20.0, 2020-12 strict); typecheck/lint/build exit 0; test 7/7; live GET http://localhost:4000/api/v1/health → 200 not_initialized envelope; 404 NOT_FOUND + 400 VALIDATION_ERROR envelopes live.
- Live processes started by Agent B were stopped; none left running.
- Contract unchanged; ambiguities reported in docs/F2_B_EVIDENCE.md
  (CONTRACT.md §1 still says schema_version "1.0.0"; INTERNAL_ERROR code;
  Python envelope; model/info uninitialised shape).
- Deliberately not implemented: DB, simulation, uploads, interservice calls,
  training, deployment.
- Next action: commit + push, verify remote; next layer F3 pending its prompt.
- Commit references: F2-B hash recorded in the F2-B return report.

---

## 2026-09-24 19:48:18 +05:30 (IST) — P002 / F3-S started (actual)

- Assignment P002, layer F3-S, Agent B — Claude Code, owner Mohan.
- Previous outcome preserved: F2-B completed at `1418f52`; accepted by the
  architecture lead based on supplied evidence; graceful-shutdown
  verification outstanding.
- Ownership: simulation-backend only (Codex: auditor-backend; OpenCode:
  frontends).
- Contract note: CONTRACT.md §1 "1.0.0" is a known prose typo; 1.0.1
  authoritative; contract untouched.
- Decision: SQLite driver = built-in node:sqlite (Node 24.21.0, SQLite 3.53.4).
- Next action: implement DB foundation + inventory; verify; commit + push.
- Review status: pending.

---

## 2026-09-24 19:55:55 +05:30 (IST) — P002 / F3-S completed (actual)

- Layer: F3-S (P002), Agent B — Claude Code. Implementation completed;
  review pending (never self-assigned).
- Driver: node:sqlite (Node 24.21.0, SQLite 3.53.4) — no native addon,
  no install scripts, no new npm dependency.
- Delivered: connection factory (FK verified, busy timeout, WAL), versioned
  checksum-guarded migrations, migration 001 (inventory, versioned policies,
  immutable runs/config/snapshots, interval readings, history), idempotent
  non-destructive seed (5 rooms, 18 devices, 20 policies), DB-backed
  GET /api/v1/inventory, health unchanged, IPC graceful shutdown.
- Results: verifier 75/75; schema 24/24; typecheck/lint/build 0; tests 22/22;
  CLI migrate/seed twice idempotent; live port 4000 OK; graceful shutdown
  exit 0 via IPC (OS signal delivery not exercised).
- Decisions: nominal_power_w = whole group; startup migrates but never
  seeds; no reset operation; inventory returns latest policy versions.
- Open: on_windows semantics; node:sqlite stability status.
- Next action: commit + push; stop after P002.
- Commit references: P002 hash recorded in the P002 return report.

---

## 2026-09-24 20:01:41 +05:30 (IST) — P002 / F3-S accepted (recorded)

- P002 (commit `b0f569ac16503112b25e4a9845d4c861f29a2165`) was accepted by
  the architecture lead based on supplied evidence.

---

## 2026-09-24 20:01:41 +05:30 (IST) — P004 / K1 started (actual)

- Assignment P004, layer K1 (authoritative simulation clock + first energy
  loop), Agent B — Claude Code, owner Mohan. Exclusive write: simulation-backend.
- Baseline `b0f569a` == origin/main, clean tree; no AGENTS.md.
- Confirmed decisions (owner): empty device on_windows follows the referenced
  office-hours schedule; manual occupancy acceptable initially; inventory may
  show latest policies while history keeps applicable versions; manual
  overrides persist until cleared; existing node:sqlite driver; contract
  1.0.1 unchanged.
- Next action: engine core (clock, lifecycle, energy, minute persistence,
  checkpoint/recovery, lighting control) + tests.
- Review status: pending.

---

## 2026-09-24 20:10:42 +05:30 (IST) — P004 / K1 completed (actual)

- Layer: K1 (P004), Agent B — Claude Code. Implementation completed; review
  pending (never self-assigned).
- Delivered: deterministic 10 s-step engine + monotonic wall-clock scheduler
  (bounded batches, yields, single loop, no skipped steps); lifecycle routes
  (start/pause/resume/reset/speed), GET /state, lighting control via
  POST /devices/:id; transactional minute intervals + checkpoints (migration
  002); reset ends old run with a partial edge interval; paused recovery on
  restart.
- Results: verifier 75/75; schema 24/24; typecheck/lint/build 0; tests 39/39;
  1 kW × 1 h = 1 kWh; identical energy at all six speeds; live port-4000 demo
  reconciled; restart recovered paused.
- Decisions: owner decisions in docs/SIMULATION_ENGINE.md; state/control
  responses add status/speed/energy fields beyond the contract minimum;
  clear-override restores base state until the schedule layer.
- Open: schedule execution, occupancy, Socket.IO, export; OS-signal
  shutdown path unexercised; crash loss < 1 simulated minute.
- Next action: commit + push; stop after P004.
- Commit references: P004 hash recorded in the P004 return report.

---

## 2026-09-24 20:21:01 +05:30 (IST) — P004 / K1 accepted (recorded)

- P004 (commit `93da205aa0edbc6cc308c9cce7c1af19216f10df`) was accepted by
  the architecture lead based on supplied evidence.

---

## 2026-09-24 20:21:01 +05:30 (IST) — P008 / K3–K4 started (actual)

- Assignment P008, layers K3–K4 (occupancy allocation + operating
  schedules), Agent B — Claude Code, owner Mohan. Exclusive write:
  simulation-backend. Baseline `93da205` == origin/main, clean; no AGENTS.md.
- MVP decisions given by the owner: overnight windows belong to their
  opening day; open == close invalid; schedule closing ends automatic
  operation (grace only while the schedule permits); overrides persist until
  cleared and clearing returns to policy; calendar/policy changes effective
  at the next minute boundary; occupancy/manual changes at the next step.
- Next action: occupancy model + seeded RNG, schedule control with grace,
  occupancy/calendar routes, versioned policy application, tests, docs.
- Review status: pending.

---

## 2026-09-24 20:32:33 +05:30 (IST) — P008 / K3–K4 completed (actual)

- Layers K3–K4 (P008), Agent B — Claude Code. Implementation completed;
  review pending (never self-assigned).
- Delivered: seeded stable occupancy (manual/scheduled, redistribution,
  capacity checks), schedule + vacancy-grace device control, overrides that
  clear to policy, POST /occupancy and /calendar, versioned calendar changes
  effective at the next minute boundary (pending + checkpointed + pinned with
  the completed minute), extended state, complete API examples.
- Results: verifier 75/75; schema 24/24; typecheck/lint/build 0; tests 56/56;
  live port-4000 demo reconciled.
- Decisions: overnight → opening day; open == close invalid; closing ends
  automatic operation (grace only while permitted); explicit on_windows
  intersect office hours; manual-control devices override-only; overrides on
  all switch-capable devices; seed only at run creation; total (manual) vs
  target (scheduled) kept separate.
- Next action: commit + push; stop after P008.
- Commit references: P008 hash recorded in the P008 return report.

---

## 2026-09-24 20:38:41 +05:30 (IST) — P010 started (actual)

- Assignment P010 (category: foundation handoff + Mohan feature; layer
  F6-S documentation / Python deterministic analysis foundation), Agent B —
  Claude Code, owner Mohan.
- Permitted writes: simulation-backend continuity + handoff documentation
  ONLY; energy-ml-service implementation + docs. No simulator source,
  migrations, contracts, auditor-backend, frontends or parent files.
- Verified state: simulation-backend `6d26309`, energy-ml-service
  `22b0a08`, both == origin/main, clean; no AGENTS.md.
- Review record: P008 occupancy/schedule behaviour accepted based on supplied
  evidence; run-policy timing defect remains open. (F2-B was accepted based
  on supplied evidence, as recorded in later assignments.)
- Next action: write docs/KISHORE_BACKEND_HANDOFF.md (documentation only).

---

## 2026-09-24 20:46:25 +05:30 (IST) — P010 / F6-S documentation completed (actual)

- Documentation only (no source/migration/contract change):
  docs/KISHORE_BACKEND_HANDOFF.md, HANDOFF.md addendum, ACTIVE_TASK.md.
- Review record: P008 occupancy/schedule behaviour accepted based on
  supplied evidence; run-policy timing defect remains open.
- Open defect recorded (required before final historical-export acceptance;
  not fixed): run-relative policy effective times for inherited versions.
- F6 foundation handoff NOT complete (frontend + export/import integration).
- Related: energy-ml-service P010 deterministic analyze pushed at 36f5832; it
  rejects intervals whose policy effective_from is after the interval start.
- Next action: commit + push docs; remaining simulator work → Kishore Kumar.

---

## 2026-09-24 22:50:00 +05:30 (IST) — K001 / K0 completed (actual, Agent K — Kishore's coding agent)

- Layer ID: K001 (previously issued as P018; renamed to K001 before execution —
  no P018 record existed in this repo, so no history was rewritten). Layer K0 —
  Setup and onboarding. Owner: Kishore Kumar. Docs/setup only: no source,
  migration, contract, schema, seed or lockfile change.
- Startup: no AGENTS.md; target folder was already the correct repository, so
  it was reused (not re-cloned); origin verified; `main` clean at
  `12c3800` == reported P010 handoff baseline == `origin/main`; fetch clean;
  repo-local identity is Kishore's (`Kishorekumar5567`), not Mohan's. Parent
  folder (this laptop) contains all five repos; the three Mohan-owned ones
  were not touched.
- Environment (this laptop): Windows 11 build 26200, Git Bash, git
  2.55.0.windows.4, node v24.19.0, npm 11.17.0, `node:sqlite` present
  (DatabaseSync/StatementSync/Session/constants/backup), ports 3000/4000 free.
  Node 24 satisfies `engines: >=24.0.0` and `.nvmrc`; no dependency upgrade and
  no lockfile regeneration. `npm ci` clean (0 vulnerabilities); npm 11 blocked
  the esbuild postinstall (`allow-scripts`) but `tsx` v4.23.15 works.
- Database: `data/` did not exist before this task. `npm run db:setup` run
  twice → 1st applied migrations 1,2 (schema v2) and seeded 1 building / 5
  rooms / 18 devices / 20 policies / 20 versions; 2nd inserted 0 with totals
  unchanged → idempotent, non-destructive. All mutations used separate scratch
  databases in the OS temp area (`…\Temp\nexyra-k001\scratch.sqlite`,
  `scratch-defect.sqlite`); the dev database was not mutated and no SQLite file
  was committed.
- Baseline checks (actual): `validate:schema` 24/24 exit 0; `typecheck` exit 0;
  `lint` exit 0; `npm test` **56/56** exit 0; `npm run build` exit 0.
  **MISMATCH:** `verify:contract` → **67 passed, 8 failed (exit 1)**, all eight
  being manifest `hash match:` failures. Cause proven: `core.autocrlf=true`
  with no `.gitattributes` checked LF blobs out as CRLF while the verifier
  hashes raw bytes (`scripts/verify-contract.mjs:41`); LF-normalised hashes
  reproduce the manifest values exactly. Contract content is correct; it is a
  clone/line-ending condition, reported and NOT fixed in K001.
- Live HTTP (compiled build + scratch DB, port 4000): health 200
  `not_initialized` with `Access-Control-Allow-Origin: http://localhost:3000`;
  inventory 5 rooms / 18 devices / 20 policies (workstation qty 8 @ 960 W not
  multiplied, fridge always_on); state before a run has nulls/empties with no
  invented zeros; `start {speed:60}` → seq 1 at `2025-12-31T18:30:00Z`; time
  advanced to `18:32:10Z`; pause froze time (two reads identical at
  `18:32:30Z`, seq 17); resume `{speed:10}` then speed `{speed:1000}`;
  light override on → 72 W `control_source override`, `clear_override` →
  `override null`, `control_source policy`; `reset` → new run id, seq 0,
  paused, previous run preserved in the database (lifecycle `ended`, seq 144,
  414 device + 115 room intervals incl. 18 `partial=1`, Σ 0.07733 kWh) while
  the new run stayed `active` seq 0; restart recovered the new run **paused**;
  IPC `"shutdown"` → `engine stopped and checkpointed` → `database closed`,
  **exit 0**; CORS preflight for a frontend POST → 204 with the right
  allow-origin/methods/headers. No process left running; ports free.
- Open defect LOCATED and REPRODUCED (not fixed, per assignment): after a
  calendar change in run A at `2025-12-31T19:34:00Z`, `reset` created run B
  starting `2025-12-31T18:30:00Z` which pinned and immediately applied
  `pol-office-hours:2` (+11 device-schedule v2 versions) although their
  `effective_from_utc` is 64 minutes later; all 72 of run B's persisted minutes
  reference `…:2` refs and run B pins no v1. Source: `src/engine/engine.ts:351-371`
  (`setCalendar`, effective = next minute of the run's own timeline),
  `src/db/runs.ts:20`/`:42-47` (`createRun` pins `current_policy_versions`
  with no run-relative baseline), `src/engine/engine.ts:630`/`:642-646`,
  `src/engine/constants.ts:13`, `src/db/inventory.ts:99`,
  `src/db/migrations/001_initial.ts:84`.
- Browser verification: NOT performed (no browser ability in session). CORS was
  verified server-side for a real GET and a POST preflight; a manual browser
  checklist is recorded in the K001 evidence document.
- Files changed: created `docs/K001_KISHORE_ONBOARDING_EVIDENCE.md`; updated
  `docs/HANDOFF.md`, `docs/ACTIVE_TASK.md`, this log. `data/` created locally
  and git-ignored. No source/contract change.
- Unresolved items: contract verifier 67/75 on this laptop (line endings);
  run-policy timing defect (open, required before historical-export
  acceptance); OS SIGINT/SIGTERM shutdown not exercised (IPC path verified);
  no browser confirmation of the P008 state additions.
- Review status: pending (no self-assigned approval). Commit references: the
  K001 commit recorded in the K001 return report after push.
- Next action: implement the run-policy timing correction (KISHORE_BACKEND_HANDOFF.md
  §6 / K001 evidence §11) as the next assigned K-layer, with the January-1-after-
  a-schedule-change regression test. Do not start Socket.IO, exports, comfort or
  other features until assigned.

---

## 2026-09-24 23:23:00 +05:30 (IST) — K002 completed (implemented)

- Assignment K002 (K1 — contract checkout portability and run-policy timing),
  Agent K — Kishore's coding agent, owner Kishore Kumar. Writes: backend
  implementation/tests/migrations/docs; frontend line-ending config + docs only.
  No contract, schema, fixture, Socket.IO, export or environment work. Mohan's
  three repos untouched.
- Git access: **write access now works**; K001's commits were published earlier
  this session (backend `1f43a5e`, frontend `f2cdffe`), `fetch` clean, no remote
  advancement, no force push/reset.
- Before: HEAD `f7b134b` (K001 line-ending commit), clean tree.
- (a) Line-ending portability: `core.autocrlf=true` confirmed from the **system**
  config (`file:C:/Program Files/Git/etc/gitconfig`); the verifier hashes raw
  bytes (`scripts/verify-contract.mjs`). Added `.gitattributes` (two rules:
  `contracts/v1/** text eol=lf`, `scripts/verify-contract.mjs text eol=lf`) to
  both simulator repos, then restored those paths from their exact blobs after
  confirming no edits would be lost (no broad reset/clean). Result: 0 CR bytes
  in both working trees and **75/75** in both repos; a **fresh temp clone** that
  inherits `core.autocrlf=true` also checked out 0 CR bytes and passed 75/75.
  Contract semantics, manifest and all eight hash checks unchanged. Same two
  rules recommended for `auditor-frontend`/`auditor-backend`/`energy-ml-service`
  (not modified).
- (b) Run-policy timing: forward migration `003_run_policy_activation` adds
  `run_policies.active_from_utc` (run-scoped activation) plus a `BEFORE INSERT`
  trigger rejecting a missing/malformed/non-calendar value. Design: keep
  `policy_versions.effective_from_utc` as the immutable **revision identity** and
  represent **activation within a run** in the run's frozen snapshot — a
  revision adopted at run creation activates at the run's start
  (`createRun`), a mid-run calendar/occupancy change at its minute boundary
  (`applyDuePending`/occupancy pin). `rebuildPolicies` resolves
  `device_schedule.office_hours_ref` to the office-hours revision pinned in this
  run, so a run's references and effective times agree with what it applied. No
  global revision is edited or minted to work around run timing.
- History: existing pins keep `NULL` (no backfill, rows immutable). Such runs
  are identified as `legacy_unrecorded` and validated against the global
  revision times; the test builds a genuine pre-K002 DB (migration 3 undone) with
  a consistent and an inconsistent legacy run and shows the bad one stays
  flagged/unsupported while the good one validates — `runMigrations` reports
  `{ applied: [3], currentVersion: 3 }` and nothing is rewritten or re-certified.
- Tests: added `test/policyTiming.test.ts` + `test/runDataset.ts` (contract
  1.0.1-shaped dataset built **in a test** from stored snapshots/readings, schema
  validated with the new `assertDataset`, then checked semantically: reference
  integrity, dependency resolution, no-policy-before-its-activation, key
  uniqueness, aligned grid, energy reconciliation). `test/db.test.ts` migration
  expectations updated to `{ applied: [1, 2, 3], currentVersion: 3 }`.
- Checks: `npm test` **61/61** (56 pre-existing + 5 new), `typecheck` 0,
  `lint` 0, `build` 0, `validate:schema` 24/24, `verify:contract` 75/75.
- Real HTTP (scratch DB `…\Temp\nexyra-k002\scratch.sqlite`, compiled build, port
  4173): run A `run-20260924T174514Z-e497fa98` started `18:30:00Z`;
  `POST /calendar` → applied, effective `2025-12-31T21:06:00Z`, 12 refs; run A
  kept v1 before it and v2 from it (`dev-open-ac` 21:05 `pol-open-ac:1`,
  21:06 `pol-open-ac:2`). `reset` → run B `run-20260924T174534Z-69d01154` at
  `18:30:00Z`; run B pinned `pol-office-hours:2`/`pol-open-ac:2` with
  `active_from_utc 2025-12-31T18:30:00Z` while their global
  `effective_from_utc` stayed `2025-12-31T21:06:00Z` — 0 pins without
  activation, 0 intervals applying a policy before its activation, 11/11
  dependent schedules resolving, no new revision minted (32 versions = 20 seeded
  + 12), and `dev-open-ac` 21:05/21:06/21:07 all `pol-open-ac:2`. Run A's 6102
  intervals unchanged. Restart on the same DB: recovered run B **paused** at
  `2025-12-31T20:26:30Z` (seq 701) with identical pins; resuming across 21:06
  minted nothing.
- Honest notes: the HTTP stop was a forced kill — Windows cannot deliver
  SIGTERM/SIGINT cross-process (the service documents an IPC `shutdown`
  mechanism instead); the graceful path is covered by the passing graceful
  shutdown test. **Browser verification still not performed** (no browser in
  this session). The export endpoint and `energy-ml-service` acceptance run were
  **not** built/run, so no Python acceptance is claimed.
- Files changed: new `src/db/migrations/003_run_policy_activation.ts`; modified
  `src/db/migrations/index.ts`, `src/db/runs.ts`, `src/engine/engine.ts`,
  `src/contract/validators.ts`, `test/db.test.ts`; new `test/policyTiming.test.ts`,
  `test/runDataset.ts`, `docs/K002_POLICY_TIMING_EVIDENCE.md`; updated
  `docs/SIMULATION_ENGINE.md`, `docs/KISHORE_BACKEND_HANDOFF.md`,
  `docs/ACTIVE_TASK.md`, `docs/HANDOFF.md`, this log. `.gitattributes` was
  already committed. No `.env`, DB, cache, dependency or build output committed.
- Processes: none remaining; port 4173 has no listener.
- Review status: pending (no self-assigned approval). Commit references:
  simulation-backend `26ba7174d7f0d5f55a6ca821e501bb5d2cef6d30` (pushed,
  local == origin/main).
- Next action: implement the historical export endpoint on top of the run-scoped
  activation (contract CSV/JSON), then validate a run's dataset against
  `energy-ml-service` `POST /v1/analyze`. Do not start Socket.IO, environment/
  comfort, faults or other features until assigned.

---

## 2026-09-25 02:41:16 +05:30 (IST) — K003 historical export implementation checkpoint (Kishore | K-A — OpenCode)

- Resumed clean deployment baseline `929e78e`; preserved K002/schema v3 and found
  no earlier K003 implementation. Ownership transfer is now recorded as
  Kishore | K-A — OpenCode.
- Added paginated run coverage plus strict GET/POST JSON/standalone-CSV export,
  per-request read-only WAL snapshots, run snapshots, K002 effective-time
  mapping, legacy rejection, exact aggregation/partial/gap rules, bounded
  streaming and format-independent content/selection identity.
- New focused tests plus regressions: **77/77**; typecheck, lint and build green;
  contract **75/75**; schema **24/24**.
- Real scratch HTTP export: 18 rows, `0.0027999999990000004` kWh. Pinned auditor
  `67998d5` pure parser/validator accepted JSON and CSV with zero errors and the
  same semantic fingerprint. Full auditor DB import is not claimed: isolated
  `better-sqlite3@13.0.3` native build could not find Python.
- No migration/dependency/lockfile/contract/production DB/deployment change.
  Local :19001 and frontend :3100 were stopped; ports clear. Evidence:
  `docs/K003_EXPORT_EVIDENCE.md`.
- Review pending. Exact next action: final docs/diff/staged review, all gates,
  normal commit/push and remote hash verification. Stop after K003; do not begin
  K004.
## 2026-09-25 02:35 +05:30 (IST) — K005-PREP started (branch `mohan/k005-history-prep`)

- Developer Mohan | M-C — Claude Code. Isolated worktree
  `K:/simulation-backend-k005` from `main` `929e78e` (== origin/main by
  ls-remote). Kishore's `main` working copy untouched.
- Context read: README, PROJECT_CONTEXT, WORKSPACE_MAP, HANDOFF,
  KISHORE_BACKEND_HANDOFF, SIMULATION_ENGINE, ACTIVE_TASK, this log,
  contracts/v1 CONTRACT/API; source for engine, runs, migrations, occupancy,
  schedule, scheduler, routes, tests. No AGENTS.md. No existing
  history/export implementation (routes: health, inventory, state, control,
  occupancy, calendar, devices).
- Previous outcome preserved in ACTIVE_TASK (K002 completed, review pending).

---

## 2026-09-25 03:15 +05:30 (IST) — K005-PREP implementation group 1 (engine batch mode, jobs, routes, tests)

- Branch-local migration `004_history_jobs` (history_jobs table; terminal rows
  final; trigger forbids an engine checkpoint for a batch run).
- `SimulationEngine` batch mode (`EngineOptions.batch`, `createBatchRun`):
  same `advanceSteps`/`stepOnce`; checkpoint redirected to a per-minute job
  progress update in the same transaction; interactive lifecycle and
  global-policy commands refused. Interactive config unchanged.
- `src/history/request.ts` (validation, Asia/Kolkata month windows),
  `src/history/service.ts` (one worker, bounded queue, chunked + yielding,
  verify-then-succeed, JOB_FAILED / JOB_INTERRUPTED), `src/routes/historyJobs.ts`
  (not mounted in app.ts — documented step).
- Existing tests adjusted only for the new migration number (db.test,
  policyTiming legacy rollback). Two runner defects found by the new tests and
  fixed before commit: a submit/settle race that could strand a queued job, and
  same-second FIFO ordering (now rowid).
- Checks: 79/79 tests (all files except `shutdown.test.ts`, blocked by VS Code
  holding port 19001), typecheck, lint, build clean, verify:contract 75/75,
  validate:schema pass.
- Next: representative month generation + evidence + docs.

---

## 2026-09-25 03:40 +05:30 (IST) — K005-PREP completed (branch preparation; review pending)

- Representative month (scratch DB, in-process harness on an ephemeral port,
  real HTTP): `{month:"2026-01", seed:20260101, occupancy:{scheduled, 14}}` →
  `succeeded`; 267,840 steps / 44,640 intervals; 803,520 device + 223,200 room
  rows, 0 partial; `2025-12-31T18:30:00Z`→`2026-01-31T18:30:00Z`; office
  1,331.376 kWh (rooms reconcile; cumulative mismatch ≤1.9e-10); fridge
  111.6 kWh = 150 W × 744 h; ≈208 s wall; memory point samples heap 18–36 MB /
  RSS 93–127 MB (not peaks); interactive checkpoint unchanged and recovery
  returned the interactive run.
- Evidence: `docs/K005_HISTORY_GENERATION_PREP_EVIDENCE.md` (interface,
  decisions, isolation, verification, suitability, K003/K004 integration).
- Added `scripts/k005-month-run.ts`. HANDOFF addendum added (branch-local).
- Not done: push/merge/deploy, export (K003), mounting in app.ts,
  shutdown.test.ts on this laptop (port 19001 held by VS Code).
- Next: review; integration steps in evidence §10. Stop after K005-PREP.

---

## 2026-09-25 03:55 +05:30 (IST) — K004-FAST1 takeover started (Mohan's laptop, worktree `K:/simulation-backend-k005`)

- Developer Mohan | M-C — Claude Code; previous assignee Kishore K-B — GLM-5.3.
- Observed on Mohan's laptop only: branch `mohan/k005-history-prep` at
  `0464c9a` (clean; K005 commits 1975c8d, 92aadd8, 0464c9a); remote
  simulation-backend has only `main` `929e78e`; remote simulation-frontend
  `main` `dbcbee9`. **No GLM/K004 work is reachable from this laptop** (no
  branch, bundle, worktree or handoff) — recorded, not reconstructed. This
  says nothing about the state of Kishore's laptop.
- Another agent's frontend worktree exists (`K:/NEXYRA/simulation-frontend-visual`,
  `mohan/sim-visual-01`) — not touched.
- Contract 1.0.1 already allows `interval_seconds` 3600 (no contract change).

---

## 2026-09-25 04:30 +05:30 (IST) — K004-FAST1 group 1: hourly recording + advance days (backend)

- Per-run recording interval 60 | 3600 s in immutable run config
  (`interval_seconds`, same key as before; 60 s runs byte-identical). Boundaries
  on the LOCAL clock (local minutes / local hours = UTC hh:30). Calendar changes
  take effect at the next recording boundary (one policy ref per interval).
- `POST /control/advance {days 1..31}` / `POST /control/advance/stop`: the
  existing WallClockScheduler at 86,400 sim-s per real second, clamped to the
  target, then paused; pause also stops; start/resume/reset refused during an
  advance; advance refused while the clock runs; `state.advance` shows
  processed vs expected steps and the last outcome. Not resumed after restart.
- History jobs accept `interval_seconds: 3600` (local-hour aligned);
  branch-local migration 005 rebuilds history_jobs to allow it (004 untouched).
- Tests: new `test/fast.test.ts` 13/13; total 92/92 (all files except
  shutdown.test.ts); typecheck/lint/build clean; schema 24/24; contract 75/75.

---

## 2026-09-25 05:15 +05:30 (IST) — K004-FAST1 completed (branch preparation; review pending)

- Measured (scratch DB, real createApp on an ephemeral port): 30-day hourly
  advance in 30.12 s wall (0.996 d/s), 259,200/259,200 steps, 12,960 device +
  3,600 room hourly intervals, 0 partial, energy reconciles within 2.4e-10 kWh;
  AC on/clear commands 200 in 7.2 ms and correctly reflected in the affected
  hours (39 min → 0.975 kWh); /health median 6 ms (max 64.9) while advancing;
  memory point samples heap ≤41 MB, RSS ≤121 MB (not peaks).
- Frontend branch `mohan/k004-fast1-controls` `ebdfdb4`: FastDaysPanel +
  adapters, 27/27 tests, build clean; real-HTTP adapter check against this
  branch passed (advance/stop/409/hourly Feb job 672/672, interactive time
  unchanged). Browser not verified.
- shutdown.test.ts not rerun (port 19001 held by VS Code; no isolated
  environment). GLM work unavailable on this laptop; not reused.
- Evidence: docs/K004_FAST1_TAKEOVER_EVIDENCE.md; K005 evidence addendum §12.
- Next: transfer bundles (`K:/k004-fast1-transfer/`) → K-A integration.

---

## 2026-09-25 (IST) — Merge of `mohan/k005-history-prep` into `main` (Mohan | M-C — Claude Code)

- At Mohan's request, merged K005-PREP + K004-FAST1 on top of K003 (`5cb824d`).
  Conflicts only in ACTIVE_TASK/PROGRESS_LOG (both histories kept).
- Integration: history router mounted via `createApp({history})`; history
  worker started/stopped in `server.ts`; K003 export refuses non-succeeded
  history-job runs and hourly-recorded runs (409); new
  `test/integration.k005.test.ts`.
- Checks: 110/110 tests (excl. shutdown.test.ts — port 19001 held by VS Code
  on Mohan's laptop), typecheck/lint/build, schema 24/24, contract 75/75.
- Remaining: hourly export support; K004 climate model reconciliation;
  browser verification; review pending.
