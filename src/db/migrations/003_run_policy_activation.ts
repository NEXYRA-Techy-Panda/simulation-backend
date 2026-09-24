import type { Migration } from './types.js';

// FROZEN once applied anywhere (checksum-guarded). K002 run-scoped policy activation.
//
// Why this exists
// ---------------
// run_policies records exactly which immutable policy version governs a run.
// Until K002 it recorded only (run_id, policy_id, version). `policy_versions`
// carries a GLOBAL effective_from_utc — the instant the revision was minted on
// the timeline of whichever run created it. Run creation pinned the newest
// global revision of every policy, so a run that starts at the fixed initial
// time adopted a revision whose global effective time lay later in the
// PREVIOUS run's timeline, while applying it from its own first instant. Its
// readings then referenced a revision that was "not yet effective" for them
// (the run-policy timing defect) and the run pinned no earlier revision at all,
// so the applied configuration was not representable.
//
// The distinction this column makes
// ---------------------------------
// Two different things share the word "effective":
//   * policy_versions.effective_from_utc — REVISION IDENTITY: when this
//     immutable configuration revision was created on the global revision
//     history (which run's timeline produced it). Immutable, never edited.
//   * run_policies.active_from_utc — RUN-SCOPED ACTIVATION: the instant, on
//     THIS run's timeline, from which the pinned revision governed the run.
//       - every revision adopted when a run is created activates at the run's
//         start (a run's configuration baseline is its start);
//       - a revision minted mid-run by a calendar/occupancy change activates at
//         the minute boundary where it takes effect.
//
// Guarantees this enables: a pinned revision is never applied before its
// activation, every device interval's policy reference resolves to a revision
// pinned in the same run, and the dataset built from a run's snapshots reports
// effective times that agree with what actually governed each interval.
//
// Legacy rows: existing rows get NULL, which means "run-scoped activation was
// not recorded". Rows are immutable (run_policies_no_update), so nothing is
// backfilled and no historical run is silently rewritten or re-certified. A run
// with any NULL activation is identified as pre-K002 and is validated against
// the global revision times instead; if that fails, the run stays invalid for
// historical export (see docs/K002_POLICY_TIMING_EVIDENCE.md).
//
// New rows must record an activation: the trigger below rejects a NULL, a
// malformed or a non-calendar value, so the guarantee cannot be lost by a new
// insert path. ON CONFLICT DO NOTHING keeps the FIRST activation for a pin
// (re-pinning the same revision is a no-op and never moves its activation).
const sql = `
ALTER TABLE run_policies ADD COLUMN active_from_utc TEXT;

CREATE TRIGGER run_policies_activation_required BEFORE INSERT ON run_policies
WHEN NEW.active_from_utc IS NULL
  OR NEW.active_from_utc NOT GLOB
    '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'
  OR unixepoch(NEW.active_from_utc) IS NULL
BEGIN SELECT RAISE(ABORT, 'run policy pins must record the run-scoped activation time (UTC)'); END;
`;

export const migration003: Migration = { version: 3, name: 'run_policy_activation', sql };
