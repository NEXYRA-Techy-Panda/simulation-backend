import { migration001 } from './001_initial.js';
import type { Migration } from './types.js';

export type { Migration } from './types.js';

/** Ordered, append-only list of schema migrations. */
export const migrations: readonly Migration[] = [migration001];
