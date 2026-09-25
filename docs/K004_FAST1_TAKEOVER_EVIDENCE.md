# K004-FAST1 — takeover and K005 continuation: fast days + hourly recording — evidence

Developer Mohan | Agent M-C — Claude Code | K004-FAST1 | review **pending**.
Previous assignee: Kishore K-B — GLM-5.3. All observations are from **Mohan's
laptop** and the worktrees named below. The state of Kishore's laptop was not
observable.

## 1. Takeover reconciliation

- **GLM (K-B) work:** nothing is reachable from this laptop.
  - The simulation-backend remote has only `main` at `929e78e`, and simulation-frontend `main` is at `dbcbee9`.
  - No K004 branch, bundle, worktree, handoff or AGENTS.md was found.
  - Nothing of GLM's is reused or reconstructed; any GLM work still has to be reconciled on Kishore's laptop.
- **Continued from:** the verified K005 branch `mohan/k005-history-prep` (`1975c8d`, `92aadd8`, `0464c9a`, clean).
- **Not touched:**
  - Kishore's `main` working copies.
  - Another agent's frontend worktree (`K:\NEXYRA\simulation-frontend-visual`, branch `mohan/sim-visual-01`).
  - VS Code's port-forward listener on 19001–19003 (pid 26420).

| Worktree | Branch | Base | Commits |
|---|---|---|---|
| `K:\simulation-backend-k005` | `mohan/k005-history-prep` | `929e78e` | K005: `1975c8d` `92aadd8` `0464c9a`; K004-FAST1: `c6794b2` plus this docs/script commit |
| `K:\simulation-frontend-fast1` | `mohan/k004-fast1-controls` | `dbcbee9` | `ebdfdb4` |

## 2. Two operations, kept separate

| | A. Generate history (K005) | B. Advance days (K004-FAST1) |
|---|---|---|
| Route | `POST/GET /api/v1/history/jobs` | `POST /api/v1/control/advance {days}`, `POST /api/v1/control/advance/stop` |
| Run | New independent batch run; the interactive run is untouched | The **current interactive** run |
| Stepping | Batch-mode engine; worker chunks with yields | Existing `WallClockScheduler` paced at 86,400 simulated s per real s (≈1 day/s); bounded 120-step batches; yields; no skipped steps |
| Commands | Refused (batch engine) | Device, occupancy and calendar commands are accepted; they apply at the processed step boundary between batches |
| Ends | `succeeded` only after verification, otherwise `failed` | Pauses at the target, on stop or on pause; the outcome is reported (`completed`, `stopped`, `interrupted`, `failed`) |
| Range | Calendar month (exact local month boundaries) or from/to, up to 31 days | 1–31 **whole days**; "30 days" is a duration, not a calendar month |

Advance rules:
- Only from **paused**. Refused (409) while the normal clock runs, or while another advance is active.
- `start`, `resume` and `reset` are refused during an advance. `pause` stops it.
- `speed` changes are stored and apply after the advance.
- `state.advance` gives processed and expected steps, the fraction, the start, and the **target**. `sim_time_utc` is always processed time.
- An advance is not resumed after a restart: the run recovers paused at its last checkpoint.

## 3. Hourly recording

- **Stored per run.** `interval_seconds` is 60 or 3600 and lives in the **immutable run config**, under the same key the config already carried.
  - It is set only when a run is created: `start`/`reset {interval_seconds}` or a history job's `interval_seconds`.
  - Supplying it for an existing run gives 409.
  - Runs created before this change (value 60, or missing) keep 60 s, and their config is byte-identical.
- **Contract.** 3600 is already an allowed nominal in contract 1.0.1, so **the contract is unchanged**.
- **Aggregation, not sampling.** The same 10 s steps are integrated and published at **local** recording boundaries: local minutes (same as UTC) or local hours, which are UTC hh:30 because of the +05:30 offset. The published values keep the existing duration-weighted definitions:
  - kWh and cumulative counters;
  - average and maximum power;
  - on-fraction, override, vacant-on and off-schedule seconds;
  - occupancy average, maximum and occupied fraction.
  - Climate: the committed engine's climate is **constant** (26 °C / 55 % RH), so it is published as that constant. See §7 for K004.
