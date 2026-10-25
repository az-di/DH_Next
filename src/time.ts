// Timezone helpers built on Intl only (no date library).

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

export function localParts(date: Date, timezone: string): LocalParts {
  let fmt = partsFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    partsFormatters.set(timezone, fmt);
  }
  const get = (type: string) => fmt.formatToParts(date).find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: WEEKDAYS.indexOf(get("weekday")),
  };
}

/** The UTC instant for a wall-clock time in `timezone`. Handles DST by re-checking the offset. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timezone: string,
  minute = 0,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timezone);
    const shownAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    guess += wallAsUtc - shownAsUtc;
  }
  return new Date(guess);
}

/** Local midnight `days` after the local date of `from`. */
export function startOfLocalDay(from: Date, timezone: string, days = 0): Date {
  const p = localParts(from, timezone);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedTimeToUtc(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), 0, timezone);
}

/** "Sat Nov 7, 7:00–9:00 PM" */
export function formatSlot(start: Date, end: Date, timezone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(start);
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  // Drop the AM/PM on the start time when both ends share it: "7:00–9:00 PM".
  const time = (d: Date, withPeriod: boolean) => {
    const s = timeFmt.format(d);
    return withPeriod ? s : s.replace(/\s?[AP]M$/, "");
  };
  const sameHalf = localParts(start, timezone).hour < 12 === localParts(end, timezone).hour < 12;
  return `${day}, ${time(start, !sameHalf)}–${time(end, true)}`;
}

/** "Fri 6:00 PM" */
export function formatDeadline(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
