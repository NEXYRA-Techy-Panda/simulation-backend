import { existsSync } from 'node:fs';

/** Loads optional local overrides from ./.env; variables already set in the environment win. */
export function loadLocalEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}
