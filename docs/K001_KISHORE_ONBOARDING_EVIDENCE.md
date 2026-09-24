# K001_KISHORE_ONBOARDING_EVIDENCE — simulation-backend

Assignment **K001** (previously issued as **P018**; renamed before execution).
Agent: **K — Kishore's coding agent**. Layer: **K0 — Setup and onboarding**.
Owner: **Kishore Kumar**. Date: 2026-09-24 (Asia/Kolkata).

Task status: **completed** (setup, onboarding and baseline verification).
Review status: **pending** — no approval is claimed here.

Scope: setup, reading, verification and documentation only. **No application
source, migration, contract, schema, seed or lockfile was changed.** No
remaining simulator feature was started, and the known policy-timing defect
was **not** fixed (reproduced and recorded only, §11).

---

## 0. Renaming continuity (P018 → K001)

- This assignment was issued as `P018` and renamed to `K001` **before it ran**.
  Its task is unchanged and it was not run twice.
- Verified before starting: `grep -i "P018\|K001"` over `docs/` and `README.md`
  in **both** simulator repositories returned **no matches**. No P018 record
  existed in `ACTIVE_TASK.md`, `PROGRESS_LOG.md`, `HANDOFF.md`, evidence
  filenames or commit messages, so no "P018 renamed to K001" progress-log
  amendment was needed and no history was rewritten.
- This is the first K-prefixed assignment recorded in this repository.

## 1. This laptop (evidence, not a required path)

- Absolute workspace: `C:\Users\kdon7\Desktop\react\hackthon`
  (parent folder, **a plain folder, not a Git repository**).
- Repository path: `C:\Users\kdon7\Desktop\react\hackthon\simulation-backend`.
- OS/shell: Windows 11 build 26200 (`MINGW64_NT-10.0-26200`, host `GEORGIA`),
  Git Bash `/usr/bin/bash` (MSYS2). Mohan's `K:\NEXYRA` path does **not**
  exist here and was not assumed.
- No `AGENTS.md` at the parent or in this repository (recorded, as the
  continuity protocol requires).
- The parent folder already contains all five NEXYRA repositories. The three
  Mohan-owned ones (`auditor-frontend`, `auditor-backend`,
  `energy-ml-service`) were **not** cloned, fetched, built, migrated, seeded
  or run, and were left completely untouched.

## 2. Repository reuse and Git state

The target folder already existed as the correct repository, so it was
**reused, not re-cloned** (no `git init`, no overwrite, no re-initialisation).

