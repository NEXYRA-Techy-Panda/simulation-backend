const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function isCanonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_SECOND.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  return new Date(milliseconds).toISOString().replace('.000Z', 'Z') === value;
}

export function seconds(utc: string): number {
  return Date.parse(utc) / 1000;
}

export function utcFromSeconds(value: number): string {
  if (!Number.isSafeInteger(value)) throw new Error(`UTC second is outside the safe range: ${value}`);
  return new Date(value * 1000).toISOString().replace('.000Z', 'Z');
}

export function addSeconds(utc: string, amount: number): string {
  return utcFromSeconds(seconds(utc) + amount);
}
