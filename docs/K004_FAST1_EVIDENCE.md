# K004-FAST1 evidence — day acceleration and hourly recording (CHECKPOINT, not complete)

**Developer Kishore Kumar | Agent K-B — GLM-5.3 | K004-FAST1 | partial — stopped at a safe checkpoint | review pending**

> **Handoff record.** Work stopped mid-implementation at the owner's request and
> transferred to **Mohan M-C — Claude Code**. Not merged, not pushed, not
> deployed. Everything below is on the local feature branch
> `kishore/k004-fast1` (worktree `simulation-backend-k004`), stacked on
> `kishore/k004-environment-prep` (`13d59b6`). **Day acceleration and hourly
> recording are NOT complete.** The one-day-per-second rate is a target and is
> **not demonstrated**.

## 1. Branch, base and commit

| Item | Value |
|---|---|
| Worktree | `C:/Users/kdon7/Desktop/react/hackthon/simulation-backend-k004` (preserved) |
| Branch | `kishore/k004-fast1` (created this task; stacked on `kishore/k004-environment-prep`) |
| Base commit | `13d59b6` (K004-PREP2 environment engine integration); ultimate base `929e78e` |
| Checkpoint commit | recorded in `docs/ACTIVE_TASK.md` after commit (see §6) |
| Other worktrees | never opened for write; K-A's uncommitted K003 work in `simulation-backend` untouched |

## 2. Implemented so far (backend only)

- **`src/engine/advance-days.ts` (new)** — `AdvanceDaysController`: a narrow
  wrapper around the existing engine. Validates 1–31 whole days
  (`ADVANCE_MAX_DAYS`), computes the target as `days × 86,400` simulated
  seconds (`DAY_SECONDS`), processes the engine's own deterministic
  `advanceSteps()` in bounded chunks (`ADVANCE_CHUNK_SECONDS = 6000` simulated
  seconds per chunk) and yields (`await sleep(0)`) between chunks so HTTP is
  served. Progress is computed from the engine's processed `simEpoch` — never
  from wall-clock time, never ahead of calculations. `requestStop()` freezes at
  the current chunk boundary; completion/stop/failure all end with
  `pause()` (processed time and energy preserved; nothing reset).
- **`src/engine/constants.ts`** — `DAY_SECONDS`, `RECORDING_INTERVALS
  [60, 3600]`, `DEFAULT_RECORDING_INTERVAL = 60`, `ADVANCE_MAX_DAYS = 31`,
  `ADVANCE_CHUNK_SECONDS`, and a `recording: { interval_seconds: 60, … }`
  block in `RUN_CONFIG` documenting the immutable per-run interval.
- **`src/engine/engine.ts`** —
  - per-run `intervalSeconds` read from the immutable run config
    (`recording.interval_seconds`); a missing/invalid value is a legacy run
    and keeps the historical 60 s behaviour (`isRecordInterval` guard);
  - `stepOnce()` publishes at `run.simEpoch % run.intervalSeconds === 0`
    instead of a hard-coded minute, so hourly runs integrate every processed
    10-second step into 3600-second intervals (no endpoint sampling, no
    schema change; `interval_seconds`/`partial` semantics unchanged);
  - `setRecordingIntervalForNextRun(60|3600)` + `nextRecordingInterval` —
    applies only to the NEXT created run; existing runs are never changed
    and resolution never switches midway;
  - `advance` controller wired via an `AdvanceHost` adapter over the engine;
    `beginAdvanceDays`, `stopAdvance`, `advanceProgress`, `advanceActive`;
  - **concurrency guards**: `resume()`/`setSpeed()`/`reset()` return
    `409 CONFLICT` while an advance is active; `pause()` requests the advance
    to stop; lifecycle guards ensure at most one runner for the interactive
    run;
  - `getState()` additive fields: `recording_interval_seconds` and `advance`
    (processed/target progress).
- Existing semantics preserved: speeds 1–1000 untouched, quantity never
  multiplied, power via `powerFor()` only, energy integrated over processed
  steps, commands still apply at the next step boundary.

## 3. NOT yet implemented (exact remaining work)

1. **Policy-boundary interval splitting (§5 of the prompt, `publishPartial`)**:
   when a policy activation lands mid-interval on an hourly run, the
   accumulator must split at the boundary second so one row never carries two
   `policy_ref`s (contract 1.0.1 / K003 export rejects mixed buckets). An edit
   was started and **reverted**; `publishPartial` is back at its
   `13d59b6` state. Decide: split rows, or defer/reject with a clear message —
   but never silently select one version.
