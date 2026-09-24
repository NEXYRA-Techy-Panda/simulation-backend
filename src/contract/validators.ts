import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

// Validators compiled from the read-only contract schema (contracts/v1). The
// path resolves the same from src/contract/ (tsx) and dist/contract/ (build).
const schemaUrl = new URL('../../contracts/v1/dataset.schema.json', import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, 'utf8')) as { $id: string };

const ajv = new Ajv2020.default({ strict: true, allErrors: true });
ajv.addSchema(schema);
const compile = (pointer: string): ValidateFunction => {
  const fn = ajv.getSchema(`${schema.$id}#${pointer}`);
  if (!fn) throw new Error(`Contract schema has no ${pointer}`);
  return fn;
};

export type PolicyKind = 'office_hours' | 'lighting_schedule' | 'device_schedule' | 'always_on' | 'occupancy';

const rulesDefs: Record<PolicyKind, string> = {
  office_hours: '/$defs/officeHoursRules',
  lighting_schedule: '/$defs/lightingScheduleRules',
  device_schedule: '/$defs/deviceScheduleRules',
  always_on: '/$defs/alwaysOnRules',
  occupancy: '/$defs/occupancyRules',
};

const cache = new Map<string, ValidateFunction>();
const validator = (pointer: string): ValidateFunction => {
  let fn = cache.get(pointer);
  if (!fn) {
    fn = compile(pointer);
    cache.set(pointer, fn);
  }
  return fn;
};

export class ContractValidationError extends Error {
  constructor(what: string, readonly errors: string[]) {
    super(`${what} does not match contract 1.0.1: ${errors.join('; ')}`);
  }
}

function check(pointer: string, value: unknown, what: string): void {
  const fn = validator(pointer);
  if (!fn(value)) {
    throw new ContractValidationError(what, (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? e.keyword}`));
  }
}

export const isPolicyKind = (kind: string): kind is PolicyKind => Object.hasOwn(rulesDefs, kind);

export function assertRules(kind: PolicyKind, rules: unknown): void {
  check(rulesDefs[kind], rules, `${kind} rules`);
}
export const assertRoom = (room: unknown): void => check('/properties/rooms/items', room, 'room');
export const assertDevice = (device: unknown): void => check('/properties/devices/items', device, 'device');
export const assertPolicy = (policy: unknown): void => check('/properties/policies/items', policy, 'policy');
