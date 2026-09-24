# K004-PREP2 evidence — environment engine integration

**Developer Kishore Kumar | Agent K-B — FreeBuff | K004-PREP2**

> **Not merged, not pushed, not deployed.** Prepared on the feature branch
> `kishore/k004-environment-prep` in the separate worktree
> `simulation-backend-k004`. Review is external and **pending** (never
> self-assigned). This is environment *preparation*: it is not the released
> K004 environment feature, and the frontend has no controls for it.

Progress: supporting Kishore batch 4 / approximately 8. Main-branch integration
and frontend controls remain pending; approximately four later batches.

## 1. Branch, base, isolation and divergence

| Item | Value |
|---|---|
| Worktree | `C:/Users/kdon7/Desktop/react/hackthon/simulation-backend-k004` (preserved) |
| Branch | `kishore/k004-environment-prep` |
| Previous local commit | `43aa9fa` (K004-PREP module) — resumed, not recreated |
| Base commit | `929e78e7b6b19bf586e131a6bc256e2b211e3bcf` (**unchanged**: no merge, rebase, cherry-pick or base update) |
| `main` at inspection | `929e78e` with **uncommitted K-A (OpenCode) K003 export work** in the main working copy: modified `src/app.ts`, `src/db/connection.ts`, `src/server.ts`; new `src/export/`, `src/routes/exports.ts` |
| Committed divergence | none — `git log main ^kishore/k004-environment-prep` is empty |

K-A's simulator working copies, `simulation-frontend`, the auditor/Python
repositories and production were not edited, stashed, reset, cleaned, checked
out or merged. Nothing was pushed.

## 2. What was implemented

**Route** (`src/routes/simulation.ts`, mounted by the existing `/api/v1` router —
no `app.ts`/`server.ts` change): `POST /api/v1/environment`.

**Engine** (`src/engine/engine.ts`):
- `setEnvironment(cmd)` — validation, room lookup, legacy rejection, application, checkpoint.
- `powerFor(run, d, on)` — the single power function used by **both** the step loop and `getState()`.
- `RoomRuntime.climate`, `DeviceRuntime.quantity`, `RoomAcc.temp_seconds`/`rh_seconds`.
- `restorePartial()` — checkpoint restore that fills fields older checkpoints did not record.
- `loadRun()` reads the recorded model id, per-room climate and `quantity`.

**Environment module** (K004-PREP, reused unchanged apart from a new id):
`AC_POWER_MODEL_ID = 'ac-demand-v1'`, validation/normalization, and the pure AC
power model. No new device model, no weather API, no thermal physics, no
compressor cycling, no randomness, no training.

**Run configuration** (`src/engine/constants.ts`, recorded immutably per run):

```jsonc
"devices": {
  "power_model": "on => nominal_power_w (whole device/group); off => standby_power_w or 0. quantity is never multiplied in.",
  "ac_power_model": "ac-demand-v1",
  "ac_power_model_assumptions": {
    "module": "src/environment", "setpoint_c": 24, "full_load_delta_c": 6,
    "min_on_load_fraction": 0.2, "occupancy_fraction_per_person": 0.03,
    "humidity_affects_power": false,
    "room_temperature": "prescribed external input; no thermal trajectory is simulated",
    "nominal": "whole device/group maximum for the demo model; quantity is never multiplied"
  }
}
```

`GET /api/v1/state` also exposes the internal, non-contract field
`ac_power_model` plus `rooms[].climate`, so a reviewer or a later comparison
layer can see which model produced a run. Bump `AC_POWER_MODEL_ID` if any
assumption changes — two runs must never claim one model while meaning
different energy.

## 3. Route reference (actual bodies from the real HTTP run in §5)

```jsonc
POST /api/v1/environment            // contract fields: room_id, temp_c, rh_pct (all required, closed)
{ "room_id": "room-open-workspace", "temp_c": 31, "rh_pct": 45 }
200 { "data": { "room_id": "room-open-workspace", "seq": 4, "temp_c": 31, "rh_pct": 45,
                "sim_time_utc": "2025-12-31T18:30:20Z", "applies_from": "next_step" },
      "meta": { "request_id": "<uuid>" } }
```

Errors (existing envelope/codes, no new code invented):

| Input | Result |
|---|---|
| no run yet | `409 CONFLICT` "No simulation run exists; start or reset first" |
| legacy run (see §4) | `409 CONFLICT` "This run predates the environment model and keeps its flat-rated power semantics; reset to create an environment-capable run" |
| `temp_c: 99` | `400 VALIDATION_ERROR` `"temp_c must be within [-30, 60] °C; got 99. The value is rejected, never clamped."` (`field: temp_c`) |
| `temp_c: "30"`, `NaN`, missing `rh_pct` | `400 VALIDATION_ERROR` naming the field |
| `rh_pct: 101` | `400 VALIDATION_ERROR` (`field: rh_pct`) |
| unknown field (`turbo`, `setpoint_c`, `outdoor_temp_c`) | `400 VALIDATION_ERROR` `Unknown field "<name>"` |
| unknown `room_id` | `404 NOT_FOUND` (`field: room_id`) |

