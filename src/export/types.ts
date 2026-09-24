export const EXPORT_INTERVALS = [60, 300, 600, 900, 1800, 3600] as const;
export type ExportIntervalSeconds = (typeof EXPORT_INTERVALS)[number];
export type ExportFormat = 'json' | 'csv';
export type ActivationMode = 'run_scoped' | 'legacy_unrecorded';

export interface ExportSelection {
  runId: string;
  format: ExportFormat;
  fromUtc: string;
  toUtc: string;
  intervalSeconds: ExportIntervalSeconds;
}

export interface ExportLimits {
  maxRangeSeconds: number;
  maxSourceDeviceRows: number;
  maxSourceRoomRows: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  maxRangeSeconds: 31 * 24 * 60 * 60,
  maxSourceDeviceRows: 1_000_000,
  maxSourceRoomRows: 1_000_000,
};

export interface RunRecord {
  run_id: string;
  building_id: string;
  building_name: string;
  timezone: 'Asia/Kolkata';
  scenario_id: 'original' | 'improved';
  comparison_id: string | null;
  run_start_utc: string;
  created_utc: string;
}

export interface RoomRecord {
  room_id: string;
  name: string;
  room_type: string;
  capacity: number;
  floor_area_m2?: number;
}

export interface DeviceRecord {
  device_id: string;
  room_id: string;
  name: string;
  device_type: string;
  quantity: number;
  nominal_power_w: number;
  standby_power_w?: number;
  power_factor: number;
  always_on: boolean;
  control: 'manual' | 'scheduled' | 'always_on';
  controls: string[];
}

export interface PolicyRecord {
  policy_id: string;
  version: number;
  applies_to: string;
  kind: 'office_hours' | 'lighting_schedule' | 'device_schedule' | 'always_on' | 'occupancy';
  effective_from_utc: string;
  rules: Record<string, unknown>;
}

export interface PinnedPolicyRecord extends PolicyRecord {
  global_effective_from_utc: string;
  active_from_utc: string | null;
}

export interface ExportMetadata {
  schema_version: '1.0.1';
  source: 'simulation';
  synthetic: true;
  synthetic_label: string;
  building: {
    building_id: string;
    name: string;
    timezone: 'Asia/Kolkata';
  };
  run: {
    run_id: string;
    scenario_id: 'original' | 'improved';
    comparison_id: string | null;
    run_start_utc: string;
  };
  export: {
    export_id: string;
    export_start_utc: string;
    export_end_utc: string;
    interval_seconds: ExportIntervalSeconds;
    created_utc: string;
  };
  rooms: RoomRecord[];
  devices: DeviceRecord[];
  policies: PolicyRecord[];
}

export interface RoomIntervalRecord {
  run_id: string;
  room_id: string;
  interval_start_utc: string;
  interval_end_utc: string;
  interval_seconds: number;
  occupancy_avg: number;
  occupancy_max: number;
  occupied_fraction: number;
  avg_temp_c: number;
  avg_rh_pct: number;
  partial: boolean;
}

export interface DeviceIntervalRecord {
  run_id: string;
  room_id: string;
  device_id: string;
  interval_start_utc: string;
  interval_end_utc: string;
  interval_seconds: number;
  avg_power_w: number;
  max_power_w: number;
  energy_kwh: number;
  cumulative_kwh: number;
  avg_voltage_v?: number;
  avg_current_a?: number;
  power_factor: number;
  on_fraction: number;
  override_seconds: number;
  vacant_on_seconds: number;
  offschedule_on_seconds: number;
  policy_ref: string;
  partial: boolean;
}

export interface DatasetExport {
  metadata: ExportMetadata;
  roomIntervals: RoomIntervalRecord[];
  deviceIntervals: DeviceIntervalRecord[];
}

export interface RunCatalogItem {
  run_id: string;
  scenario_id: 'original' | 'improved';
  comparison_id: string | null;
  run_start_utc: string;
  created_utc: string;
  status: 'active' | 'ended';
  committed_start_utc: string | null;
  committed_end_utc: string | null;
  committed_interval_count: number;
  exportable: boolean;
  unavailable_reason: string | null;
  activation_mode: ActivationMode;
}
