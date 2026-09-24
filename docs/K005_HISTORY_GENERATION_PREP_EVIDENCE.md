# K005-PREP — Batch history generation (branch preparation) — evidence

Developer Mohan | Agent M-C — Claude Code | K005-PREP | review **pending**.
Supporting simulator batch 5 / approximately 8. Branch preparation only; main
integration, frontend controls and deployed verification remain pending.

## 1. Where this lives

| Item | Value |
|---|---|
| Worktree | `K:\simulation-backend-k005` (outside the shared `K:\NEXYRA` parent) |
| Branch | `mohan/k005-history-prep` (local only; **not pushed**, not merged, not deployed) |
| Base | `main` `929e78e7b6b19bf586e131a6bc256e2b211e3bcf` (== `origin/main` by `git ls-remote` at start) |
| Identity | existing repo-local `mohan-madhu`; no global Git change |
| Kishore's `main` working copy | not edited, stashed, reset or rebased |

## 2. What was built

| File | Role |
|---|---|
| `src/db/migrations/004_history_jobs.ts` | **Branch-local** migration 4: `history_jobs` (explicit job ↔ run link, committed-progress columns, terminal rows final, no delete) + trigger forbidding an `engine_checkpoints` row for any history run |
| `src/engine/engine.ts` (+77/−4) | Batch mode: `EngineOptions.batch`, `createBatchRun()`; checkpoint redirected to `batch.onCommit` inside each minute's transaction; interactive lifecycle and global-policy commands refused in batch mode. Interactive behaviour/config unchanged |
| `src/history/request.ts` | Validation + Asia/Kolkata month windows |
| `src/history/service.ts` | `HistoryJobService`: bounded queue, one worker, chunked stepping with yields, verify-then-succeed, failure/interrupt handling |
| `src/routes/historyJobs.ts` | `POST /history/jobs` (202) and `GET /history/jobs/:id` — **not mounted** in `app.ts` |
| `test/history.test.ts` | 19 tests (below) |
| `scripts/k005-month-run.ts` | Representative month evidence run (scratch DB, ephemeral port) |
| `test/db.test.ts`, `test/policyTiming.test.ts` | Only the migration-number expectations / the legacy v2 rollback adjusted for migration 4 |

## 3. Interface (contract `POST/GET /api/v1/history/jobs`)

Request — contract fields `from`, `to` (UTC `YYYY-MM-DDTHH:MM:SSZ`, minute-aligned, half-open), `interval_seconds` (only `60`). **Additive** (documented, not a contract change):

- `month: "YYYY-MM"` — a local Asia/Kolkata calendar month, instead of `from`/`to`.
- `seed` (0…4294967295) — the run's occupancy seed; when omitted it is generated and recorded (`seed_source: "generated"`).
- `occupancy: {mode:"manual", total}` or `{mode:"scheduled", target}` — the runtime count only.

Refused (never silently ignored):

| Input | Response |
|---|---|
| `calendar`, `environment` | 400 |
| Occupancy `mode` different from the current occupancy policy revision | 409 |
| Range over 31 days | 413 `REQUEST_TOO_LARGE` |
| Unknown field | 400 |
| Unseeded inventory | 409 |
| Queue full (default limit: 1 running + 2 waiting) | 409 |

All of these are validated before a job row exists, so there are no side effects.

Response: `job_id`, `status` (`queued|running|succeeded|failed`), `result_ref` (the generated `run_id`, only when succeeded), plus additive `run_id`, `requested`, `seed`, `seed_source`, `occupancy`, `progress` (`committed_through_utc`, completed/expected steps and intervals, fraction), `coverage` (`complete`, committed from/to), `failure` (`{code, message}`), `synthetic: true`, and wall-clock `created/started/finished_utc`.

**Narrow decision — why mode and calendar are not job inputs.** Occupancy mode and office hours are *global, immutable policy revisions*. A job-specific value would mint a new global revision. That revision would become "current" for inventory and for the next interactive reset. So only runtime counts are accepted, and the run pins the current revisions. The owner needs to decide whether to add run-scoped revisions later.

## 4. Engine reuse, calendar, seed and model semantics

- **Same code path.** Batch runs are created by the engine's own `createNewRun` (snapshot, pins, seeded occupancy) at the requested start. They advance through the same `advanceSteps` → `stepOnce`: 10 s steps, 60 s intervals, and unrounded `power_w × 10 / 3,600,000` energy. Whole-group watts are never multiplied by quantity, and no steps are skipped. The only difference is where the checkpoint goes. Batch mode never uses the wall-clock scheduler or its speeds.
- **Custom start is real.** The run's clock, `run_start_utc`, `config.initial_sim_time_utc` and every pin's `active_from_utc` all begin at `from`. Nothing is generated at 1 January and relabelled.
- **Calendar months.** `[local 1st 00:00, next month's local 1st 00:00)`, converted to UTC at the fixed +05:30 offset (Asia/Kolkata has no DST). The next boundary comes from the calendar:
  - January is 31 days; February 2026 is 28 and 2028 is 29;
  - December 2026 ends at `2026-12-31T18:30:00Z`, which is 1 January 2027 local.