An invalid command leaves climate, `seq`, checkpoint and readings untouched
(asserted at engine and HTTP level). The module still rejects invented fields;
the route rejects them first, which is compatible, not a redefinition.

## 4. Legacy runs versus new runs

| Behaviour | Legacy run (config without `ac_power_model`) | New run (`ac-demand-v1`) |
|---|---|---|
| AC power | flat-rated (on = nominal, off = standby) | demo environment model |
| Non-AC devices | flat-rated | flat-rated (**unchanged**) |
| `rooms[].climate` / `ac_power_model` | `null` / `null` | prescribed per-room climate / `"ac-demand-v1"` |
| `room_intervals.avg_temp_c`/`avg_rh_pct` | run-level constant 26 °C / 55 % RH, exactly as before | duration-weighted per-room readings |
| climate command | `409 CONFLICT` | accepted |
| restart | legacy semantics preserved | model + climate restored |

Missing model id means legacy: the id is absent from the stored JSON, so
persisted pre-integration runs cannot silently become model runs. Reset creates
a new run with the documented new-run configuration; no historical reading and
no global policy revision is rewritten (runs/config/checkpoints are append-only
and trigger-protected).

## 5. Climate application boundary and real HTTP results

Boundary: **the next simulated 10-second step** (the step starting at
`sim_time_utc`). The seconds already accumulated in the partial minute keep
their previous climate, so the published minute is duration-weighted and no new
value is applied retrospectively. A paused run accepts a command without
advancing time or energy (no steps are processed until resume).

Real HTTP check against a **throwaway** database, fixed port `19001`, this
worktree's compiled build (`DATABASE_PATH` in OS temp; the listener was started
and stopped by this task, and no project port is listening now):

- `POST /control/start {"speed":10}` → `run-20260924T204822Z-f5d9fe80` (18:30:00Z).
- at 18:30:20Z: `POST /environment {room-open-workspace, 31, 45}` → `200`, `seq 4`, `applies_from: "next_step"`.
- `POST /environment {temp_c: 99}` → `400 VALIDATION_ERROR`; `{room_id: "room-nope"}` → `404`.
- `GET /state` at 18:30:30Z → `ac_power_model: "ac-demand-v1"`, only `room-open-workspace`
  changed (`{"temp_c":31,"rh_pct":45}`, the other four still 26/55), `dev-open-ac` power 0
  (office closed, so the AC is off), partial `{start 18:30:00Z, covered 30 s}`.
- `POST /control/reset` published the interrupted partial minute of that run:

```
room-open-workspace  interval_seconds 50  partial 1  avg_temp_c 29   avg_rh_pct 49
other four rooms     interval_seconds 50  partial 1  avg_temp_c 26   avg_rh_pct 55
```

50 s covered = 20 s at 26 °C/55 % RH + 30 s at 31 °C/45 % RH →
`(26×20 + 31×30)/50 = 29 °C` and `(55×20 + 45×30)/50 = 49 %`. The reading is
weighted, not the final value (31) and not the old constant.

## 6. Persistence and interval aggregation