- **One policy per interval.** A calendar change takes effect at the **next recording boundary**, which for hourly runs is the next local hour; the response's `effective_sim_utc` says so. Each interval therefore carries exactly one `policy_ref`. Occupancy-mode revisions are not device policy refs.
- **Partial boundaries.** These are unchanged: pause and graceful shutdown checkpoint the partial accumulator, and reset publishes a `partial` edge interval.
  - Checkpoints now happen at each recording boundary and on every command, pause and shutdown.
  - An **ungraceful crash** can therefore lose up to one recording interval (previously up to one minute). It never double-counts (tested).
- **History jobs.** `interval_seconds: 3600` is accepted, with from/to on local-hour boundaries. Calendar months still map exactly to local month boundaries.
- **Migration.** Branch-local migration **005** rebuilds `history_jobs` to allow 3600 (migration 004 was already applied to scratch databases, so it was not edited).

## 4. Command semantics during an advance

- Node processes one scheduler batch (at most 120 steps, 20 simulated minutes) and then yields. A command sent in between applies at the **processed** time shown in its response (`sim_time_utc`), and affects subsequent steps only. Earlier readings are never altered.
- The current state (in-memory processed time, cumulative energy and the partial interval) is always available between hourly database writes.
- **AC switching works** on this branch. `dev-open-ac` has a `switch` control and `allow_manual_override` (measured in §5).
- **Integration gap:** after K004's climate/AC model merges, AC switching, climate aggregation and run config/checkpoint handling must be re-verified (§7).

## 5. Measured speed (one measurement)

