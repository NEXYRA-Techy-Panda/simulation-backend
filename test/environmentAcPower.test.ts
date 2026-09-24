import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  acPowerBoundsW, acPowerDetail, acPowerW, coolingDemandFraction, DEFAULT_AC_SETPOINT_C,
  EnvironmentInputError, HUMIDITY_AFFECTS_AC_POWER, MIN_LOAD_FRACTION, type AcDeviceRating,
} from '../src/environment/index.js';

/** The demo inventory AC (src/db/seed/demoInventory.ts): 1500 W whole-device rating, no standby. */
const demoAc = (overrides: Partial<AcDeviceRating> = {}): AcDeviceRating => ({
  device_id: 'dev-open-ac', device_type: 'ac', quantity: 1, nominal_power_w: 1500, ...overrides,
});

const isEnvironmentError = (code: string, re: RegExp) => (err: unknown): boolean =>
  err instanceof EnvironmentInputError && err.code === code && re.test(err.message);

describe('environment AC power model', () => {
  it('uses the device standby behaviour when off, including the absent-standby default of 0 W', () => {
    const off = acPowerDetail({ device: demoAc(), on: false, temp_c: 33 });
    assert.equal(off.on, false);
    assert.equal(off.power_w, 0);
    assert.equal(acPowerW({ device: demoAc({ standby_power_w: 4 }), on: false, temp_c: 33 }), 4);
    // Off ignores cooling inputs: a hot room with a standby rating still only draws standby.
    assert.equal(acPowerW({ device: demoAc({ standby_power_w: 4 }), on: false, temp_c: 33, occupancy: 20 }), 4);
  });

  it('stays inside the documented running bounds and is finite and non-negative everywhere', () => {
    const bounds = acPowerBoundsW(demoAc());
    assert.deepEqual(bounds, { standby_power_w: 0, min_on_power_w: 1500 * MIN_LOAD_FRACTION, max_power_w: 1500 });
    for (let temp = -30; temp <= 60; temp += 0.5) {
      for (const occupancy of [0, 7, 20]) {
        const power = acPowerW({ device: demoAc(), on: true, temp_c: temp, occupancy });
        assert.ok(Number.isFinite(power) && power >= 0, `power must be finite and >= 0; got ${power} at ${temp} °C`);
        assert.ok(power >= bounds.min_on_power_w - 1e-9 && power <= bounds.max_power_w + 1e-9,
          `power ${power} must stay within [${bounds.min_on_power_w}, ${bounds.max_power_w}]`);
      }
    }
    // Below the setpoint the model still applies the documented part-load floor
    // (a running AC is never 0 W); a demo choice, not a measurement.
    assert.equal(acPowerW({ device: demoAc(), on: true, temp_c: 20 }), 1500 * MIN_LOAD_FRACTION);
  });

  it('never reduces modelled cooling power as cooling demand increases', () => {
    let previousDemand = -1;
    let previousPower = -1;
    for (let temp = -30; temp <= 60; temp += 0.25) {
      const demand = coolingDemandFraction({ temp_c: temp, occupancy: 5 });
      const power = acPowerW({ device: demoAc(), on: true, temp_c: temp, occupancy: 5 });
      assert.ok(demand >= previousDemand - 1e-12, `demand must not decrease at ${temp} °C`);
      assert.ok(power >= previousPower - 1e-9, `power must not decrease at ${temp} °C`);
      previousDemand = demand;
      previousPower = power;
    }
    // Occupancy is additive context: more occupants never lowers the demand.
    assert.ok(coolingDemandFraction({ temp_c: 24, occupancy: 20 }) > coolingDemandFraction({ temp_c: 24, occupancy: 0 }));
    assert.equal(coolingDemandFraction({ temp_c: 30, occupancy: 20 }), 1);
    assert.equal(coolingDemandFraction({ temp_c: 18, occupancy: 0 }), 0);
    // Saturation: past full demand, more temperature changes nothing.
    assert.equal(acPowerW({ device: demoAc(), on: true, temp_c: 30 }), acPowerW({ device: demoAc(), on: true, temp_c: 60 }));
  });

  it('is deterministic across repeated calls with the same explicit inputs', () => {
    const input = { device: demoAc(), on: true, temp_c: 31.5, rh_pct: 62, occupancy: 9 };
    const first = acPowerDetail(input);
    for (let i = 0; i < 200; i += 1) assert.deepEqual(acPowerDetail(input), first);
  });

  it('does not mutate the caller input object or the caller device object', () => {
    const device = demoAc();
    const input = { device, on: true, temp_c: 31.5, rh_pct: 62, occupancy: 9 };
    const before = JSON.stringify(input);
    acPowerDetail(input);
    acPowerW(input);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(device, demoAc());
  });

  it('never multiplies group quantity into power', () => {
    const single = acPowerW({ device: demoAc({ quantity: 1 }), on: true, temp_c: 32 });
    const group = acPowerW({ device: demoAc({ quantity: 4 }), on: true, temp_c: 32 });
    assert.equal(group, single);
    assert.equal(acPowerBoundsW(demoAc({ quantity: 4 })).max_power_w, 1500);
    // Quantity must be a real member count, not a hidden multiplier.
    assert.throws(
      () => acPowerW({ device: demoAc({ quantity: 0 }), on: true, temp_c: 32 }),
      isEnvironmentError('OUT_OF_RANGE', /quantity must be an integer >= 1/),
    );
  });

  it('rejects non-AC device types explicitly (refrigerator, lighting, fan, workstation group)', () => {
    for (const device_type of ['refrigerator', 'lighting', 'fan', 'computer', 'workstation_group', 'projector', 'microwave']) {
      const device: AcDeviceRating = { device_id: `dev-test-${device_type}`, device_type, quantity: 1, nominal_power_w: 150 };
      assert.throws(() => acPowerW({ device, on: true, temp_c: 30 }),
        isEnvironmentError('UNSUPPORTED_DEVICE', /supports only ac/));
    }
    assert.throws(
      () => acPowerW({ device: { device_id: 'dev-pantry-fridge', device_type: 'refrigerator', quantity: 1, nominal_power_w: 150 }, on: true, temp_c: 30 }),
      isEnvironmentError('UNSUPPORTED_DEVICE', /dev-pantry-fridge/),
    );
  });

  it('rejects invalid environment values and inconsistent device ratings instead of clamping', () => {
    assert.throws(() => acPowerW({ device: demoAc(), on: true, temp_c: 70 }),
      isEnvironmentError('OUT_OF_RANGE', /temp_c must be within \[-30, 60\]/));
    assert.throws(() => acPowerW({ device: demoAc(), on: true, temp_c: Number.NaN }),
      isEnvironmentError('INVALID_TYPE', /finite number/));
    assert.throws(() => acPowerW({ device: demoAc(), on: true, temp_c: 30, rh_pct: 101 }),
      isEnvironmentError('OUT_OF_RANGE', /rh_pct must be within \[0, 100\]/));
    assert.throws(() => acPowerW({ device: demoAc(), on: true, temp_c: 30, occupancy: 21 }),
      isEnvironmentError('OUT_OF_RANGE', /occupancy must be an integer within \[0, 20\]/));
    assert.throws(() => acPowerW({ device: demoAc(), on: true, temp_c: 30, occupancy: 2.5 }),
      isEnvironmentError('OUT_OF_RANGE', /occupancy must be an integer/));
    assert.throws(() => acPowerW({ device: demoAc({ standby_power_w: 2000 }), on: false, temp_c: 30 }),
      isEnvironmentError('OUT_OF_RANGE', /standby_power_w must be within \[0, nominal_power_w=1500\]/));
    assert.throws(() => acPowerW({ device: demoAc(), on: true, temp_c: 30, setpoint_c: -40 }),
      isEnvironmentError('OUT_OF_RANGE', /setpoint_c must be within \[-30, 60\]/));
  });

  it('uses explicit defaults for the setpoint and the unused inputs', () => {
    const implicitDefault = acPowerDetail({ device: demoAc(), on: true, temp_c: 30 });
    assert.deepEqual(implicitDefault, acPowerDetail({ device: demoAc(), on: true, temp_c: 30, setpoint_c: DEFAULT_AC_SETPOINT_C }));
    assert.equal(implicitDefault.rh_pct, null);
    assert.equal(implicitDefault.occupancy, 0);
    assert.equal(implicitDefault.setpoint_c, 24);
    assert.equal(implicitDefault.min_power_w, 300);
    assert.equal(implicitDefault.max_power_w, 1500);
  });

  it('reports humidity as unused: identical power for different valid humidity values', () => {
    assert.equal(HUMIDITY_AFFECTS_AC_POWER, false);
    const dry = acPowerDetail({ device: demoAc(), on: true, temp_c: 31, rh_pct: 10 });
    const humid = acPowerDetail({ device: demoAc(), on: true, temp_c: 31, rh_pct: 95 });
    assert.equal(dry.power_w, humid.power_w);
    assert.equal(dry.demand_fraction, humid.demand_fraction);
    assert.equal(dry.rh_pct, 10);
    assert.equal(humid.rh_pct, 95);
    assert.equal(dry.humidity_affects_power, false);
  });
});