- **Seed.** It drives the existing seeded occupancy stream: home seats, which occupants arrive or leave, and meeting/lunch movers. It changes the **room** allocation and therefore which room's devices run. It does **not** change the office head-count timeline, which follows the schedule (tested). With manual total 0 it has no effect on energy. The `devices` RNG stream is still unused; no noise was added.
- **Model and provenance** (committed engine, layer K3-K4):
  - Policy control with vacancy grace; the scheduled office has all occupants arriving at opening, plus meeting and lunch redistribution.
  - Constant synthetic 26 °C / 55 % RH climate; no thermal or AC comfort model; refrigerator at constant draw.
  - Voltage and current are unmodelled.
  - The run config records `run_purpose: "history_batch"`, `history_job_id`, `synthetic: true`, the generator, the requested window, `seed_source` and the runtime occupancy.

## 5. Interactive isolation

- Batch runs **never write `engine_checkpoints`**, which is interactive recovery's only source. Migration 004's trigger makes this structural, and a test proves it.
- Tests confirm that the interactive run's state, readings and checkpoint row stay byte-identical during a batch job.
- A restart (`new SimulationEngine(db).recover()`) returns the interactive run. When no interactive run exists it returns `null`, even though a newer batch run exists. Nothing is inferred from timestamps.
- The batch engine refuses `recover`, `start`, `resume`, `reset`, and the calendar, occupancy and device commands (409).
- Transactions are short: one per simulated minute (readings plus progress). The worker yields after every chunk (default 360 steps) and keeps only the current minute in memory.

## 6. Job status and failure behaviour

- **Progress counts committed work only.** It is written in the same transaction as each published minute, never estimated from wall time.
- **`succeeded` requires verification.** A job is marked succeeded only after checking, in the database, the expected device and room row counts, zero partial rows, and exact `from`/`to` coverage. Otherwise it fails with `INCOMPLETE_OUTPUT`.
- **Errors** give `failed` / `JOB_FAILED`. Partial readings are kept, with `coverage.complete=false`, the exact committed end, and `result_ref: null`.
- **Interruption** (`stop()`, or a restart finding a `running` row) gives `failed` / `JOB_INTERRUPTED`. Jobs are **not resumed**; resumability is not claimed. Queued jobs never started, so a restart processes them (tested).
- **Terminal rows cannot be modified** (enforced by a trigger).

## 7. Verification (scratch / in-memory databases only)

`test/history.test.ts` 19/19:

- **Equivalence and determinism:**
  - Interactive vs batch over 12 simulated hours with the same seed: identical device rows, room rows and pins.
  - Chunk sizes 1, 7 and 360 give identical output.
  - The same seed reproduces a run exactly. A different seed changes room allocation only.
- **Calendar and validation:**
  - Calendar boundaries: January, February 2026/2028, April, and December → January rollover.
  - A month request expects 31 × 8,640 steps and 31 × 1,440 intervals.
  - 18 invalid requests leave no jobs and no runs; an unseeded inventory is refused.
- **Energy and totals:**
  - Empty office: each device equals its always-on or standby power × 2 h, and the fridge is exactly 0.3 kWh.
  - Room totals sum to the office total, device and interval keys are unique, and cumulative counters equal summed energy.
- **Runs and isolation:**
  - Pins activate at the batch start and follow the latest global calendar revision (office hours v2), with no interval before its activation.
  - Provenance is recorded in the run config.
  - Interactive isolation, restart recovery, and the trigger rejecting a checkpoint for a batch run.
  - The batch engine refuses interactive calls.
  - A runtime occupancy target is applied without minting a revision.
- **Job lifecycle:**
  - Mid-run progress equals committed rows, and a job is not complete until verified.
  - Injected failure: 20/60 intervals are kept, marked incomplete, and the terminal row is final.
  - Stop, restart marking and queued-job processing.
  - The queue bound is enforced.
- **HTTP:** a harness on an ephemeral port checks the 202 / 200 / 404 / 400 / 413 envelopes.

Other checks:

| Check | Result |
|---|---|
| All other test files (app, db, engine, occupancy, policyTiming, simulation.http) | 60/60 (79/79 in total) |
| `typecheck`, `lint`, `build` | clean |
| `verify:contract` | 75/75 |
| `validate:schema` | 24/24 |
| `test/shutdown.test.ts` | **Not run to completion.** It needs the fixed port 19001, which VS Code (pid 26420) holds on this laptop (apparently port forwarding). The foreign listener was not touched. This is pre-existing and unrelated to K005. |

Two runner defects were found by these tests and fixed before commit:
1. A job submitted while the worker promise was settling could be left queued.
2. Same-second FIFO ordering; the queue is now ordered by `rowid`.

## 8. Representative month (one run, not a benchmark)

`npx tsx scripts/k005-month-run.ts 2026-01 20260101`:

