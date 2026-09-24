import type { Migration } from './types.js';

// FROZEN once applied anywhere (checksum-guarded). K1 engine checkpoint.
//
// One row per run holding the engine's recoverable state at a step boundary:
// processed simulated time, sequence, speed, device base/override states,
// run-relative cumulative counters and the current partial-minute
// accumulator (JSON). Minute intervals and the checkpoint are written in the
// same transaction, so recovery never double-counts a persisted minute.
// lifecycle 'ended' marks a run closed by reset; it can never become active
// again. At most one run is active at a time.
const sql = `
CREATE TABLE engine_checkpoints (
  run_id TEXT PRIMARY KEY REFERENCES simulation_runs (run_id),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'ended')),
  seq INTEGER NOT NULL CHECK (seq >= 0),
  sim_time_utc TEXT NOT NULL CHECK (sim_time_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
    AND unixepoch(sim_time_utc) IS NOT NULL),
  speed INTEGER NOT NULL CHECK (speed IN (1, 2, 10, 60, 100, 1000)),
  state TEXT NOT NULL CHECK (json_valid(state) AND json_type(state) = 'object'),
  updated_utc TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX engine_checkpoints_one_active ON engine_checkpoints (lifecycle) WHERE lifecycle = 'active';
CREATE TRIGGER engine_checkpoints_ended_is_final BEFORE UPDATE ON engine_checkpoints
WHEN OLD.lifecycle = 'ended'
BEGIN SELECT RAISE(ABORT, 'an ended run cannot be modified or resumed'); END;
CREATE TRIGGER engine_checkpoints_no_delete BEFORE DELETE ON engine_checkpoints
BEGIN SELECT RAISE(ABORT, 'engine checkpoints are run history'); END;
`;

export const migration002: Migration = { version: 2, name: 'engine_checkpoints', sql };
