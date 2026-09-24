# K004-PREP evidence — environment / AC-consumption preparation

**Developer Kishore | Agent K-B — FreeBuff | K004-PREP**

> **Prepared on a feature branch; not connected to the engine, not deployed.**
> This is preparation work only. It is **not** complete K004 environment
> controls: there is no route, no persistence, no engine wiring and no UI.

- Progress: supporting Kishore batch 4 / approximately 8 planned.
- Engine/UI integration and main-branch release are **still pending**.
- Review status: **pending** (never self-assigned).

## 1. Isolation, branch and base

| Item | Value |
|---|---|
| Repository | `simulation-backend` (separate Git worktree) |
| Worktree path | `../simulation-backend-k004` (`C:/Users/kdon7/Desktop/react/hackthon/simulation-backend-k004`) |
| Branch | `kishore/k004-environment-prep` (new; `main` is the only other branch) |
| Base commit | `929e78e7b6b19bf586e131a6bc256e2b211e3bcf` — `chore(deploy): fix simulation backend port 19001`, the reported deployment baseline and the current committed `main` HEAD |
| Isolation | The main working copies of `simulation-backend`/`simulation-frontend` (K-A), the auditor/Python repositories and production were **not** modified, stashed, reset, cleaned, checked out or merged |

Dependencies were installed **only inside this worktree** (`npm ci`, lockfile
unchanged). No service was started, no public control was called and no
database was touched (tests use in-memory/temp databases only).

## 2. New files and function signatures

All under `src/environment/` (nothing else was changed outside `docs/`):

| File | Contents |
|---|---|
| `src/environment/constants.ts` | contract bounds and demo assumptions (below) |
| `src/environment/errors.ts` | `EnvironmentInputError { code, field }`, codes `INVALID_TYPE \| OUT_OF_RANGE \| UNSUPPORTED_FIELD \| UNSUPPORTED_DEVICE` |
| `src/environment/climate.ts` | validation/normalization |
| `src/environment/ac-power.ts` | the AC power model |
| `src/environment/index.ts` | re-exports |

Key signatures:

```ts
requireFiniteNumber(field: string, value: unknown): number
requireInRange(field: string, value: unknown, min: number, max: number, unit: string): number
requireTempC(field: string, value: unknown): number          // °C, -30..60
requireRhPct(field: string, value: unknown): number           // %, 0..100

validateRoomClimateCommand(value: unknown): RoomClimateCommand      // { room_id, temp_c, rh_pct }
validateRoomClimateAggregate(value: unknown): RoomClimateAggregate  // { avg_temp_c, avg_rh_pct }
defaultRoomClimate(): { temp_c: number; rh_pct: number }            // 26.0 / 55.0
roomClimateFromAggregate(a: RoomClimateAggregate): { temp_c, rh_pct }

assertSupportedAcDevice(device: AcDeviceRating): AcDeviceRating
acPowerBoundsW(device: AcDeviceRating): { standby_power_w; min_on_power_w; max_power_w }
coolingDemandFraction(i: { temp_c; setpoint_c?; occupancy? }): number   // 0..1
acPowerDetail(i: AcPowerInput): AcPowerResult
acPowerW(i: AcPowerInput): number                                       // W
```

`AcPowerInput = { device: AcDeviceRating; on: boolean; temp_c: number; setpoint_c?: number; rh_pct?: number; occupancy?: number }`.
The module is pure: no wall clock, no randomness, no database, no HTTP, no
global mutable state, and **no kWh** (the engine keeps integrating W over
simulated elapsed time).

## 3. Units, defaults and the origin of every assumption