- **Scratch database:** `%TEMP%\nexyra-k005\month-2026-01-20260924T213403Z\history.sqlite` (≈364 MB, kept), with `summary.json` alongside it.
- **Setup:** seed the demo inventory, create an interactive run, then switch it to scheduled occupancy (target 14). That is a normal interactive action which minted the scheduled revision *in this scratch database*.
- **Request:** `{month:"2026-01", interval_seconds:60, seed:20260101, occupancy:{mode:"scheduled", target:14}}`, sent over real HTTP to the in-process harness on an ephemeral loopback port.

| Measure | Result |
|---|---|
| Status | `succeeded`; `result_ref` = run `run-20260924T213403Z-e8bd54fa` |
| Window | `2025-12-31T18:30:00Z` → `2026-01-31T18:30:00Z` (31 local days) |
| Steps / intervals | 267,840 / 44,640 (expected = completed) |
| Rows | 803,520 device intervals (44,640 × 18) and 223,200 room intervals (× 5); 0 partial |
| Wall time | ≈208 s (job 21:34:03Z → 21:37:31Z, including 2 s polling). Informational only |
| Progress | 72 polled samples, monotonic. For example, 14,220 intervals committed at 45 s and 37,380 at 143 s |
| Memory (point samples, **not** measured peaks) | heap 18–36 MB, RSS 93–127 MB, no growth trend across the month |
| Office energy | **1,331.376 kWh**. Room totals sum to the same figure; largest mismatch between a device's cumulative counter and its summed energy: 1.9 × 10⁻¹⁰ kWh |
| Energy by room | open workspace 530.44, meeting 313.54, manager cabin 312.49, pantry 117.34, reception 57.57 kWh |
| Office power (1-minute averages) | 168 W to 6,575 W |
| Hand-checked device totals | fridge 150 W × 744 h = **111.6 kWh**; projector and microwave (manual-only, never on) are standby only: 5 W × 744 h = 3.72 and 3 W × 744 h = 2.232 kWh; open-workspace devices on for 198 h = 22 weekdays × 9 h |
| Occupancy | maximum office count 14 |
| Policy activation | all 20 pins active from `2025-12-31T18:30:00Z` |
| Interactive run | checkpoint unchanged; `recover()` returned the interactive run, not the batch run |
| Hourly coverage | all 744 **local** hours complete. Grouped by UTC hour the query shows 743/745, because the first and last UTC hours are half-hours under the +05:30 offset |

## 9. Suitability of a generated month (synthetic; not real building data, not validated physics)

| Use | Assessment |
|---|---|
| Vacancy analysis | Structurally suitable: vacancy grace and schedule behaviour are present, but no waste is injected. Findings depend on the policies |
| Forecast | 744 complete local hours exceed the 168/336/672-hour thresholds, **if** exported and imported unchanged. Calendar length alone does not guarantee that; complete-hour coverage does |
| Excess-consumption and drift detectors | The engine is stationary: no degradation, faults or weather. The detectors should report no deviation or trend, or insufficient data. Using this data to *demonstrate* findings would need scenario inputs that do not exist yet |
| Everything | Constant climate, no AC comfort model, unmodelled voltage and current. Label all results synthetic |

## 10. Integration steps and dependencies

**Mounting** (not applied on this branch; do it at integration):

```ts
// src/server.ts, after the interactive engine.recover():
const history = new HistoryJobService(db);
history.start();                                   // fails orphaned running jobs, processes queued ones
// src/app.ts (AppDeps gains `history`):
app.use('/api/v1', historyJobsRouter(history));
// shutdown(): await history.stop() before closeDatabase(db)
```

**K003 export (Kishore K-A).** Not committed at the base, so end-to-end export verification is **pending**. The contract's `GET /api/v1/export?format&from&to&interval_seconds` has no run selector. To export a generated run it needs:
1. an additive `run_id` (use the job's `result_ref`);
2. a refusal for any batch run whose `history_jobs.status` is not `succeeded`;
3. the dataset's run and provenance to carry the run config (`run_purpose`, `synthetic`, seed, window);
4. run-scoped `active_from_utc` for policy effective times (K002 semantics).

The K002 test helper `test/runDataset.ts` shows the read model.

**K004 (Kishore K-B).** Its environment and AC work applies automatically, because the batch path uses the same `stepOnce`. Any new run-level input (weather, thermal parameters) must be added to `BatchRunInput.config` and the request validator, and should stay rejected until then. Re-run the equivalence test after the merge.

**Migration number.** 004 is branch-local. If K003 or K004 lands a migration 004 first, renumber this one before applying it anywhere. It has never been applied outside scratch or in-memory databases.

**Possible conflicts:** `src/engine/engine.ts` (small additive hunks), `src/db/migrations/index.ts`, and the two adjusted tests.

## 11. Not done

- No push, merge or deployment; the feature-branch deployment behaviour is unconfirmed.
- No frontend controls, export, fault injection, Socket.IO, reporting or comparisons.
- No job-specific calendar or occupancy mode.
- No resume of interrupted jobs.
- `shutdown.test.ts` was not run on this laptop.
- The production and public APIs were not called.
