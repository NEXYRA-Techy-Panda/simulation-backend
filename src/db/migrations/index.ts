import { migration001 } from './001_initial.js';
import { migration002 } from './002_engine_checkpoints.js';
import { migration003 } from './003_run_policy_activation.js';
import { migration004 } from './004_history_jobs.js';
import type { Migration } from './types.js';

export type { Migration } from './types.js';

/** Ordered, append-only list of schema migrations. 004 is branch-local (K005-PREP) until integrated. */
export const migrations: readonly Migration[] = [migration001, migration002, migration003, migration004];
