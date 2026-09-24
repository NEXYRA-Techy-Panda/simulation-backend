# K003 historical export evidence

- **Developer:** Kishore Kumar
- **Agent:** K-A — OpenCode
- **Baseline:** `929e78e7b6b19bf586e131a6bc256e2b211e3bcf`
- **Status:** implementation and focused verification complete; review pending
- **Contract:** 1.0.1, unchanged

## Implemented interface

### `GET /api/v1/runs?page=1&page_size=50`

Returns newest-first run records with lifecycle, scenario, run start/creation,
activation mode, committed device-row count, committed half-open coverage, and
an explicit `exportable` / `unavailable_reason`. Coverage comes from persisted
interval rows, not `sim_time_utc` or the checkpoint's unfinished accumulator.
Page size is bounded to 200.

### `GET /api/v1/export`

Strict query parameters:

```text
run_id=<id>&format=json|csv&from=<UTC>&to=<UTC>&interval_seconds=60|300|600|900|1800|3600
```

### `POST /api/v1/export`

The same fields in a closed JSON object. GET is the frontend wire format; POST
is additive parity for API clients. Unknown/duplicate fields are rejected.

Successful file responses are raw attachments (not `{data,meta}` envelopes):

```text
Content-Type: application/json; charset=utf-8 | text/csv; charset=utf-8
Content-Disposition: attachment; filename="..."
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

CORS exposes `Content-Disposition` and `X-Request-Id`. Preflight failures remain
JSON errors on-page and never download an error file.

## Snapshot and safety model

Production opens a separate `node:sqlite` read-only connection for each catalog
or export request. A manual read transaction fixes one WAL snapshot before
preflight. The simulation writer and engine connection are never used for the
read transaction, and no request advances/flushed the engine.

The export contains only committed `room_intervals` / `device_intervals`. A
pause/shutdown accumulator is excluded. A reset-published short edge remains
exportable with its real duration and `partial=true`.

Bounds: 31 days, 1,000,000 source device rows, 1,000,000 source room rows, an
8 MiB auditor-compatible metadata envelope, and two concurrent exports. JSON
and CSV are streamed through Node backpressure. CSV merges only the current
output bucket's room summaries; it never materializes the full room history.

## Run snapshots, K002 and legacy handling

- Inventory comes from `run_rooms` and `run_devices`, never today's tables.
- Every pinned policy is included.
- `run_policies.active_from_utc` becomes the contract policy
  `effective_from_utc`; immutable global revision history is unchanged.
- `device_schedule.office_hours_ref` must resolve inside the exported pins.
- Every stored interval in the whole run is checked against its effective time
  before any selected window is streamed.
- A legacy-null pin falls back to global time only for validation. Inconsistent
  legacy history is rejected and remains null; it is never repaired/backfilled.

## Aggregation and coverage

Source rows must form a complete one-minute grid for every snapshotted room and
device. The selected start aligns to the run's persisted minute grid; the end may
be a committed short final edge. Missing/overlap/off-grid rows, internal partial
rows, absent room matches, non-finite/invalid measurements, energy/counter
mismatches and incomplete requested coverage fail before headers.

For each output bucket:

- energy: sum;
- average power: duration-weighted;
- maximum power: maximum;
- on/occupied fractions: duration-weighted;
- operating durations: sum;
- cumulative counter: final source counter;
- room occupancy/climate: duration-weighted, occupancy max preserved;
- V/I: duration-weighted only when both exist for every source row, otherwise
  omitted; mixed presence fails;
- power factor and policy reference must remain unambiguous.

A coarse bucket that would mix policy refs is rejected with a finer-resolution
message. A room snapshot with no device is rejected because standalone CSV
cannot represent its room-only history without breaking JSON/CSV parity. The run
catalog also checks per-entity cardinality/endpoints, so a missing middle row is
not advertised as exportable. No intra-minute proration or zero fill occurs.

## Export identity

`export_id` is a SHA-256-derived identity over immutable run metadata, the full
selected snapshot content, range and nominal resolution. Format and wall
`created_utc` are excluded. Therefore:

- equivalent JSON/CSV for one unchanged selection share `run_id` + `export_id`;
- changed content, window or resolution gets a different identity;
- semantic content still receives the auditor's independent fingerprint.

All exports are explicitly `source: "simulation"`, `synthetic: true`, with a
label stating they are scenario-generated and not live meter data. No fault
truth is serialized.

## Numerical and contract verification

Committed new tests cover:

- schema-valid 0.03 kWh known fixture at all six resolutions;
- energy, counter, weighted values, maxima, operating-duration sums, V/I
  aggregation, high-precision power-factor parity and final cumulative behavior;
- first historical and final short partial edges;
- exact CSV header, first-row-only metadata, RFC 4180 quoting, Unicode/quotes;
- JSON/CSV identity and semantic parity;
- changed window/resolution identity;
- gap, device-less-room and mixed-policy rejection;
- run-list middle-gap detection and reader-open capacity release;
- K002 post-calendar reset activation;
- legacy-invalid rejection without mutation;
- GET/POST headers/errors and no engine mutation;
- stable WAL snapshot while the writer commits another minute.

Actual final gates:

```text
npm test                    77 passed, 0 failed
npm run typecheck           passed
npm run lint                passed
npm run build               passed
npm run verify:contract     75 passed, 0 failed
npm run validate:schema     24 passed, 0 failed
```

A temporary simulator HTTP run exported 18 one-minute device rows with total
`0.0027999999990000004` kWh. Equivalent JSON and CSV had the same export ID.

## Pinned auditor compatibility

Pinned `auditor-backend` source `67998d56ec03bf25525f0dc1bf2394c7ae2558bf`
was checked out into an isolated temporary clone. Its committed `parseJson`,
`parseCsv`, `validateAndFingerprint` pipeline accepted both real simulator
files:

```text
JSON errors: []
CSV errors: [] (13 expected repeated room summaries deduplicated)
JSON energy: 0.0027999999990000004 kWh
CSV energy:  0.0027999999990000004 kWh
same run_id/export_id: true
semantic fingerprint: ecaead52a2ae5f2b1f41eb41e8b2a0af651f9a72b91583566fce109da2a0d38d
```

A full auditor SQLite/HTTP re-import is **not claimed**. `npm ci` in the first
isolated clone attempted to compile pinned `better-sqlite3@13.0.3`; node-gyp
could not find a usable Python installation. A second clone used
`npm ci --ignore-scripts` only for the pure parser/validator check and never
claimed database acceptance. Mohan-owned repositories were not modified or run.

## Safety and remaining work

No production database, command, PM2, Nginx, webhook or deployment was touched.
All test databases/files were under the approved temp directory. K004 must not be
started from this evidence; Socket.IO, environment/comfort, batch generation,
faults and scenario comparison remain separate assignments.

Implementation/evidence commit: `9324d11` on top of deployment baseline
`929e78e`; review remains pending.