| Item | Value |
|---|---|
| origin | `https://github.com/NEXYRA-Techy-Panda/simulation-backend.git` |
| branch | `main` |
| HEAD (before and after this task's code checks) | `12c380022cbe5ad813309f29ca4c61fbf6099580` |
| reported P010 handoff baseline | `12c380022cbe5ad813309f29ca4c61fbf6099580` — **identical** |
| latest source commit (documented) | `6d2630973139c5612d4e8c78cd928bc994ae2ca0` (P008), still reachable; nothing downgraded |
| `git fetch --all` | clean, no new refs |
| `ls-remote --heads origin` | `12c3800…` — matches local HEAD |
| fast-forward needed | no (local already equal to remote) |
| working tree | clean before, during and after all checks; no stash, no reset |
| repo-local identity | `Kishorekumar5567 <kkishorekumarkannan@gmail.com>` (Kishore's; Mohan's identity was **not** copied) |

## 3. Runtime and toolchain (actual, this laptop)

| Check | Result | Verdict |
|---|---|---|
| `git --version` | `2.55.0.windows.4` | adequate |
| `node --version` | `v24.19.0` | satisfies `engines: node >=24.0.0` and `.nvmrc` (`24`) |
| `npm --version` | `11.17.0` | adequate |
| `node:sqlite` availability | `DatabaseSync, StatementSync, Session, constants, backup` | **present** — the driver this backend needs |
| ports 3000 / 4000 | no listeners before and after every check | free |

- `npm ci` was used (a valid `package-lock.json` is committed). Result: install
  succeeded, `found 0 vulnerabilities`.
- **Warning (not a failure):** npm 11 blocks unapproved install scripts and
  reported `esbuild@0.28.2 (postinstall: node install.js)` as not run. `tsx`
  was verified to work anyway (`tsx v4.23.15`) because the platform package
  `@esbuild/win32-x64` is present. No dependency was upgraded, no lockfile was
  regenerated, and no install script was approved.

## 4. Configuration and setup performed

- `.env.example` and a local `.env` both exist and are **identical**; `.env` is
  git-ignored (`git check-ignore` confirms `.gitignore:9:.env`).
  Keys: `PORT=4000`, `HOST=127.0.0.1`, `FRONTEND_ORIGIN=http://localhost:3000`,
  `JSON_BODY_LIMIT=100kb`, `SHUTDOWN_TIMEOUT_MS=10000`,
  `DATABASE_PATH=data/simulation.sqlite`, `SQLITE_BUSY_TIMEOUT_MS=5000`.
  No real environment file was committed and no secret exists in either file.
- Real environment variables take precedence over `.env`; all checks below
  exported their own `DATABASE_PATH`/`PORT` explicitly.
- Commands used (from the repository root, Git Bash):

```sh
npm ci
npm run db:setup          # = db:migrate + db:seed (idempotent)
npm run typecheck
npm run lint
npm test
npm run build
npm run verify:contract
npm run validate:schema
node dist/server.js       # with an explicit DATABASE_PATH
```

## 5. Handoff and context material read (complete)

Both repositories: `README.md`, `docs/PROJECT_CONTEXT.md`,
`docs/WORKSPACE_MAP.md`, `docs/HANDOFF.md`, `docs/ACTIVE_TASK.md`,
`docs/PROGRESS_LOG.md`, `docs/AGENT_START_PROMPT.md`.
This repository: `docs/KISHORE_BACKEND_HANDOFF.md`, `docs/SIMULATION_ENGINE.md`,
`docs/P002_F3_S_EVIDENCE.md`, `docs/P004_K1_EVIDENCE.md`,
`docs/P008_K3_K4_EVIDENCE.md` (the P008 occupancy/schedule evidence — actual
filename located, not assumed).
Shared contract: `contracts/v1/CONTRACT.md`, `contracts/v1/API.md`,
`contracts/v1/CSV_COLUMNS.md`, `contracts/v1/dataset.schema.json` (and the
fixtures/manifest as needed; the verifier reads them).
Frontend side: `docs/KISHORE_FRONTEND_HANDOFF.md`,
`docs/P009_K1_UI_EVIDENCE.md`, `docs/P005_S10_A_EVIDENCE.md`.

## 6. Database setup and isolation

- The configured database (`data/simulation.sqlite`) **did not exist** before
  this task (no `data/` directory), so no existing data could be overwritten
  and nothing was reset or deleted.
- `npm run db:setup` run **twice** on the default dev database:

| Run | Result |
|---|---|
| 1st | `applied migrations: 1, 2`; `schema version: 2`; seeded buildings 1, rooms 5, devices 18, policies 20, policy_versions 20 |
| 2nd | `db:migrate` → no pending migrations; `db:seed` → **inserted 0, already present 5/18/20/20**; totals unchanged |

  → the migration/seed workflow is confirmed **idempotent and
  non-destructive**. `data/` and its WAL/SHM sidecars are git-ignored.
- **All mutation/integration checks used separate scratch databases outside the
  repositories**, in this laptop's temp area:
  `…\AppData\Local\Temp\nexyra-k001\scratch.sqlite` (API/HTTP checks) and
  `…\Temp\nexyra-k001\scratch-defect.sqlite` (defect reproduction). The default
  dev database was not used for mutations and no SQLite file was committed.

## 7. Baseline verification (actual results)

Executed in this repository on 2026-09-24, with real exit codes (`| tail`
pipelines were avoided when reading exit status):

| Command | Result | Exit |
|---|---|---|
| `npm run verify:contract` | **67 passed, 8 failed** — see §8 | **1** |
| `npm run validate:schema` | 24 passed, 0 failed (Ajv, 2020-12 strict) | 0 |
| `npm run typecheck` | no diagnostics | 0 |
| `npm run lint` | no diagnostics | 0 |
| `npm test` | **56 passed, 0 failed** (22 suites, ~28 s) | 0 |
| `npm run build` | `tsc -p tsconfig.build.json` | 0 |

## 8. MISMATCH FOUND (recorded, not fixed): contract verifier 67/75 on this laptop

The handoff reports 75/75 in all five repositories. On this laptop the same
script reports **67 passed, 8 failed**, and the 8 failures are all of one kind:

```text
FAIL  hash match: contracts/v1/CONTRACT.md      — got 8ace88af4188… want 4ae81886e46c…
FAIL  hash match: contracts/v1/dataset.schema.json — got 92b5d9f3b332… want c995aac6aeca…
FAIL  hash match: contracts/v1/CSV_COLUMNS.md   — got 959ea8106664… want 53ac7f00d642…
FAIL  hash match: contracts/v1/API.md           — got a6ebdfb690e0… want 53bc0a2acba0…
FAIL  hash match: contracts/v1/fixtures/reference.json — got bc459831cdbb… want dee245eb5b3c…
FAIL  hash match: contracts/v1/fixtures/reference.csv  — got fac288752441… want 330afb90adc1…
FAIL  hash match: contracts/v1/fixtures/expected.json  — got aab5c423149e… want 10bfe4e7323f…
FAIL  hash match: scripts/verify-contract.mjs   — got ffb9ea2380eb… want 5f1df643a6b8…
RESULT: 67 passed, 8 failed.
```

**Cause (proven, not guessed):** this clone has `core.autocrlf=true` and there
is no `.gitattributes`, so Git checked the LF blobs out with CRLF line endings.
The verifier hashes **raw bytes** (`scripts/verify-contract.mjs:41`,
`createHash('sha256').update(readFileSync(p))`), so a CRLF checkout cannot match
the LF manifest hashes.

- Evidence — CR characters present: `CONTRACT.md` 364, `API.md` 191,
  `reference.csv` 5, `verify-contract.mjs` 374 (one per line).
- Evidence — hash experiment:

  | File | raw sha256 | LF-normalised sha256 | manifest "want" |
  |---|---|---|---|
  | `contracts/v1/API.md` | `a6ebdfb690e0` (= "got") | `53bc0a2acba0` | `53bc0a2acba0` |
  | `contracts/v1/fixtures/reference.csv` | `fac288752441` (= "got") | `330afb90adc1` | `330afb90adc1` |

  Stripping CR reproduces the manifest hashes **exactly**, so all 67 semantic
  checks passing plus these 8 byte-identity failures means the contract content
  is correct and byte-identical modulo line endings.

**Classification:** a clone/line-ending configuration condition on this
Windows laptop, **not** a source or contract defect. It was **not** fixed in
K001 (setup-only task; no repo file, `.gitattributes` or git config was
changed). Suggested remediation for a later assigned task (choose one, then
re-run and expect 75/75):

1. repo-local `git config core.autocrlf false` followed by a clean re-checkout
   of the affected paths; or
2. add `.gitattributes` with `* text=auto eol=lf` to the contract-owning
   repositories (a shared-contract mirror change, coordinated with Mohan) and
   re-clone.

Until then, treat `verify:contract` on this laptop as "67 semantic checks pass
+ 8 line-ending-sensitive manifest hashes fail", and never weaken the verifier
to accommodate it.

## 9. Live HTTP verification (compiled build, port 4000, scratch database)

Server: `node dist/server.js` with `DATABASE_PATH` pointing at the scratch
database, `PORT=4000`, `HOST=127.0.0.1`, `FRONTEND_ORIGIN=http://localhost:3000`.
Log confirmed: `database …scratch.sqlite: schema v2` →
`simulation-backend listening on http://127.0.0.1:4000`.

| # | Check | Actual result |
|---|---|---|
| 1 | `GET /api/v1/health` with `Origin: http://localhost:3000` | `200`, `Access-Control-Allow-Origin: http://localhost:3000`, body `{"status":"not_initialized","run_id":null,"sim_time_utc":null,"contract_version":"1.0.1"}` |
| 2 | `GET /api/v1/inventory` | rooms **5** (manager 2, meeting 6, open-workspace 12, pantry 4, reception 2), devices **18**, policies 20; workstation `quantity 8`, `nominal_power_w 960` (**not** multiplied); fridge `always_on true`, `control always_on` |
| 3 | `GET /api/v1/state` before any run | `not_initialized`, `speed 1`, `run_id null`, `seq null`, `sim_time_utc null`, empty `rooms`/`devices`, `office null`, `occupancy null`, `calendar null` — **no zeros invented for missing data** |
| 4 | `POST /api/v1/control/start {"speed":60}` | `200`, new run `run-20260924T171735Z-b7b9200f`, `seq 1`, `sim_time_utc 2025-12-31T18:30:00Z`, `status running` |
| 5 | advance ~2 s real at 60× | `seq 14`, `sim_time_utc 2025-12-31T18:32:10Z`, occupied 0, office 168 W, 0.006067 kWh — time advanced from **processed** time |
| 6 | `POST /api/v1/control/pause`, two `GET /state` 2 s apart | `paused`, `T1 = T2 = 2025-12-31T18:32:30Z`, `seq 17` both — simulated time **frozen** |
| 7 | `POST /api/v1/control/resume {"speed":10}` then `POST /api/v1/control/speed {"speed":1000}` | `running` at `speed 10`, then `{"speed":1000}` |
| 8 | `POST /api/v1/devices/dev-meeting-light {"manual_state":"on"}` | `200`, `override {active:true,on:true}`, `on true`, `72 W`, `control_source "override"` |
| 9 | `POST … {"clear_override":true}` | `200`, `override null`, `control_source "policy"`, `on false` (policy: room vacant and past closing) — control returned to policy, not to a "base state" |
| 10 | `POST /api/v1/control/reset` | `200`, **new** run id `run-20260924T171742Z-5eba1a6f`, `seq 0`, `paused`, initial time |
| 11 | old-run history preserved | DB readback: run 1 lifecycle **`ended`**, `seq 144`, **414 device intervals + 115 room intervals** (18 of them `partial=1`, the edge interval published by reset), Σ 0.07733 kWh; run 2 lifecycle `active`, `seq 0`, 0 intervals; both runs pin 20 policies |
| 12 | restart recovery | server restarted against the same scratch database logged `recovered run run-20260924T171742Z-5eba1a6f at 2025-12-31T18:30:00Z (seq 0) as paused` |
| 13 | graceful shutdown (IPC path) | `shutdown message received; closing server` → `engine stopped and checkpointed` → `database closed; exiting`, **child exit code 0** |
| 14 | CORS preflight for a real frontend command | `OPTIONS /api/v1/control/start` with `Origin` + `Access-Control-Request-Method: POST` → **204**, `Access-Control-Allow-Origin: http://localhost:3000`, `Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE`, `Allow-Headers: content-type` |
| 15 | ports after all checks | no `LISTENING` socket on 4000 (only `TIME_WAIT` from the finished requests); no process left running |

Observed behaviour worth recording for the frontend (not a defect, but answers
open P009 questions): a `reset` **keeps the previous run's speed** (the reset
response reported `speed 1000` after the earlier `speed` command), and
`resume {"speed":…}` is accepted while `clear_override` on a policy-controlled
light returns it to the policy state.

