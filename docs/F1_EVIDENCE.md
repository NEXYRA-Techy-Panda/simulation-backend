# F1_EVIDENCE — simulation-backend (contract canonical)

Written before commit; final commit hashes are returned in the F1 evidence
report, not invented here.

## F1 status

Contract v1.0.0 authored and verified 2026-09-24. Task completed, review pending.
THIS repo holds the canonical copy at `contracts/v1/`; the other four repos
hold byte-identical mirrors (proven by manifest hash checks in each repo).

## Python verification (agent-run, current terminal)

- Supplied interpreter:
  `C:\Users\vikram\AppData\Local\Programs\Python\Python313\python.exe`
- Results: `Python 3.13.15`, 64-bit, pip `26.2.1`, SQLite `3.50.4`,
  `venv` import OK. Matches Mohan's terminal evidence.
- PATH `python`/`pip` shims still stale (Store stub); PATH not modified.
- Status levels: user-verified installation + agent verification done;
  dependency compatibility is F2 work. Python 3.13 is the setup target.
- F1 needs no Python.

## Contract artifacts (canonical; full hashes in manifest)

- contracts/v1/CONTRACT.md — identity/time, inventory, measurement,
  JSON/CSV/import rules, Python result semantics, fixtures (`a10dc136…8d19`)
- contracts/v1/dataset.schema.json — draft 2020-12 envelope, strict
  `additionalProperties: false` on records (`dd4feedd…dd35b0`)
- contracts/v1/CSV_COLUMNS.md — exact 28-column header, quoting, meta columns,
  coverage rule (`4e217d7b…064f6e15c`)
- contracts/v1/API.md — simulator/auditor/Python routes + Socket.IO
  (`49e54a7d…ba4c831ff`)
- contracts/v1/fixtures/reference.json — two rooms/devices, two 60 s intervals,
  Monday 2026-09-21 09:00–09:02 IST (`14dec040…892b80504c`)
- contracts/v1/fixtures/reference.csv — 4 rows, same fixture
  (`f7f6883a…f3942998202`)
- contracts/v1/fixtures/expected.json — 0.02/0.01/0.03 kWh, Rs 0.30,
  one rule finding + one explicit non-finding (`522fb8dc…395e8289a`)
- scripts/verify-contract.mjs — dependency-free checks
  (`c6f10494…28c632e15dafc`)
- contracts/v1/manifest.json — version + canonical path + hashes (excludes itself)
- .gitignore — node_modules, .env, sqlite/dbs, venvs, data/

## Verification commands and actual results

- `node scripts/verify-contract.mjs` (Node v24.21.0, built-ins only, no
  install) run in all five repo roots: **49 passed, 0 failed in each**.
- Covers: hand totals, counter reconciliation per interval, key uniqueness,
  policy-ref resolution, contiguity, energy formula + V·I·pf tolerance,
  manifest hash match (8 files), exact CSV header, 4-row keyed CSV/JSON parity
  (1e-9), meta_run consistency + export-identity match, forbidden fault-label
  scan, findings-only-in-expected check.
- Explicitly semantic checks only — formal JSON Schema validation not run (F2).
- No scaffolding, installs, migrations, training, servers, or deployment.

## Canonical JSON top-level shape

`schema_version, source, synthetic, synthetic_label?, building, run, export,
rooms[], devices[], policies[], room_intervals[], device_intervals[]`.

## CSV header and encoding

UTF-8, header row, RFC 4180 quoting, decimal dots, `true`/`false`, empty =
null. 28 columns starting `run_id,building_id,scenario_id,...` and ending
`...,policy_ref,partial,meta_run,meta_policy` (exact header asserted by script).

## Key decisions locked by v1.0.0

Half-open UTC intervals; complete-only except edge `partial`; pause advances no
time; missing ≠ zero; reset → new run; keys `(run_id, device|room_id,
interval_start)`; identical duplicates deduped, conflicts error; no
cross-dataset dedup by device ID; immutable policy versions; tolerance 1e-6
kWh / 1% power-derived; export-only rounding; CSV aligned-grid coverage; no
total rows; no fault-label fields; tariff changes never alter identity or
retrain; next_calendar_month is a local calendar month.

## Checks not performed

Formal schema-validator run; runtime HTTP/Socket.IO integration; Python
dependency install; tariff/forecast behaviour beyond arithmetic. All F2+.

## Mirror consistency

All four mirrors verify 49/49 against the same manifest. Later changes need a
version entry + coordinated updates; a newer file alone proves no compatibility.

## Commit / push

Authorised by F1 ("docs: establish foundation and v1 data contracts").
Recorded in the F1 evidence report with verified remote hashes.

---

## F1-R1 corrections (2026-09-24, review pending; version stays 1.0.0)

- (A) CSV is self-contained: `meta_run` envelope on the first data row only,
  `meta_policy` removed (27-column header), scalar `policy_ref` resolves
  against the envelope; slice-without-envelope rejected.
- (B) 12 dp kWh exports; unrounded internal accumulation; tolerances 1e-9
  per-value, n·1e-9 totals, 1e-9 triple-relative; in-memory 7 W × 44,640
  check (analytic 5.208 kWh vs budget 2.232e-8) passes. Fixture V/I/pf is an
  exact triple (200 V × 3/1.5 A × 1.0).
- Verifier extended: CSV-alone reconstruction + full semantic parity vs the
  JSON oracle, duplicate handling, 4 negative checks — all fail as required.
- Final: 54 passed, 0 failed in all five repos (built-ins only; formal schema
  validation still F2). Manifest regenerated; mirror hashes match.
- Repo-local git identity configured.
- Commit/push outcome recorded in the F1-R1 evidence report.
