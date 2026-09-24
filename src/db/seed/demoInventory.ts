import type { Device, Room } from '../inventory.js';

// MVP1 demo inventory — stable IDs from contracts/v1/CONTRACT.md §2.1.
// Powers/power factors are the contract's PROPOSED EDITABLE DEMO DEFAULTS
// (§2.2 assumptions), not measured ratings.
//
// Group semantics: nominal_power_w / standby_power_w are the rating of the
// WHOLE device or group; quantity is the member count, recorded for
// information only. Per-member power = nominal_power_w / quantity; never
// multiply nominal_power_w by quantity again. Workstation group: 8 x 120 W,
// stored as quantity 8, nominal_power_w 960.

export const DEMO_BUILDING = {
  building_id: 'nexyra-demo-office',
  name: 'NEXYRA demo office',
  timezone: 'Asia/Kolkata',
} as const;

/** Default policies take effect from any simulated date on or after this instant. */
export const SEED_EFFECTIVE_FROM_UTC = '2000-01-01T00:00:00Z';

export const DEMO_ROOMS: readonly Room[] = [
  { room_id: 'room-open-workspace', name: 'Open workspace', room_type: 'open_workspace', capacity: 12 },
  { room_id: 'room-meeting', name: 'Meeting room', room_type: 'meeting_room', capacity: 6 },
  { room_id: 'room-pantry', name: 'Pantry/dining', room_type: 'pantry', capacity: 4 },
  { room_id: 'room-reception', name: 'Reception', room_type: 'reception', capacity: 2 },
  { room_id: 'room-manager-cabin', name: "Manager's cabin", room_type: 'manager_cabin', capacity: 2 },
];

const light = (device_id: string, name: string, room_id: string): Device => ({
  device_id, name, room_id, device_type: 'lighting', quantity: 1, nominal_power_w: 72,
  power_factor: 0.9, always_on: false, control: 'scheduled', controls: ['switch'],
});
const ac = (device_id: string, room_id: string): Device => ({
  device_id, name: 'AC', room_id, device_type: 'ac', quantity: 1, nominal_power_w: 1500,
  power_factor: 0.95, always_on: false, control: 'scheduled', controls: ['switch'],
});
const fan = (device_id: string, room_id: string): Device => ({
  device_id, name: 'Fan', room_id, device_type: 'fan', quantity: 1, nominal_power_w: 75,
  power_factor: 0.8, always_on: false, control: 'scheduled', controls: ['switch'],
});
const computer = (device_id: string, name: string, room_id: string): Device => ({
  device_id, name, room_id, device_type: 'computer', quantity: 1, nominal_power_w: 150,
  standby_power_w: 5, power_factor: 0.9, always_on: false, control: 'scheduled', controls: ['switch'],
});

export const DEMO_DEVICES: readonly Device[] = [
  light('dev-open-light-a', 'Lighting zone A', 'room-open-workspace'),
  light('dev-open-light-b', 'Lighting zone B', 'room-open-workspace'),
  ac('dev-open-ac', 'room-open-workspace'),
  fan('dev-open-fan', 'room-open-workspace'),
  {
    device_id: 'dev-open-workstations', name: 'Workstation group', room_id: 'room-open-workspace',
    device_type: 'workstation_group', quantity: 8, nominal_power_w: 960, power_factor: 0.9,
    always_on: false, control: 'scheduled', controls: ['switch'],
  },
  light('dev-meeting-light', 'Lighting group', 'room-meeting'),
  ac('dev-meeting-ac', 'room-meeting'),
  {
    device_id: 'dev-meeting-projector', name: 'Projector', room_id: 'room-meeting', device_type: 'projector',
    quantity: 1, nominal_power_w: 300, standby_power_w: 5, power_factor: 0.9, always_on: false,
    control: 'manual', controls: ['switch'],
  },
  light('dev-pantry-light', 'Lighting group', 'room-pantry'),
  fan('dev-pantry-fan', 'room-pantry'),
  {
    device_id: 'dev-pantry-fridge', name: 'Refrigerator', room_id: 'room-pantry', device_type: 'refrigerator',
    quantity: 1, nominal_power_w: 150, power_factor: 1.0, always_on: true, control: 'always_on', controls: [],
  },
  {
    device_id: 'dev-pantry-microwave', name: 'Microwave', room_id: 'room-pantry', device_type: 'microwave',
    quantity: 1, nominal_power_w: 1200, standby_power_w: 3, power_factor: 1.0, always_on: false,
    control: 'manual', controls: ['switch'],
  },
  light('dev-reception-light', 'Lighting group', 'room-reception'),
  fan('dev-reception-fan', 'room-reception'),
  computer('dev-reception-pc', 'Reception computer', 'room-reception'),
  light('dev-manager-light', 'Lighting group', 'room-manager-cabin'),
  ac('dev-manager-ac', 'room-manager-cabin'),
  computer('dev-manager-pc', 'Computer', 'room-manager-cabin'),
];

export interface SeedPolicy {
  policy_id: string;
  kind: 'office_hours' | 'lighting_schedule' | 'device_schedule' | 'always_on' | 'occupancy';
  owner: { building_id: string } | { device_id: string };
  rules: Record<string, unknown>;
}

export const OFFICE_HOURS_POLICY_ID = 'pol-office-hours';

/** Building-level policies first: device schedules reference office hours version 1. */
export const DEMO_POLICIES: readonly SeedPolicy[] = [
  {
    policy_id: OFFICE_HOURS_POLICY_ID, kind: 'office_hours', owner: { building_id: DEMO_BUILDING.building_id },
    rules: { working_days_iso: [1, 2, 3, 4, 5], open_local: '09:00', close_local: '18:00', overnight: false },
  },
  {
    policy_id: 'pol-occupancy', kind: 'occupancy', owner: { building_id: DEMO_BUILDING.building_id },
    rules: { mode: 'manual', auto_allocate: true },
  },
  ...DEMO_DEVICES.map((d): SeedPolicy => {
    const policy_id = `pol-${d.device_id.replace(/^dev-/, '')}`;
    const owner = { device_id: d.device_id };
    if (d.device_type === 'lighting') {
      return { policy_id, kind: 'lighting_schedule', owner, rules: { on_during_hours: true, vacancy_grace_seconds: 300 } };
    }
    if (d.always_on) {
      return { policy_id, kind: 'always_on', owner, rules: { always_on_exception: true } };
    }
    return {
      policy_id, kind: 'device_schedule', owner,
      rules: {
        office_hours_ref: `${OFFICE_HOURS_POLICY_ID}:1`, on_windows: [],
        vacancy_grace_seconds: 300, allow_manual_override: true,
      },
    };
  }),
];
