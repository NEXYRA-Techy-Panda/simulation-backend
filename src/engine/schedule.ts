import { KOLKATA_OFFSET_SECONDS } from './constants.js';

// Policy windows: when a device's schedule PERMITS automatic operation.
// Used for automatic control (K3–K4) and to measure offschedule_on_seconds.
// Overnight windows (close < open) belong to their OPENING day.

interface Window {
  days: number[];
  start_local: string;
  end_local: string;
  overnight: boolean;
}

export interface OfficeHoursRules {
  working_days_iso: number[];
  open_local: string;
  close_local: string;
  overnight: boolean;
}

/** Returns true when the device's policy expects it on at `epochSeconds`. */
export type ScheduleWindow = (epochSeconds: number) => boolean;

const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** ISO weekday (Mon=1..Sun=7) and minute-of-day in Asia/Kolkata. */
export function kolkataLocal(epochSeconds: number): { isoDay: number; minute: number } {
  const local = new Date((epochSeconds + KOLKATA_OFFSET_SECONDS) * 1000);
  return { isoDay: ((local.getUTCDay() + 6) % 7) + 1, minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

function inWindow(w: Window, epochSeconds: number): boolean {
  const { isoDay, minute } = kolkataLocal(epochSeconds);
  const open = minutesOf(w.start_local);
  const close = minutesOf(w.end_local);
  if (!w.overnight && close > open) return w.days.includes(isoDay) && minute >= open && minute < close;
  // Overnight (close <= open): the window starts on a listed day and ends the next morning.
  const previousDay = isoDay === 1 ? 7 : isoDay - 1;
  return (w.days.includes(isoDay) && minute >= open) || (w.days.includes(previousDay) && minute < close);
}

/** Office-hours window (ISO weekdays, Asia/Kolkata); null rules => never open. */
export function officeHoursWindow(oh: OfficeHoursRules | null): ScheduleWindow {
  return oh
    ? (t) => inWindow({ days: oh.working_days_iso, start_local: oh.open_local, end_local: oh.close_local, overnight: oh.overnight }, t)
    : never;
}

const never: ScheduleWindow = () => false;
const always: ScheduleWindow = () => true;

/**
 * Builds the permitted-operation window for a device policy. Decisions
 * (owner, P004/P008): an empty device on_windows follows the referenced
 * office-hours version; explicit on_windows further restrict it
 * (intersection with those office hours); lighting on_during_hours follows
 * the run's current office hours; always_on is always permitted.
 */
export function scheduleWindowFor(
  kind: string,
  rules: Record<string, unknown>,
  resolveOfficeHours: (ref: string | null) => OfficeHoursRules | null,
): ScheduleWindow {
  switch (kind) {
    case 'always_on':
      return always;
    case 'lighting_schedule':
      return rules.on_during_hours === true ? officeHoursWindow(resolveOfficeHours(null)) : never;
    case 'device_schedule': {
      const windows = (rules.on_windows as { days: number[]; start_local: string; end_local: string }[] | undefined) ?? [];
      const hours = officeHoursWindow(resolveOfficeHours(String(rules.office_hours_ref)));
      if (windows.length === 0) return hours;
      return (t) => hours(t) && windows.some((w) => inWindow({ ...w, overnight: minutesOf(w.end_local) < minutesOf(w.start_local) }, t));
    }
    default:
      return never;
  }
}