| Name | Value | Origin |
|---|---|---|
| `temp_c`, `rh_pct` | °C, % | contract 1.0.1 `API.md` `POST /api/v1/environment` (`{ room_id, temp_c: 26.5, rh_pct: 55 }`) — command only, not implemented |
| `avg_temp_c`, `avg_rh_pct` | °C, % | contract 1.0.1 aggregate room-interval climate (`CONTRACT.md` §room interval, `dataset.schema.json`, CSV `room_temp_c`/`room_rh_pct`), already persisted by the engine |
| Room temperature bounds | `-30..60` °C | `dataset.schema.json` `avg_temp_c` minimum/maximum and migration 001 `CHECK (avg_temp_c BETWEEN -30 AND 60)` |
| Humidity bounds | `0..100` % | `dataset.schema.json` `avg_rh_pct` minimum/maximum and migration 001 `CHECK (avg_rh_pct BETWEEN 0 AND 100)` |
| Default climate | 26.0 °C / 55.0 % | existing `RUN_CONFIG.environment` (already labelled synthetic, "no thermal model yet") |
| `DEFAULT_AC_SETPOINT_C` | 24.0 °C | **demo assumption** — no setpoint exists in the contract or the simulator (AC follows its schedule only) |
| `FULL_LOAD_DELTA_C` | 6.0 °C | **demo assumption** — excess at which demand saturates |
| `MIN_LOAD_FRACTION` | 0.20 | **demo assumption** — part-load floor (300 W of 1500 W) |
| `OCCUPANCY_LOAD_FRACTION_PER_PERSON` | 0.03 | **demo assumption** — internal-gain context term, bounded by the documented 0–20 occupants |
| `HUMIDITY_AFFECTS_AC_POWER` | `false` | humidity is validated and echoed but has **no term** in the formula |
| `MODELS_ROOM_TEMPERATURE_TRAJECTORY` | `false` | room temperature is an **external prescribed input**; no cooling-down simulation |

Room temperature and outdoor/ambient temperature are kept distinct: contract
1.0.1 has **no** outdoor/ambient field, so none is invented here, and
`validateRoomClimateCommand` rejects an `outdoor_temp_c` field explicitly
(`UNSUPPORTED_FIELD`). Group nominal power stays the **whole group** rating;
`quantity` is validated but never multiplied into power.

## 4. Formula

```
demand = clamp01( max(0, temp_c - setpoint_c) / 6 °C + occupancy × 0.03 )     // 0..1
power  = on  ?  nominal_power_w × (0.2 + 0.8 × demand)                        // W
             :  (standby_power_w ?? 0)                                        // W
```

- Demand is non-decreasing in `temp_c` and in `occupancy` for fixed other inputs.
- Documented modelled bounds: running power stays in
  `[0.2 × nominal, nominal]`; a device with no standby rating draws 0 W when off.
- The **demo model deliberately defines `nominal_power_w` as the modelled
  maximum**. That is a limitation of this model, not a physical claim that a
  real compressor cannot exceed its rating.
- Off/on is a **policy/override decision** made by the engine, not by this
  module; keeping the environment separate from policy is deliberate.
- The refrigerator (and every other non-AC device) is rejected outright so it
  cannot be accidentally routed through the AC model and keeps its existing
  power behaviour.

## 5. Worked examples (demo AC: `dev-open-ac`, 1500 W, quantity 1, no standby)

| Input | Result |
|---|---|
| `on: true, temp_c: 22` | demand 0 → **300 W** (part-load floor) |
| `on: true, temp_c: 26` (current default climate) | demand 1/3 → **700 W** |
| `on: true, temp_c: 27` | demand 0.5 → **900 W** |
| `on: true, temp_c: 30` | demand 1 → **1500 W** |
| `on: true, temp_c: 24, occupancy: 10` | demand 0.3 → **660 W** |
| `on: true, temp_c: 31, rh_pct: 10` vs `rh_pct: 95` | equal power **1500 W**; `rh_pct` echoed as 10 / 95 |
| `on: false` (no standby) | **0 W** |
| `quantity: 4` instead of `1` | identical power |
| `device_type: 'refrigerator'`, nominal 150 W | `EnvironmentInputError UNSUPPORTED_DEVICE` (keeps its existing constant draw) |
| `temp_c: 70` / `Number.NaN` / `rh_pct: 101` / `occupancy: 21` | rejected (`OUT_OF_RANGE` / `INVALID_TYPE`), never clamped |

Note for integration: at the current constant 26 °C the model would return
700 W for a running AC where the engine today returns a flat 1500 W. Wiring it
in therefore **changes simulated energy**; that decision belongs to K004
proper, not to this preparation branch.

## 6. Expected engine call site (identified by source inspection, not changed)

