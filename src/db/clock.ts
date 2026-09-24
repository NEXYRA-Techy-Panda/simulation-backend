/** Wall-clock UTC in the contract format YYYY-MM-DDTHH:MM:SSZ (record bookkeeping only). */
export function utcNow(now: Date = new Date()): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
