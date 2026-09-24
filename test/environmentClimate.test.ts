import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ROOM_RH_PCT, DEFAULT_ROOM_TEMP_C, EnvironmentInputError, requireRhPct, requireTempC,
  roomClimateFromAggregate, validateRoomClimateAggregate, validateRoomClimateCommand,
} from '../src/environment/index.js';

const isEnvironmentError = (code: string, re: RegExp) => (err: unknown): boolean =>
  err instanceof EnvironmentInputError && err.code === code && re.test(err.message);

describe('environment room-climate validation', () => {
  it('accepts the contract command shape and returns only the closed fields', () => {
    const input = { room_id: 'room-open-workspace', temp_c: 26.5, rh_pct: 55 };
    const normalized = validateRoomClimateCommand(input);
    assert.deepEqual(normalized, { room_id: 'room-open-workspace', temp_c: 26.5, rh_pct: 55 });
    assert.deepEqual(Object.keys(normalized).sort(), ['rh_pct', 'room_id', 'temp_c']);
  });

  it('accepts the contract aggregate shape (avg_temp_c / avg_rh_pct)', () => {
    assert.deepEqual(validateRoomClimateAggregate({ avg_temp_c: 27.5, avg_rh_pct: 55 }), {
      avg_temp_c: 27.5, avg_rh_pct: 55,
    });
  });

  it('accepts both inclusive range boundaries and rejects just outside them', () => {
    assert.equal(requireTempC('temp_c', -30), -30);
    assert.equal(requireTempC('temp_c', 60), 60);
    assert.equal(requireRhPct('rh_pct', 0), 0);
    assert.equal(requireRhPct('rh_pct', 100), 100);
    assert.throws(() => requireTempC('temp_c', 60.5), isEnvironmentError('OUT_OF_RANGE', /\[-30, 60\] °C/));
    assert.throws(() => requireTempC('temp_c', -30.5), isEnvironmentError('OUT_OF_RANGE', /rejected, never clamped/));
    assert.throws(() => requireRhPct('rh_pct', 100.1), isEnvironmentError('OUT_OF_RANGE', /\[0, 100\] %/));
    assert.throws(() => requireRhPct('rh_pct', -1), isEnvironmentError('OUT_OF_RANGE', /got -1/));
  });

  it('rejects non-finite values, non-numbers and missing fields with actionable errors', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.throws(() => requireTempC('temp_c', bad), isEnvironmentError('INVALID_TYPE', /finite number/));
    }
    assert.throws(() => requireRhPct('rh_pct', '55'), isEnvironmentError('INVALID_TYPE', /got "55"/));
    assert.throws(() => requireRhPct('rh_pct', null), isEnvironmentError('INVALID_TYPE', /got null/));
    assert.throws(
      () => validateRoomClimateCommand({ room_id: 'room-meeting', temp_c: 26 }),
      isEnvironmentError('INVALID_TYPE', /rh_pct must be a finite number; got undefined/),
    );
    assert.throws(() => validateRoomClimateCommand('not-an-object'), isEnvironmentError('INVALID_TYPE', /must be an object/));
    assert.throws(
      () => validateRoomClimateCommand({ room_id: '  ', temp_c: 26, rh_pct: 55 }),
      isEnvironmentError('INVALID_TYPE', /room_id must be a non-empty string/),
    );
  });

  it('rejects invented fields instead of adding them to the closed schema', () => {
    assert.throws(
      () => validateRoomClimateCommand({ room_id: 'room-meeting', temp_c: 26, rh_pct: 55, setpoint_c: 24 }),
      isEnvironmentError('UNSUPPORTED_FIELD', /no field "setpoint_c"/),
    );
    // There is no outdoor/ambient temperature field in contract 1.0.1.
    assert.throws(
      () => validateRoomClimateCommand({ room_id: 'room-meeting', temp_c: 26, rh_pct: 55, outdoor_temp_c: 38 }),
      isEnvironmentError('UNSUPPORTED_FIELD', /no field "outdoor_temp_c"/),
    );
    assert.throws(
      () => validateRoomClimateAggregate({ avg_temp_c: 26, avg_rh_pct: 55, avg_temp_f: 79 }),
      isEnvironmentError('UNSUPPORTED_FIELD', /no field "avg_temp_f"/),
    );
  });

  it('exposes the documented synthetic defaults and the aggregate bridge without shared state', () => {
    const first = validateRoomClimateAggregate({ avg_temp_c: DEFAULT_ROOM_TEMP_C, avg_rh_pct: DEFAULT_ROOM_RH_PCT });
    const bridge = roomClimateFromAggregate(first);
    assert.deepEqual(bridge, { temp_c: 26, rh_pct: 55 });
    bridge.temp_c = 99;
    assert.deepEqual(validateRoomClimateAggregate({ avg_temp_c: 26, avg_rh_pct: 55 }), first);
  });
});
