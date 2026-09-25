import type { Migration } from './types.js';

// FROZEN once applied anywhere (checksum-guarded). K005-PREP batch history jobs.
//
// BRANCH-LOCAL NUMBER: this migration lives on `mohan/k005-history-prep` only.
// If K003/K004 add their own migration 004 first, renumber this one at
// integration time (before it is applied to any shared database). Never apply
// it to the normal or production database from this branch.
//
// One row per history-generation job. A job owns exactly one batch run
// (simulation_runs row with config.run_purpose = 'history_batch'); the link is
// explicit here, never inferred from timestamps. Batch runs NEVER write
// engine_checkpoints (the interactive engine's recovery source), and the
// trigger below makes that structural: an engine checkpoint cannot be created
// for a run that a history job owns, so restart recovery can never select a
// batch run as the interactive run.
//
// Progress columns count only COMMITTED work (updated in the same transaction
// as each published minute). A job is 'succeeded' only after all expected
// readings were committed; 'failed' rows keep their partial readings, and
// their coverage columns show exactly how far the run got. Terminal rows are
// final.
const sql = `
CREATE TABLE history_jobs (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  run_id TEXT REFERENCES simulation_runs (run_id),
  from_utc TEXT NOT NULL CHECK (from_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:00Z'
    AND unixepoch(from_utc) IS NOT NULL),
  to_utc TEXT NOT NULL CHECK (to_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:00Z'
    AND unixepoch(to_utc) IS NOT NULL),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds = 60),
  seed INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  request TEXT NOT NULL CHECK (json_valid(request) AND json_type(request) = 'object'),
  expected_steps INTEGER NOT NULL CHECK (expected_steps >= 1),
  expected_intervals INTEGER NOT NULL CHECK (expected_intervals >= 1),
  completed_steps INTEGER NOT NULL DEFAULT 0 CHECK (completed_steps BETWEEN 0 AND expected_steps),
  completed_intervals INTEGER NOT NULL DEFAULT 0 CHECK (completed_intervals BETWEEN 0 AND expected_intervals),
  processed_sim_utc TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_utc TEXT NOT NULL,
  started_utc TEXT,
  finished_utc TEXT,
  CHECK (unixepoch(to_utc) > unixepoch(from_utc)),
  CHECK (status <> 'succeeded' OR (run_id IS NOT NULL AND completed_intervals = expected_intervals
    AND completed_steps = expected_steps AND failure_code IS NULL)),
  CHECK (status <> 'failed' OR failure_code IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX history_jobs_run ON history_jobs (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX history_jobs_status ON history_jobs (status, created_utc);
CREATE TRIGGER history_jobs_terminal_is_final BEFORE UPDATE ON history_jobs
WHEN OLD.status IN ('succeeded', 'failed')
BEGIN SELECT RAISE(ABORT, 'a finished history job cannot be modified'); END;
CREATE TRIGGER history_jobs_no_delete BEFORE DELETE ON history_jobs
BEGIN SELECT RAISE(ABORT, 'history jobs are run history'); END;
CREATE TRIGGER engine_checkpoints_not_history_run BEFORE INSERT ON engine_checkpoints
WHEN EXISTS (SELECT 1 FROM history_jobs WHERE run_id = NEW.run_id)
BEGIN SELECT RAISE(ABORT, 'a history batch run never has an interactive engine checkpoint'); END;
`;

export const migration004: Migration = { version: 4, name: 'history_jobs_k005_branch_local', sql };
