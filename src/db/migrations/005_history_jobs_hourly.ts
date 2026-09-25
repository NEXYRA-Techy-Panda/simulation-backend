import type { Migration } from './types.js';

// FROZEN once applied anywhere (checksum-guarded). K004-FAST1 hourly history jobs.
//
// BRANCH-LOCAL NUMBER (with 004): lives on `mohan/k005-history-prep` only;
// renumber both at integration if main has taken 004/005 first. Never applied
// to the normal or production database from this branch.
//
// 004 limited history_jobs.interval_seconds to 60. Applied migrations are never
// edited, so this rebuilds the table with interval_seconds IN (60, 3600) and the
// same columns, constraints, indexes and triggers; existing rows are copied
// unchanged. The engine_checkpoints guard trigger references the table, so it is
// dropped and recreated around the rebuild.
const sql = `
DROP TRIGGER engine_checkpoints_not_history_run;
DROP TRIGGER history_jobs_terminal_is_final;
DROP TRIGGER history_jobs_no_delete;
CREATE TABLE history_jobs_v2 (
  job_id TEXT PRIMARY KEY CHECK (length(job_id) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  run_id TEXT REFERENCES simulation_runs (run_id),
  from_utc TEXT NOT NULL CHECK (from_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:00Z'
    AND unixepoch(from_utc) IS NOT NULL),
  to_utc TEXT NOT NULL CHECK (to_utc GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:00Z'
    AND unixepoch(to_utc) IS NOT NULL),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds IN (60, 3600)),
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
INSERT INTO history_jobs_v2 SELECT job_id, status, run_id, from_utc, to_utc, interval_seconds, seed, request,
  expected_steps, expected_intervals, completed_steps, completed_intervals, processed_sim_utc, failure_code,
  failure_message, created_utc, started_utc, finished_utc FROM history_jobs ORDER BY rowid;
DROP TABLE history_jobs;
ALTER TABLE history_jobs_v2 RENAME TO history_jobs;
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

export const migration005: Migration = { version: 5, name: 'history_jobs_hourly_k004_fast1_branch_local', sql };
