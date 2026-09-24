# K002_POLICY_TIMING_EVIDENCE — simulation-backend

Assignment **K002**. Agent: **K — Kishore's coding agent**. Layer:
**K1 — Policy timing and checkout portability**. Owner: **Kishore Kumar**.
Date: 2026-09-24 (Asia/Kolkata).

Task status: **completed** (both workstreams — contract checkout portability and
run-policy timing).

Review status: **pending** — no approval is claimed here.

This document is evidence, not a completion claim for the simulator or the
export pipeline. Historical export is still **not implemented**, browser
verification was **not** possible in this session, and review remains pending.

---

## 1. Git access status

| Item | simulation-backend | simulation-frontend |
|---|---|---|
| origin | `https://github.com/NEXYRA-Techy-Panda/simulation-backend.git` | `https://github.com/NEXYRA-Techy-Panda/simulation-frontend.git` |
| branch | `main` | `main` |
| `git fetch` | clean, no new refs | clean, no new refs |
| repo-local identity | `Kishorekumar5567 <kkishorekumarkannan@gmail.com>` | same |
| K001 local commits | `1f43a5e951d8e188f26bef9926cb9ffa552d6a0d` | `f2cdffe8afb84767241d787fc912ce6d59dd465b` |
| write access | **works** (K001 was pushed this session) | **works** |

Write access is now granted: the previously blocked K001 commits were pushed
normally, and `origin/main` equals local `main` in both repositories. No force
push, reset, branch-protection change or history rewrite was performed. No
token or credential was requested from anyone, and authentication was not
retried in a loop.

K001 commit hashes were verified rather than assumed; no newer remote work was
overwritten.

---

## 2. Contract checkout portability (LF) — fixed

### 2.1 Confirmed diagnosis

- Git stores the canonical contract blobs with **LF** endings; the manifest
  hashes are the hashes of those raw bytes.
- The verification script hashes files **as raw bytes**:
  `scripts/verify-contract.mjs` — `sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex')`.
- On this laptop `core.autocrlf=true` comes from the **system** Git config
  (`git config --show-origin --get core.autocrlf` →
  `file:C:/Program Files/Git/etc/gitconfig`), and **neither repository had a
  `.gitattributes`** before K002. So an ordinary Windows checkout converted
  `contracts/v1/**` and `scripts/verify-contract.mjs` to CRLF and 8 manifest
  `hash match:` checks failed (K001 observed 67/75), even though the content was
  otherwise identical.

### 2.2 Fix

Added `.gitattributes` to **both** simulator repositories, merging (there were
no pre-existing attributes to overwrite) and pinning LF for exactly the two
hashed path sets:

```gitattributes
contracts/v1/** text eol=lf
scripts/verify-contract.mjs text eol=lf
```

Deliberately **not** done: no global Git configuration change, no repo-wide
normalisation of ordinary source/documentation files, no change to contract
semantics, no manifest regeneration, no byte normalisation inside the verifier,
and no weakening or removal of any hash check. These attributes are repository
checkout configuration, **not** a contract version; the shared schema, fixtures
and version are untouched.

The affected paths were re-checked out from their **exact** blobs after
confirming they had no task/user edits to lose
(`rm -rf contracts/v1; rm -f scripts/verify-contract.mjs; git checkout --
contracts/v1 scripts/verify-contract.mjs`) — a targeted restore, not a broad
`reset`/`clean`/discard.

### 2.3 Verification

| Check | simulation-backend | simulation-frontend |
|---|---|---|
| working tree: CR bytes under `contracts/v1` + `scripts/verify-contract.mjs` | **0** (9 files) | **0** (9 files) |
| `npm run verify:contract` | **75 passed, 0 failed** | **75 passed, 0 failed** |
| manifest hashes match the canonical bytes | yes (all 8) | yes (all 8) |
| fresh temporary clone (`core.autocrlf=true` inherited from the system config) | 0 CR bytes, **75/75** | 0 CR bytes, **75/75** |

The fresh-clone test was re-run for K002: both repositories were cloned into the
OS temp area, each clone reported `core.autocrlf = true` from
`file:C:/Program Files/Git/etc/gitconfig`, still checked out 0 CR bytes across
the hashed paths, and passed 75/75.

### 2.4 Recommendation for Mohan's mirrors (NOT modified here)

`auditor-frontend`, `auditor-backend` and `energy-ml-service` mirror
`scripts/verify-contract.mjs` and `contracts/v1/**` identically, so they have
the same portability issue on a CRLF-capable checkout. They should adopt the
same two `.gitattributes` rules. Those repositories belong to Mohan's agents and
were **not** touched.

---

## 3. The original policy-timing defect (reproduced first)