- **No schema migration was added** (so no migration number to collide with
  K003's): the model id lives in the existing immutable `simulation_runs.config`
  JSON, per-room climate and the climate accumulators ride in the existing
  `engine_checkpoints.state` JSON, and the existing `room_intervals.avg_temp_c` /
  `avg_rh_pct` columns carry the weighted readings. Checkpoint `format` stays
  `2`; a checkpoint written before this change simply has no climate fields, and
  `restorePartial()`/`loadRun()` default them (climate seconds 0, climate from
  the configured run climate), so an interrupted minute resumes accurately.
- Weighted aggregation: each step adds `temp_c × 10 s` and `rh_pct × 10 s` to
  the room accumulator; publication divides by the actual covered seconds. A
  legacy run has no per-room climate and keeps the previous constant behaviour.
- Missing data is still a gap: nothing is fabricated for absent covered time,
  and a partial interval keeps its real duration (`partial = 1`).
- Power/energy/peak/cumulative semantics are unchanged, energy still integrates
  over processed simulated time, and group `quantity` is never multiplied.
- **No office-level climate summary is added** (recorded decision):
  `run.environment` remains only the configured *initial* per-room climate; the
  per-room readings are the analysis surface for device work. If an office
  summary is ever added it must state its averaging basis.

## 7. Engine wiring details

- `src/engine/engine.ts` `powerFor()` is called from `stepOnce()` (energy accumulation)
  and from `getState()` (exposed power), so the two can never disagree.
- AC only: `device_type === 'ac'` on a model run goes through `acPowerW` with the
  room's prescribed climate and the room's occupancy from the existing engine
  state. The refrigerator, lights, fans, computers, workstation group, projector
  and microwave keep their exact previous behaviour (refrigerator still governed
  by its `always_on` policy).
- Schedules, vacancy grace and override rules are untouched; no new manual
  control is granted to any device.
- Paused/resumed/restarted runs use the same path (`loadRun` restores climate
  before any step is processed).
- Occupancy affects the AC model only through the documented `0.03/occupant`
  context term — never as "one more device per person".

### Original/improved replay

Determinism is preserved: identical explicit inputs give identical power, and
there is no hidden RNG or wall clock in the model. A future original/improved
comparison must replay the **same** prescribed per-room climate (and occupancy)
timeline in both scenarios, and must not compare a legacy run with a model run
as if only a policy changed — the power model itself differs.

## 8. Tests and results (all in this worktree)

| Suite | Result |
|---|---|
| `npm test` (full) | **89/89 passed** (77 pre-existing + 8 new engine + 4 new HTTP; the 12 module tests from K004-PREP are included) |
| `test/environmentIntegration.test.ts` (8) | model id in run config; valid/invalid commands; mutation-free rejection; one-room-only change; paused command adds no time/energy; mid-minute weighted reading; state power = step power; occupancy raises power; humidity changes readings only; non-AC unchanged; legacy run on flat model + 409 + unchanged readings + restart; model/climate/readings restored across restart |
| `test/environment.http.test.ts` (4) | 409 before a run; valid command envelope; 8 invalid cases; unknown room; paused no-time/no-energy |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors |
| `npm run build` | exit 0 |
| `npm run verify:contract` | 75/75 |
| `npm run validate:schema` | 24/24 |

No expensive benchmark was rerun. The only process started was the throwaway
listener in §5, which this task also stopped.

## 9. Integration conflicts and unresolved decisions

- **Likely conflicts with K003 (K-A, uncommitted in the main copy)**: `docs/ACTIVE_TASK.md`,
  `docs/HANDOFF.md`, `docs/PROGRESS_LOG.md`, `docs/SIMULATION_ENGINE.md` (both
  tasks append to the same files), and `test/engineHelpers.ts` (this task
  extended `EngineState` with `climate`/`ac_power_model`). `src/app.ts` and
  `src/server.ts` were deliberately **not** touched, so K003's router mount and
  startup changes should merge cleanly. `src/db/connection.ts` untouched.
- **Unresolved decision (recorded)**: a climate command on a legacy run returns
  `409 CONFLICT` rather than being applied without effect; resetting creates an
  environment-capable run. Revisit only with an explicit contract decision.
- **Unresolved decision (recorded)**: no office-level climate summary; see §6.
- **Not changed**: the shared export contract (1.0.1) is untouched. Exporting
  `ac_power_model` or per-room climate to the auditor would require a contract
  version change, and exports of different models must not be silently mixed.
- **Wiring changes simulated energy** for AC devices on new runs (e.g. 700 W at
  the default 26 °C instead of 1500 W). This is the intended model change, but
  it means existing dashboard expectations for AC power/energy will move.

## 10. Frontend work still needed (not started)

- Environment controls (per-room temperature/humidity) that call
  `POST /api/v1/environment` while a run exists, with the 400/404/409 errors
  surfaced.
- Display of `rooms[].climate` and `ac_power_model` (additive fields; existing
  parsers ignore unknown fields, but the UI should stop implying a constant
  climate) and of a run being legacy (climate `null`, command rejected).
- `simulation-frontend` is Kishore-owned but out of scope here, and it was not
  modified.

## 11. Known limitations

- Synthetic demo behaviour: no thermal trajectory (room temperature is
  prescribed), no latent load, no compressor cycling, no weather, no
  calibrated physics; `nominal_power_w` is the demo model's maximum.
- Per-room climate defaults to the configured run climate (26 °C/55 % RH) until
  a command changes it; the model is per-room but the demo starts uniform.
- The recorded assumptions live in the run config; nothing enforces that a
  future config keeps them truthful except the model-id bump rule.
- No browser verification (frontend untested and unchanged).

## 12. Continuity and exact next action

- Branch-local `docs/ACTIVE_TASK.md`, `docs/HANDOFF.md`, `docs/PROGRESS_LOG.md`
  and `docs/SIMULATION_ENGINE.md` are updated in this branch. **Branch-local
  continuity is not evidence that `main` has this feature.**
- Exact next action: coordinate with K-A/K-C to review this branch against the
  committed K003 export work; decide whether the export contract needs a new
  version to carry `ac_power_model`/per-room climate; only then merge (never
  force), push `main` normally, and hand the environment controls to the
  frontend. Until a review decision exists, keep this branch local.