## 10. Browser verification: NOT performed

No browser automation ability existed in this session, so **browser
interaction remains unverified** — SSR HTML and successful `curl` calls are not
proof of browser behaviour. What was verified server-side: real CORS headers for
both a GET and a POST preflight from `http://localhost:3000`.

Manual browser checklist for Kishore (frontend on 3000, backend on 4000):

1. Load `http://localhost:3000` with no run: page renders, connection panel
   shows reachable but not-ready, clocks show "No simulation started", **no
   zero energy invented**.
2. Press Start at 60×: both clocks advance and show the **same** instant in
   Asia/Kolkata; office/room/device readings update.
3. Pause: both clocks freeze. Resume: they advance again. Change speed: the
   reported speed changes.
4. Toggle the meeting-room light on, then clear: the authoritative refetch
   shows the override disappearing and the policy state returning.
5. Reset: a new run id appears and the displayed state restarts at 01 Jan 2026
   00:00 IST.
6. Stop the backend and confirm the UI shows a stale/unreachable state (never
   zero energy, never fake green); restart the backend and confirm recovery.
7. Check keyboard access (room list/selection, controls) and a narrow window
   layout.

## 11. Open policy-timing defect — located, reproduced, NOT fixed

**Status: open.** Per `docs/KISHORE_BACKEND_HANDOFF.md` §6 this is required
before final historical-export acceptance and is **not** an accepted
limitation. K001 did **not** patch it and did not change policy history.