- `src/engine/engine.ts:137` — `powerOf(d, on) = on ? nominal_power_w : (standby_power_w ?? 0)`.
- `src/engine/engine.ts:408` — `stepOnce()` computes `powerOf(d, on)` per 10-second step and accumulates `energy`; this is the consumption call site.
- `src/engine/engine.ts:545` — `getState()` reports `power_w: powerOf(d, on)`; must stay consistent with the step model.
- Room occupancy is already available in the same loop (`run.rooms`, `engine.ts:400-406`, `this.room(run, d.room_id).occupancy`) and is the occupancy context the model expects.
- `run.environment` (`engine.ts:119`) is a single run-level constant, restored from the run config (`engine.ts:686-687`) and written into `room_intervals.avg_temp_c/avg_rh_pct` (`engine.ts:513`). **There is no per-room climate state**, so a room-scoped reading needs new state and storage.
- `isOn()` (policy/override) decides on/off; the AC model must receive that decision, never make it.

### Required future changes (NOT implemented here)

1. **Route**: implement contract `POST /api/v1/environment` (`{ room_id, temp_c, rh_pct }` → `{ room_id, seq }`) in `src/routes/simulation.ts`, validating with this module; plus the planned `Socket.IO` environment command.
2. **Persistence/migration**: per-room climate state (+ checkpoint fields) and, if readings change within a minute, room-interval climate must stay consistent with `avg_temp_c`/`avg_rh_pct`; a new forward migration is required. Do not recreate or delete existing databases.
3. **Engine wiring**: replace `powerOf` for `device_type === 'ac'` with `acPowerW`, passing the room's prescribed temperature, the device state from `isOn()` and occupancy; keep fridge/non-AC paths untouched, and keep `getState()` and the step model identical.
4. **UI**: environment controls belong to `simulation-frontend` and are not implemented.
5. **Validation bounds**: if the contract later defines different temperature/humidity bounds, they must be updated here together with the contract version, not invented locally.

## 7. Original/improved replay and determinism

- Identical explicit inputs always return an identical output; variability can only enter through caller-supplied inputs (no hidden RNG, no wall clock).
- For future original/improved scenario comparison, the **external** environment (prescribed room temperature/humidity timeline, and occupancy) must be recorded per run and replayed identically in both scenarios — e.g. as an explicit prescribed timeline in the run config/snapshot — so the two runs differ only by policy decisions. This module deliberately takes the climate and occupancy from its caller for that reason.
- Room temperature is an external prescribed input, **not** a modelled state; do not mix the two interpretations. Cooling trajectories and thermal physics remain deferred.

## 8. Tests and results (in this worktree)

- `test/environmentClimate.test.ts` — 6 tests: contract command/aggregate shapes, inclusive bounds and just-outside rejection, non-finite/non-number/missing fields, invented-field rejection (`setpoint_c`, `outdoor_temp_c`), defaults and the aggregate bridge without shared state.
- `test/environmentAcPower.test.ts` — 10 tests: standby behaviour, documented bounds (`-30..60 °C × occupancy 0/7/20`), monotonicity in temperature and occupancy, 200× determinism, caller-input/device immutability, quantity never multiplying, explicit non-AC rejection, invalid-value and inconsistent-rating rejection, defaults and unused inputs, humidity unused.
- Actual results: focused **16/16 passed**; full suite **77/77 passed** (61 pre-existing + 16 new); `npm run typecheck` clean; `npm run lint` 0 errors.
- No service was started, no port was bound, no database file was created or modified, and no benchmark was run.

## 9. Known limitations

- Synthetic demonstration behaviour only: no calibrated physics, no compressor cycling, no thermal mass, no humidity latent load, no outdoor weather.
- The setpoint, part-load floor, saturation delta and per-person term are invented demo values; they are not measured or contract-approved.
- The model is room-temperature-driven but the simulator currently has only one constant run-level climate, so today it can only be exercised with the aggregate/default climate until per-room controls exist.
- Modelled power alone does not imply thermal comfort was achieved; the model makes no comfort claim.
- Branch-local continuity is not evidence that `main` has this feature.

## 10. Continuity

- `docs/PROGRESS_LOG.md` in **this branch** records the K004-PREP entry; `docs/ACTIVE_TASK.md` in this branch carries a K004-PREP header above the preserved K002 record. Both are branch-local.
- Prior K002 work, the contract bundle and every file outside `src/environment/`, `test/environment*.test.ts` and `docs/` are unchanged in this branch.
- Exact next action: review this preparation, then (separately assigned) implement the environment route + per-room climate state and wire `acPowerW` into `stepOnce()`/`getState()` on a task branch — do not merge this branch into `main` unreviewed.
