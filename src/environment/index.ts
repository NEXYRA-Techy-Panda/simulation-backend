/**
 * K004-PREP environment/AC-consumption module (feature branch
 * `kishore/k004-environment-prep`).
 *
 * Prepared on a feature branch; NOT connected to the engine, routes, database
 * or UI, and NOT deployed. Pure, deterministic, side-effect free: no wall
 * clock, no randomness, no database, no global mutable state, no kWh.
 */
export * from './climate.js';
export * from './constants.js';
export * from './errors.js';
export * from './ac-power.js';