Relevant documentation (all pre-existing): `docs/KISHORE_BACKEND_HANDOFF.md`
§6, `docs/SIMULATION_ENGINE.md` ("Calendar changes and historical
correctness" → the run-created-later limitation), `docs/HANDOFF.md` (P010
addendum), `docs/ACTIVE_TASK.md` (open-blocker section),
`docs/P008_K3_K4_EVIDENCE.md` (Limitations).

Likely affected source (located, unchanged):

| Location | Role in the defect |
|---|---|
| `src/engine/engine.ts:351-371` (`setCalendar`) | mints new policy versions with `effective_from_utc = toUtc(nextMinute(run.simEpoch))` — a **simulated-time stamp from the current run's timeline** (`:356-357`; versions added at `:362` office-hours and `:370` device schedules) |
| `src/db/runs.ts:20` (`createRun`), `:42-47` | pins the **latest** versions (`current_policy_versions` → `run_policies`) for the new run; no run-relative activation baseline is recorded and no effective time is rebased |
| `src/engine/engine.ts:630` (`createNewRun`), `:642-646` | creates every new run with `run_start_utc = INITIAL_SIM_TIME_UTC` |
| `src/engine/constants.ts:13` | `INITIAL_SIM_TIME_UTC = '2025-12-31T18:30:00Z'` — always earlier than a later-timeline change in a previous run |
| `src/db/inventory.ts:99` (`addPolicyVersion`) | inserts the version with the caller-supplied `effective_from_utc`, append-only |
| `src/db/migrations/001_initial.ts:84` | `effective_from_utc` stored on `policy_versions`; `run_policies` has no run-relative column |