**Before state.** The engine's own regression test
(`test/policyTiming.test.ts`, the defect it guards) reproduces it exactly:

```text
run A:  start 2025-12-31T18:30:00Z
        advance to 2025-12-31T20:09:50Z (one step before a minute boundary)
        POST /calendar -> applied false, effective 2025-12-31T20:10:00Z,
                          12 new refs (pol-office-hours + 11 device_schedule)
        advance 1 step -> the change activates at 20:10:00Z in run A
        run A pins: pol-office-hours v1 active/effective 2000-01-01T00:00:00Z
                    pol-office-hours v2 active/effective 2025-12-31T20:10:00Z
reset -> run B: start 2025-12-31T18:30:00Z  (100 minutes BEFORE 20:10:00Z)
        BEFORE: run B pinned only pol-office-hours:2 / 11 …:2 schedules whose
        global effective_from_utc is 2025-12-31T20:10:00Z — 100 minutes after
        run B's first interval — while applying them from that first interval,
        and run B pinned no v1 at all.
```

K001 recorded the same defect live (run A change effective
`2025-12-31T19:34:00Z`; run B starting `2025-12-31T18:30:00Z` applied it for
64 minutes before that timestamp and pinned no earlier version). The cause is
that `run_policies` recorded only `(run_id, policy_id, version)` while
`policy_versions.effective_from_utc` is a **global, run-relative** stamp minted
on whichever run created the revision.

---

## 4. Design: run-scoped activation

Two different things shared the word "effective"; K002 separates them.

