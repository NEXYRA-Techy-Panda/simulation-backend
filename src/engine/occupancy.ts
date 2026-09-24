import { ApiError } from '../http/errors.js';
import { Rng, streamSeed } from './rng.js';

/** Office occupancy range (MVP1: up to 20 occupants). */
export const MAX_OCCUPANTS = 20;
/** Default scheduled-mode target count (editable assumption). */
export const DEFAULT_SCHEDULED_TARGET = 14;

/**
 * Predefined redistribution rules (scheduled mode, working hours only).
 * During a window, up to max_occupants present occupants (seeded choice)
 * move to the first room of room_type; at the end they return to their home
 * room (or the first room with space). Nobody is created or lost.
 */
export const REDISTRIBUTION_RULES = [
  { rule_id: 'meeting', start_local: '11:00', end_local: '12:00', room_type: 'meeting_room', max_occupants: 4 },
  { rule_id: 'lunch', start_local: '13:00', end_local: '14:00', room_type: 'pantry', max_occupants: 4 },
] as const;

/** Allocation priority: working rooms first, then shared rooms, then anything else by id. */
const ROOM_TYPE_PRIORITY = ['open_workspace', 'reception', 'manager_cabin', 'meeting_room', 'pantry'];

export type OccupancyMode = 'manual' | 'scheduled';

export interface RoomInfo {
  room_id: string;
  room_type: string;
  capacity: number;
}

export interface Occupant {
  occupant_id: string;
  /** Seeded "home seat" room; null when the office has fewer seats than occupants. */
  home_room_id: string | null;
  /** Current room, or null when outside the office. */
  room_id: string | null;
}

export interface Redistribution {
  rule_id: string;
  room_id: string | null;
  occupant_ids: string[];
}

/** Complete serialisable occupancy state (checkpointed). */
export interface OccupancyState {
  seed: number;
  rng_state: number;
  mode: OccupancyMode;
  manual_total: number;
  scheduled_target: number;
  occupants: Occupant[];
  redistribution: Redistribution | null;
}

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function orderRooms(rooms: readonly RoomInfo[]): RoomInfo[] {
  const rank = (r: RoomInfo): number => {
    const i = ROOM_TYPE_PRIORITY.indexOf(r.room_type);
    return i < 0 ? ROOM_TYPE_PRIORITY.length : i;
  };
  return [...rooms].sort((a, b) => rank(a) - rank(b) || a.room_id.localeCompare(b.room_id));
}

export class OccupancyModel {
  private readonly rooms: RoomInfo[];
  private readonly rng: Rng;
  private readonly s: OccupancyState;

  constructor(rooms: readonly RoomInfo[], state: OccupancyState) {
    this.rooms = orderRooms(rooms);
    this.s = structuredClone(state);
    this.rng = new Rng(state.rng_state);
  }

  /**
   * New run: 20 stable occupants (occ-01..occ-20), all outside, with seeded
   * home seats filled in allocation-priority order.
   */
  static initial(rooms: readonly RoomInfo[], seed: number, mode: OccupancyMode): OccupancyState {
    const rng = new Rng(streamSeed(seed, 'occupancy'));
    const seats = orderRooms(rooms).flatMap((r) => Array.from({ length: r.capacity }, () => r.room_id));
    const ids = Array.from({ length: MAX_OCCUPANTS }, (_, i) => `occ-${String(i + 1).padStart(2, '0')}`);
    const order = [...ids];
    for (let i = order.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const home = new Map(order.map((id, k) => [id, seats[k] ?? null]));
    return {
      seed, rng_state: rng.state, mode, manual_total: 0, scheduled_target: DEFAULT_SCHEDULED_TARGET,
      occupants: ids.map((id) => ({ occupant_id: id, home_room_id: home.get(id) ?? null, room_id: null })),
      redistribution: null,
    };
  }

  get state(): OccupancyState {
    return { ...structuredClone(this.s), rng_state: this.rng.state };
  }

  get mode(): OccupancyMode {
    return this.s.mode;
  }

  get capacityTotal(): number {
    return this.rooms.reduce((a, r) => a + r.capacity, 0);
  }

  get officeCount(): number {
    return this.s.occupants.filter((o) => o.room_id !== null).length;
  }

  counts(): Map<string, number> {
    const m = new Map(this.rooms.map((r) => [r.room_id, 0]));
    for (const o of this.s.occupants) if (o.room_id) m.set(o.room_id, (m.get(o.room_id) ?? 0) + 1);
    return m;
  }

  /** Rejects counts outside 0–20 (400) or beyond total room capacity (409); never overfills. */
  checkCount(n: unknown, field: string): number {
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > MAX_OCCUPANTS) {
      throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be an integer from 0 to ${MAX_OCCUPANTS}`, field);
    }
    if ((n as number) > this.capacityTotal) {
      throw new ApiError(409, 'CONFLICT', `${field} ${String(n)} exceeds the run's total room capacity of ${this.capacityTotal}`, field);
    }
    return n as number;
  }