**Reproduction on this laptop** (scratch database
`…\Temp\nexyra-k001\scratch-defect.sqlite`, compiled build, port 4000):

```text
run A: start {"speed":1000,"seed":2026}      -> run-20260924T171930Z-d2bce016, seq 1, 2025-12-31T18:30:00Z
run A advances (3 s real at 1000x)           -> 2025-12-31T19:27:00Z, seq 343
POST /calendar {working_days:[1..5], open 08:30, close 17:30}
                                             -> 200, applied false,
                                                effective_sim_utc 2025-12-31T19:34:00Z,
                                                12 new policy refs (office-hours + 11 device_schedule)
run A continues                              -> 2025-12-31T19:42-ish
POST /control/reset                          -> run B run-20260924T171937Z-3a628bdc, seq 0, paused,
                                                sim_time_utc 2025-12-31T18:30:00Z
POST /control/resume {"speed":1000}; pause   -> run B at 2025-12-31T19:42:10Z, seq 435
```

Database readback of the two runs:

```text
run run-20260924T171930Z-d2bce016  start 2025-12-31T18:30:00Z
   office-hours pins: v1@2000-01-01T00:00:00Z , v2@2025-12-31T19:34:00Z
   dev-open-ac intervals: 123  first 2025-12-31T18:30:00Z  last 2025-12-31T20:32:00Z
   refs used: pol-open-ac:1 x64 from 2025-12-31T18:30:00Z | pol-open-ac:2 x59 from 2025-12-31T19:34:00Z  (…same pattern for every schedule device)

run run-20260924T171937Z-3a628bdc  start 2025-12-31T18:30:00Z
   office-hours pins: v2@2025-12-31T19:34:00Z        <-- only v2; no v1 pin at all
   dev-open-ac intervals: 72  first 2025-12-31T18:30:00Z  last 2025-12-31T19:41:00Z
   refs used: pol-open-ac:2 x72 from 2025-12-31T18:30:00Z | pol-open-workstations:2 x72 from 18:30:00Z | …
```

**Interpretation:** run B started at `18:30:00Z` and applied `pol-office-hours:2`
and the 11 `…:2` device-schedule versions whose `effective_from_utc` is
`19:34:00Z` — **64 minutes after run B's first interval**. Every one of run B's
72 persisted minutes therefore references a policy version that was not yet
effective at the interval's own time, and run B has **no pin for v1**, so an
export cannot represent what was actually applied from its start. Run A's
history is correct and untouched (v1 for 64 minutes, v2 from `19:34:00Z`).