| Concept | Column | Meaning |
|---|---|---|
| **Revision identity** | `policy_versions.effective_from_utc` | When this immutable configuration revision was created on the global revision history (which run's timeline produced it). Immutable — never edited retroactively. |
| **Run-scoped activation** | `run_policies.active_from_utc` (new) | The instant, **on this run's timeline**, from which the pinned revision governed the run. |

Exact activation semantics:

- Every revision adopted when a run is **created** activates at the run's start
  (`active_from_utc = run_start_utc`). A run's configuration baseline is its
  start, so its activation metadata agrees with its actual behaviour.
- A revision minted **mid-run** by a calendar (`setCalendar`) or occupancy-mode
  change activates at the minute boundary where it takes effect.
- Re-pinning the same revision within a run is a no-op (`ON CONFLICT DO NOTHING`),
  so a pin's activation is set once and never moves.
- Run-specific activation is represented in the run's **frozen policy
  snapshot** (`run_policies`), which is where the existing model already keeps
  run-specific policy facts. No immutable global revision was rewritten and no
  global revision is minted merely to work around run timing.

`active_from_utc` deliberately carries the **revision identity unchanged**: for
run B in the reproduction, `pol-office-hours:2` keeps global
`effective_from_utc = 2025-12-31T20:10:00Z` (revision identity) while
`active_from_utc = 2025-12-31T18:30:00Z` (run B's start).

### 4.1 Consumers inspected and updated

| Consumer | Change |
|---|---|
| Run creation — `src/db/runs.ts` (`createRun`) | inserts `active_from_utc = run_start_utc` for every pinned revision |
| Mid-run pinning — `src/engine/engine.ts` (`pin`, `applyDuePending`, occupancy mode change) | records the activation that actually applied (the due change's boundary / the run's current simulated instant) |
| Schedule evaluation — `rebuildPolicies` | resolves `device_schedule.office_hours_ref` against the office-hours revision **pinned in this run**; the global revision is used only when nothing is pinned (legacy runs) |
| Interval persistence | unchanged: `policy_ref` still records the exact `(policy_id, version)` applied, and that version is always pinned in the same run |
| Snapshot readers / recovery | unchanged format (checkpoint format 2); the pins live in `run_policies`, so applied and pending policies survive a restart identically |

### 4.2 Safety net

Migration 003 also installs a `BEFORE INSERT` trigger that rejects a `NULL`,
malformed or non-UTC-calendar `active_from_utc`, so the guarantee cannot be
silently lost by a new insert path. (Historical rows keep `NULL`, §6.)

---

## 5. Policy dependency handling

`device_schedule` revisions carry `office_hours_ref = "<policy_id>:<version>"`.
After K002:

- The reference always resolves to an office-hours revision **pinned in the same
  run** — the run-scoped one — never to a global revision that the run has not
  adopted. `rebuildPolicies` keeps a map of the office-hours revisions pinned in
  this run and resolves through it.
- A calendar change mints the office-hours revision **and** a new version of
  every `device_schedule` that references it (unchanged behaviour), and both are
  pinned together with the same run-scoped activation.
- Verified live: in run B all **11** dependent `device_schedule` revisions
  resolve to the pinned `pol-office-hours:2`; the contract-shaped dataset built
  from the run's own snapshots has no unresolved `office_hours_ref`.

---

## 6. Previous run history, and how invalid old runs are treated

- The migration only **adds a column** (`ALTER TABLE run_policies ADD COLUMN`).
  Existing pins get `NULL`, which means "run-scoped activation was not
  recorded". Rows are immutable, so **nothing is backfilled** — no version, pin,
  interval or reading of any pre-K002 run is changed or re-certified.
- A run with any `NULL` pin is identified as **`legacy_unrecorded`** and is
  validated against the *global* revision times instead. If that fails, the run
  remains **invalid for historical export** and the check says so; it is not
  claimed to have been repaired.
- The K002 test builds a genuinely pre-K002 database (migration 3 undone, so the
  file has versions 1–2 applied and no activation column), creates a good legacy
  run (pins revisions already effective) and a bad legacy run (pins the newest
  revisions and starts 18:30, i.e. applies a revision effective 20:10), then
  upgrades with `runMigrations()`:
  - `runMigrations` → `{ applied: [3], currentVersion: 3 }`;
  - both runs report `legacy_unrecorded`;
  - the **good** legacy run still validates clean;
  - the **bad** legacy run is flagged (`… applies pol-open-ac:2 before its
    effective time 2025-12-31T20:10:00Z`) and stays unsupported;
  - nothing changed: same `policy_versions`, same interval count, same pin
    count, and no activation was backfilled.
- Fresh corrected runs work: run B pins the current revision active from its own
  start and produces only valid readings.

---

## 7. Tests, checks and real HTTP results

### 7.1 Automated

| Command | Result |
|---|---|
| `npm test` | **61 passed, 0 failed** (56 pre-existing + 5 new K002) |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |
| `npm run validate:schema` | 24 passed, 0 failed |
| `npm run verify:contract` | 75 passed, 0 failed |

New regressions (all temporary databases; Kishore's normal `data/` was never
touched): new run after a previous run's calendar change; office-hours +
dependent device schedules together; repeated reset; mid-run activation exactly
at the intended boundary; reset before a pending change activates (documented
intended behaviour); graceful restart with an active **and** a pending change;
prior-run snapshots/readings unchanged; contract-shaped dataset with valid
references and effective times; energy/schedule/occupancy/manual-override
behaviour; and the migrated-pre-K002 case above.

The dataset is built in the **test** from stored snapshots and readings and
formally schema-validated (`assertDataset`), then checked semantically
(reference integrity, dependency resolution, no-policy-before-its-effective-time,
key uniqueness, aligned grid, cumulative/energy reconciliation). **No production
export endpoint was built.** Python acceptance was **not** run and is not
claimed — schema validity alone would not prove effective-time semantics.

### 7.2 Real HTTP on a scratch backend (compiled build, port 4173)

Scratch database `C:\Users\kdon7\AppData\Local\Temp\nexyra-k002\scratch.sqlite`
(migrate + seed, 5 rooms / 18 devices / 20 policies / 20 versions).

```text
POST /control/start {"speed":1000,"seed":2026}
    -> run A run-20260924T174514Z-e497fa98, seq 1, 2025-12-31T18:30:00Z
run A advances -> 2025-12-31T21:06:00Z
POST /calendar {working_days:[1..5], open 08:30, close 17:30}
    -> 200, applied true, effective_sim_utc 2025-12-31T21:06:00Z,
       12 new refs (office hours + 11 device schedules)
run A pins: pol-office-hours v1 active 2025-12-31T18:30:00Z (global 2000-01-01T00:00:00Z)
            pol-office-hours v2 active 2025-12-31T21:06:00Z (global 2025-12-31T21:06:00Z)
run A dev-open-ac: 21:05Z pol-open-ac:1 | 21:06Z pol-open-ac:2 | 21:07Z pol-open-ac:2
POST /control/reset -> run B run-20260924T174534Z-69d01154, seq 0, paused,
                       2025-12-31T18:30:00Z
POST /control/resume -> run B advances past the global activation time
POST /control/pause  -> run B at 2025-12-31T20:26:30Z, seq 701
```

Database readback **after the fix**:

```text
run A (start 2025-12-31T18:30:00Z, 6102 device intervals)
   pol-office-hours:1 active 18:30:00Z  global 2000-01-01T00:00:00Z
   pol-office-hours:2 active 21:06:00Z  global 2025-12-31T21:06:00Z
   pol-open-ac:1      active 18:30:00Z  global 2000-01-01T00:00:00Z
   pol-open-ac:2      active 21:06:00Z  global 2025-12-31T21:06:00Z

run B (start 2025-12-31T18:30:00Z, 3312 device intervals)
   pol-office-hours:2 active 18:30:00Z  global 2025-12-31T21:06:00Z   <- run-scoped
   pol-open-ac:2      active 18:30:00Z  global 2025-12-31T21:06:00Z   <- run-scoped
   pins without activation: 0
   intervals applying a policy before its run-scoped activation: 0
   device schedules whose office_hours_ref resolves to the pinned office-hours: 11/11
   run B dev-open-ac: 21:05Z pol-open-ac:2 | 21:06Z pol-open-ac:2 | 21:07Z pol-open-ac:2
      (crossing the global effective time mints nothing new and changes nothing)
   policy_versions total: 32 = 20 seeded + 12 minted by run A's calendar change;
      run B minted none.
```

So run B applies the intended current configuration from its start, its
activation metadata agrees with that behaviour, every interval's reference
resolves inside its own run, no policy is applied before its activation, its
office-hours dependencies resolve to the exact pinned version, and run A's
history is unchanged.

**Restart.** Run B was paused at `2025-12-31T20:26:30Z` (seq 701), the process
was stopped, and the server restarted on the same database:

```text
recovered run run-20260924T174534Z-69d01154 at 2025-12-31T20:26:30Z (seq 701) as paused
GET /api/v1/health -> {"status":"ok","run_id":"run-20260924T174534Z-69d01154",
                       "sim_time_utc":"2025-12-31T20:26:30Z"}
```

Applied pins were identical after recovery (`run_scoped`, 0 pins without
activation), and resuming across `21:06` still minted no new revision.

**Honest note on the stop:** the process was terminated with a forced kill.
Windows cannot deliver `SIGINT`/`SIGTERM` to another process gracefully (the
service documents this and supports an IPC `shutdown` message instead, which a
plain shell cannot send). The graceful shutdown path itself is covered by the
passing `graceful shutdown (real process)` test; because run B was paused, the
checkpoint was already current.

Only the processes started for this reproduction were stopped (the two server
PIDs launched here). Port 4173 now has no listener.

---

## 8. Files changed and migrations

**New forward migration (never edited afterwards):**

- `src/db/migrations/003_run_policy_activation.ts` — `ALTER TABLE run_policies
  ADD COLUMN active_from_utc TEXT` + `run_policies_activation_required` trigger.
  Registered in `src/db/migrations/index.ts`. Migrations 001 and 002 are
  untouched. A database at schema v2 upgrades to v3 with `applied: [3]`.

**Source:**

- `src/db/runs.ts` — `createRun` binds `active_from_utc = run_start_utc`.
- `src/engine/engine.ts` — `pin` requires and records the activation;
  `applyDuePending` pins each due change with its boundary; occupancy mode
  changes pin with the run's current instant; `rebuildPolicies` resolves
  office-hours references through the run's pins.
- `src/contract/validators.ts` — added `assertDataset` (root-schema validation)
  so a built dataset can be validated formally in tests. No contract file
  changed.

**Tests:**

- `test/policyTiming.test.ts` (new) — the required regressions.
- `test/runDataset.ts` (new) — builds a contract 1.0.1-shaped dataset from a
  run's stored snapshots/readings and reports semantic problems; classifies a
  run as `run_scoped` or `legacy_unrecorded`.
- `test/db.test.ts` — migration expectations updated to
  `{ applied: [1, 2, 3], currentVersion: 3 }`.

**Checkout configuration (already committed):**

- `.gitattributes` (both simulator repos) — the two LF rules in §2.

**Documentation:** this file; `docs/SIMULATION_ENGINE.md`;
`docs/KISHORE_BACKEND_HANDOFF.md`; `docs/ACTIVE_TASK.md`; `docs/HANDOFF.md`;
`docs/PROGRESS_LOG.md`.

Excluded from commits: `.env`, databases (`data/`), caches, dependencies and
build output.

---

## 9. Remaining work (not done here)

- **Browser verification:** still **not performed** — no browser capability in
  this session; SSR output and successful `curl` calls are not proof of browser
  behaviour. The manual checklist in
  `docs/K001_KISHORE_ONBOARDING_EVIDENCE.md` §10 still applies.
- **Export endpoint:** historical export is **not implemented**; K002 only
  proved the semantics with a test-built, schema-validated dataset. The
  production export/import path and the `energy-ml-service` integration remain
  open.
- **Legacy invalid runs:** pre-K002 runs that violate activation semantics stay
  invalid and are identified, not repaired. A product decision about whether to
  export/re-run them is still open.
- Socket.IO, environment/comfort control, fault injection and other features
  were explicitly out of scope.

---

## 10. Git publishing status

Filled in after committing and pushing (hashes recorded in the K002 return
report). Both repositories were pushed normally to `main`; local and remote
hashes were compared after pushing. No force push, reset or history rewrite was
used.