  setManual(total: number): void {
    this.s.mode = 'manual';
    this.s.manual_total = total;
  }

  setScheduled(target: number): void {
    this.s.mode = 'scheduled';
    this.s.scheduled_target = target;
  }

  /**
   * Brings assignments in line with the mode at one step boundary:
   * manual → manual_total present, no redistribution; scheduled → target
   * while the office is open (else 0) plus the redistribution rule active at
   * localMinute. Existing assignments are kept wherever possible.
   */
  reconcile(officeOpen: boolean, localMinute: number): void {
    const scheduled = this.s.mode === 'scheduled';
    const desired = scheduled ? (officeOpen ? this.s.scheduled_target : 0) : this.s.manual_total;
    const rule = scheduled && officeOpen && desired > 0
      ? REDISTRIBUTION_RULES.find((r) => localMinute >= minutesOf(r.start_local) && localMinute < minutesOf(r.end_local)) ?? null
      : null;
    if (this.s.redistribution && this.s.redistribution.rule_id !== rule?.rule_id) this.endRedistribution();

    const present = this.officeCount;
    if (desired > present) this.arrive(desired - present);
    else if (desired < present) this.depart(present - desired);

    if (rule && !this.s.redistribution) this.startRedistribution(rule);
  }

  private free(roomId: string): number {
    return (this.rooms.find((r) => r.room_id === roomId)?.capacity ?? 0) - (this.counts().get(roomId) ?? 0);
  }

  /** Home room if it has space, otherwise the first room (priority order) with space. */
  private place(o: Occupant, exclude?: string): void {
    if (o.home_room_id && o.home_room_id !== exclude && this.free(o.home_room_id) > 0) {
      o.room_id = o.home_room_id;
      return;
    }
    const room = this.rooms.find((r) => r.room_id !== exclude && this.free(r.room_id) > 0)
      ?? this.rooms.find((r) => this.free(r.room_id) > 0);
    if (!room) throw new ApiError(409, 'CONFLICT', 'No room capacity left for another occupant');
    o.room_id = room.room_id;
  }

  private pick<T>(candidates: T[]): T {
    return candidates.splice(this.rng.int(candidates.length), 1)[0]!;
  }

  private arrive(n: number): void {
    const outside = this.s.occupants.filter((o) => o.room_id === null);
    for (let i = 0; i < n; i++) this.place(this.pick(outside));
  }

  private depart(n: number): void {
    const present = this.s.occupants.filter((o) => o.room_id !== null);
    for (let i = 0; i < n; i++) {
      const o = this.pick(present);
      o.room_id = null;
      if (this.s.redistribution) {
        this.s.redistribution.occupant_ids = this.s.redistribution.occupant_ids.filter((id) => id !== o.occupant_id);
      }
    }
  }

  private startRedistribution(rule: (typeof REDISTRIBUTION_RULES)[number]): void {
    const target = this.rooms.find((r) => r.room_type === rule.room_type);
    if (!target) {
      this.s.redistribution = { rule_id: rule.rule_id, room_id: null, occupant_ids: [] };
      return;
    }
    const candidates = this.s.occupants.filter((o) => o.room_id !== null && o.room_id !== target.room_id);
    const k = Math.min(rule.max_occupants, this.free(target.room_id), candidates.length);
    const moved: string[] = [];
    for (let i = 0; i < k; i++) {
      const o = this.pick(candidates);
      o.room_id = target.room_id;
      moved.push(o.occupant_id);
    }
    this.s.redistribution = { rule_id: rule.rule_id, room_id: target.room_id, occupant_ids: moved.sort() };
  }

  private endRedistribution(): void {
    const r = this.s.redistribution;
    this.s.redistribution = null;
    if (!r?.room_id) return;
    for (const id of r.occupant_ids) {
      const o = this.s.occupants.find((x) => x.occupant_id === id);
      if (o?.room_id === r.room_id) {
        o.room_id = null;
        this.place(o, o.home_room_id === r.room_id ? undefined : r.room_id);
      }
    }
  }
}