**Downstream effect (documented, consistent with this reproduction):**
`energy-ml-service` `POST /v1/analyze` rejects input where a policy is applied
before its effective time, so exports of such runs cannot currently be
analysed.

Required future resolution (unchanged from the handoff): define a run-scoped
activation baseline (or mint run-start versions whose `effective_from_utc`
equals the new run's start), preserve prior-run history, make exported
effective times agree with actual application, and add a regression test that
starts a new 1 January run after a prior schedule change.

## 12. Other blockers and mismatches

1. **Contract verifier 67/75 on this laptop** (§8) — line endings, not source;
   needs a decision from the contract owner.
2. **No browser verification** (§10) — frontend/backend behaviour is verified
   over real HTTP only.
3. **OS-signal shutdown not exercised.** Ctrl+C/SIGINT and Linux SIGTERM were
   not tested (no interactive console here); the supported IPC path was
   verified end-to-end with **exit code 0**. SIGTERM should be verified on the
   VPS at deployment.
4. Documented and accepted: crash loss under one simulated minute; constant
   synthetic climate (26 °C / 55 % RH) with no AC comfort model; everyone
   arrives at opening; new runs always start 2026-01-01; occupancy/calendar/
   device commands need an existing run (409 → `reset` to create a paused one).
5. The frontend was originally integrated against the earlier P004 state shape.
   The P008 additions (occupancy/calendar/overrides/pending changes) are
   present in `GET /state` and were exercised over HTTP here, but **no
   frontend page was loaded in a browser to confirm it tolerates them** — this
   stays open for §10's checklist.
6. `npm 11` blocked the `esbuild` postinstall script (§3) — cosmetic; `tsx`
   works.

## 13. Ownership boundary with Mohan

- **Kishore Kumar (Agent K)** owns `simulation-backend` and
  `simulation-frontend` only.
- `auditor-frontend`, `auditor-backend` and `energy-ml-service` belong to
  Mohan; they were not touched. The shared contract
  (`contracts/v1/**`) is mirrored into all five repositories and is
  **read-only** here — it was not edited, and the verifier was not edited
  either.
- `localhost` means this laptop: Mohan's `localhost:4000` is not reachable from
  here. The simulator pair runs locally on this machine with the backend on
  4000 and the frontend on 3000.

## 14. Exact next action

`Implement the run-policy timing correction described in §11 (and
KISHORE_BACKEND_HANDOFF.md §6) as the next assigned K-layer, including the
January-1-after-a-schedule-change regression test — no other simulator feature
until that is assigned.` In parallel, the §8 line-ending decision and the §10
manual browser checklist need a decision from Mohan/Kishore; both are reported,
neither is silently fixed.

## 15. Processes, ports and restart commands

- No process was left running. No foreign process was ever killed. Ports 3000
  and 4000 have no `LISTENING` socket at the end of this task.
- The scratch databases in this laptop's temp area remain for inspection
  (`…\Temp\nexyra-k001\scratch.sqlite`, `scratch-defect.sqlite`, plus WAL/SHM
  sidecars because the servers were stopped without the IPC shutdown path on
  the later runs). They are outside both repositories; delete them whenever
  convenient.
- To restart the simulator pair on this laptop:

```sh
# terminal 1 — backend
cd <parent>/simulation-backend
npm run db:setup      # idempotent; safe to repeat
npm run dev           # http://localhost:4000

# terminal 2 — frontend
cd <parent>/simulation-frontend
npm run dev           # http://localhost:3000
```

`.env` values for the pairing are already in place (`PORT=4000`,
`FRONTEND_ORIGIN=http://localhost:3000`, `NEXT_PUBLIC_SIMULATION_BACKEND_URL=http://localhost:4000`).

## 16. Files changed by K001

- Created: `docs/K001_KISHORE_ONBOARDING_EVIDENCE.md` (this file).
- Updated: `docs/HANDOFF.md`, `docs/ACTIVE_TASK.md`, `docs/PROGRESS_LOG.md`.
- **Unchanged:** all `src/**`, `test/**`, `contracts/**`, `scripts/**`,
  `package.json`, `package-lock.json`, migrations and seeds. `data/` (local dev
  database) was created and remains git-ignored.