`npx tsx scripts/k004-fast-days-measure.ts 30`:
- scratch database `%TEMP%\nexyra-k004-fast1\advance-30d-20260924T215719Z\` (kept);
- the real `createApp` served on an ephemeral loopback port, with the real scheduler;
- hourly run, seed 2026, scheduled occupancy with target 14.

| Measure | Result |
|---|---|
| Requested | 30 days |
| Elapsed (wall) | **30.12 s** (0.996 simulated days per real second) |
| Processed steps | 259,200 / 259,200; outcome `completed`; then `paused` at `2026-01-30T18:30:00Z` |
| Stored | 12,960 device intervals + 3,600 room intervals, all `interval_seconds` 3600, 0 partial |
| Energy | office 1,395.378 kWh; intervals = cumulative counters = in-memory state within 2.4 × 10⁻¹⁰ kWh |
| Commands during the advance | AC on: HTTP 200 in 7.2 ms, applied at `2026-01-03T22:51:00Z`. Clear: 200 in 7.2 ms at `2026-01-05T21:11:30Z` |
| Command effect | The first override hour (22:30–23:30Z) has `override_seconds` 2340 = 39 min, on-fraction 0.65, 0.975 kWh = 1.5 kW × 0.65 h. The last has 2490 s = 41.5 min, 1.0375 kWh. 47 hourly intervals carry the override |
| `GET /health` latency while advancing | median 6 ms, p95 24.7, max 64.9 (110 samples) |
| `GET /state` latency while advancing | median 5 ms, p95 17.5, max 34.8 |
| Memory (point samples, **not peaks**) | heap 29 MB median (max sample 41); RSS 117 MB median (max sample 121) |

- A 1-day correctness pass beforehand took 1.06 s (8,640 steps), with a reconciliation error of 4.7 × 10⁻¹³ kWh.
- **Pace.** The pace is capped at the target of 1 day per second, by design. 60 s-recording runs use the same pacing, but their write rate is 60× higher, so their speed was **not measured** here. The K005 batch reference was 1,288 steps/s ≈ 0.15 days/s at 60 s. Displayed progress is always processed steps.

## 6. Tests and checks (scratch / in-memory databases only)

`test/fast.test.ts`, 13/13:
- 1 kW for 24 h gives 24 kWh in 24 hourly intervals.
- 15 min on then 45 min off gives 0.25 kWh, average 250 W and peak 1000 W.
- Over 26 hours, every hourly device and room interval equals the duration-weighted aggregate of its 60 minute intervals: energy, averages, maxima, durations, cumulative totals and policy ref.
- Results are identical for chunk sizes 1, 7, 360 and 1000.
- 60 s runs stay 60 s; `interval_seconds` is creation-only; recovery keeps the interval.
- A calendar change applies at the next local hour with one policy ref per interval, and activation is recorded at that boundary.
- A restart mid-hour gives output byte-identical to an uninterrupted run.
- An advance reaches exactly its target, shows only processed time, and pauses.
- A command during an advance changes that hour: ⅓ kWh for 20 minutes on.
- Stop and pause freeze time and energy; overlapping runners and bad day counts are refused; the user speed is preserved.
- A batch engine refuses advance.
- Hourly history-job validation keeps calendar months (January 744 intervals, February 2028 696) and rejects misalignment.
- An hourly job succeeds in its own run without touching the interactive run or its checkpoint.

Other checks:

| Check | Result |
|---|---|
| Whole suite (all files except `shutdown.test.ts`) | **92/92** (K005's history tests still 19/19, so failed jobs are still never marked complete) |
| `typecheck`, `lint`, `build` | clean |
| `validate:schema` | 24/24 |
| `verify:contract` | 75/75 |
| `shutdown.test.ts` | **Not rerun.** It needs the fixed port 19001, which VS Code holds on this laptop; no isolated environment that can bind it was available. Run it where 19001 is free |
| Frontend branch | `npm test` 27/27; typecheck, lint, build clean; `verify:contract` 75/75 |
| Frontend adapter against this backend over real HTTP | pass: hourly reset; mid-advance processed progress (5,028 / 17,280 steps); second advance 409; stop freezes; February 2026 hourly job succeeded 672/672 with the interactive time unchanged. The throwaway harness is not committed |
| Browser | **not verified** |

## 7. Integration dependencies

- **Mounting the history routes (K-A).** The router is still not mounted in `app.ts` (see the K005 evidence §10). The advance routes live in `routes/simulation.ts`, which is already mounted.
- **K003 export.** It needs run selection by `run_id` and must refuse history runs whose job did not succeed. It must also export `interval_seconds` 3600 intervals as-is. Hourly **local-hour** alignment is UTC hh:30. The auditor anchors its source grid at export start, so it should accept this, but that is **not verified**, and neither is end-to-end export.
- **K004 (climate/AC, GLM or K-B).** Not available on this laptop. When it merges:
  1. the per-step climate must be accumulated in `PartialInterval` (duration-weighted temperature and humidity) instead of `run.environment` constants;
  2. new run-config keys must coexist with `interval_seconds`;
  3. new state in the checkpoint must survive the less frequent hourly checkpoints;
  4. AC power must still be `powerOf`-based per step;
  5. AC switching must be re-verified;
  6. `test/fast.test.ts` and `test/history.test.ts` must be re-run.
- **Branch-local migrations** 004 and 005 must be renumbered if `main` takes those numbers.
- **Likely merge conflicts:** `engine.ts` (lifecycle, `stepOnce` boundary, `setCalendar` effectivity), `constants.ts`, `routes/simulation.ts`, and the migration index. On the frontend: `page.tsx`, `sim-state.ts` (two exports) and `tsconfig.json`.

## 8. Transfer

Git bundles (no databases or datasets) are listed in `K:\k004-fast1-transfer\README.txt`, with their base, branch, final commit and import commands. The transfer and integration have **not** happened.