2. **Routes** (`src/routes/simulation.ts`): `POST /api/v1/control/advance-days`
   `{days}` (409 on active advance, 400 on invalid days),
   `POST /api/v1/control/advance-stop`, and the recording-interval opt-in for
   a NEW run (e.g. on the new-run setup path) — additive, documented with
   request/response examples.
3. **Command responsiveness during advance**: verify device/occupancy/
   environment commands apply at the next processed step boundary while
   advancing, are included in the hourly aggregates, and never appear to
   affect already-displayed processed time.
4. **K005 interface inspection** at startup (per the original prompt): reuse
   shared batch facilities if committed; do not build a second generator.
5. **Focused tests** (`test/advance-days.test.ts` + http tests): 1 kW × 1 day
   = 24 kWh; 1 kW 15 min on / 45 min off = 0.25 kWh, avg 250 W, peak 1000 W
   in that hour; minute vs hourly equivalence for identical inputs; chunk-size
   invariance; commands during advance; stop freezes time/energy; restart
   never double-counts a partial hour; completed-hour/cumulative reconciliation;
   duplicate-runner rejection.
6. **Measured 30-day hourly run** on a scratch DB (fixed port 19001 free
   first): report actual elapsed time, step count, interval counts, HTTP
   latency during advance. Do not promise 30 seconds unless measured.
7. **Frontend** (worktree `simulation-frontend-k004`, branch
   `kishore/k004-fast1-ui`, created at base `cbafa41`): nothing implemented
   yet — no adapter, no component, no tests. Plan: `app/lib/days-advance.ts`
   (typed adapter, `sanitizeOrigin`, bounded timeouts, honest failure states)
   and a reusable, unmounted `DaysAdvanceControls` component with the exact
   mounting change left to the integration owner (K003/Mohan M-D coordination),
   following the K004-PREP3 component pattern (`useSyncExternalStore`
   controller, parent-authoritative props, no frontend clock/energy math).
8. **Continuity updates**: branch-local ACTIVE_TASK/HANDOFF/PROGRESS_LOG for
   the completed state, plus integration instructions for K003 export
   compatibility (hourly rows are plain `device_intervals`/`room_intervals`
   rows; the K003 exporter aggregates them like any other source resolution,
   and mixed-policy coarse buckets are already rejected there).

## 4. Verification performed at this checkpoint

- `npm run typecheck` → exit 0.
- `npm run lint` → 0 errors, 0 warnings.
- `npm test` → **89/89 passed** (all pre-existing suites; no behaviour
  regressions; suite includes the responsiveness/backlog check).
- `npm run build` → exit 0.
- No HTTP server was started; no port was occupied; all tests used in-memory/
  temp databases. No task-owned process is running.

## 5. Key design decisions recorded for the successor

- **Chunked engine steps, not a faster clock**: the advance reuses
  `advanceSteps()` so schedule/occupancy/climate/device calculations are
  identical; only the driver changes.
- **Pause at the end**: target reached, user stop and failure all pause the
  run at the last processed step; reset is refused while advancing.
- **Legacy runs are safe**: interval defaults to 60 s when the stored config
  lacks `recording.interval_seconds`; hourly recording is opt-in for NEW runs.
- **`intervalSeconds` is per-run runtime state**, not a global: concurrent
  behaviour of two runs (not currently possible in-process) cannot leak.
- **State surface is additive**: `recording_interval_seconds` and `advance`
  are additions to `GET /state`; they are not part of the frozen contract and
  must be documented as extensions.

## 6. Exact next action for the incoming owner (Mohan M-C — Claude Code)

1. `git -C simulation-backend-k004 log --oneline -2` and `git status --short`
   to confirm the checkpoint commit and a clean tree (commit hashes are in
   `docs/ACTIVE_TASK.md`).
2. Implement §3 item 1 (`publishPartial` policy-boundary splitting) with a
   regression test (calendar change mid-hour on an hourly run).
3. Implement §3 items 2–3 (routes + command responsiveness), then the focused
   tests (§3 item 5), then the measured 30-day run (§3 item 6).
4. Frontend work per §3 item 7 in `simulation-frontend-k004`.
5. Keep all guards: no merge/push/deploy; main working copies untouched;
   scratch databases only.
