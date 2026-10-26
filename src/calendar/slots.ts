import type { BusyBlock, MemberRole, ParsedRequest } from "../types.ts";
import type { Availability } from "./availability.ts";

// Deterministic slot finding: no LLM. Walk the requested window in fixed
// steps, score each candidate by who is free and how reasonable the hour is,
// then pick a spread of non-overlapping top slots.

export interface ScoredSlot {
  start: Date;
  end: Date;
  score: number;
  /** Members with calendars who are free / busy for this slot. */
  freeCount: number;
  busyUserIds: string[];
}

export interface FindSlotsInput {
  request: ParsedRequest;
  timezone: string;
  availability: Availability;
  roles: Map<string, MemberRole>;
  /** Intervals already rejected in earlier rounds; overlapping candidates are dropped. */
  exclude?: { start: Date; end: Date }[];
  /** Don't propose anything starting before this (defaults to now). */
  notBefore?: Date;
  stepMinutes?: number;
}

const EARLIEST_REASONABLE_HOUR = 8;
const LATEST_REASONABLE_END_HOUR = 23;
/** Local hours for an activity with no usual time ("hangout"). */
export const DEFAULT_ACTIVITY_HOURS = { from: 9, to: 22 };

/**
 * The local hours a slot must fit inside: the request's preferred hours (the
 * activity's usual time, or the time the request explicitly asked for), else
 * the default. Never narrower than the activity's duration.
 */
export function activityHours(request: ParsedRequest): { from: number; to: number } {
  const { preferredStartHour: from, preferredEndHour: to } = request;
  const hours = from !== null && to !== null && from < to ? { from, to } : DEFAULT_ACTIVITY_HOURS;
  return { from: hours.from, to: Math.max(hours.to, hours.from + request.durationMinutes / 60) };
}

const overlaps = (a: { start: Date; end: Date }, b: { start: Date; end: Date }) =>
  a.start < b.end && b.start < a.end;

// Intl formatters are expensive to construct and the slot walk calls these per candidate.
const hourFormatters = new Map<string, Intl.DateTimeFormat>();
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Fractional local hour (e.g. 19.5) of a UTC instant in the given IANA timezone. */
export function localHour(date: Date, timezone: string): number {
  let fmt = hourFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    hourFormatters.set(timezone, fmt);
  }
  const parts = fmt.formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h + m / 60;
}

function localDayKey(date: Date, timezone: string): string {
  let fmt = dayFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: timezone });
    dayFormatters.set(timezone, fmt);
  }
  return fmt.format(date);
}

function isBusy(blocks: BusyBlock[], slot: { start: Date; end: Date }) {
  return blocks.some((b) => overlaps(b, slot));
}

export function scoreSlots(input: FindSlotsInput): ScoredSlot[] {
  const { request, timezone, availability, roles } = input;
  const step = (input.stepMinutes ?? 30) * 60_000;
  const duration = request.durationMinutes * 60_000;
  const notBefore = input.notBefore ?? new Date();

  let cursor = Math.max(Date.parse(request.windowStart), notBefore.getTime());
  cursor = Math.ceil(cursor / step) * step; // align to the step grid
  const windowEnd = Date.parse(request.windowEnd);

  const connected = [...availability.entries()].filter(
    (entry): entry is [string, BusyBlock[]] => entry[1] !== null,
  );

  const hours = activityHours(request);
  const results: ScoredSlot[] = [];
  for (; cursor + duration <= windowEnd; cursor += step) {
    const slot = { start: new Date(cursor), end: new Date(cursor + duration) };

    const startHour = localHour(slot.start, timezone);
    const endHour = startHour + request.durationMinutes / 60;
    // The bot only picks reasonable hours on its own; a time the request asked for is honored.
    const unreasonable = startHour < EARLIEST_REASONABLE_HOUR || endHour > LATEST_REASONABLE_END_HOUR;
    if (unreasonable && !request.timeRequested) continue;
    // Out-of-hours slots are dropped, not down-ranked: no 8 AM "dinner" in a later round.
    if (startHour < hours.from || endHour > hours.to) continue;
    if (input.exclude?.some((x) => overlaps(x, slot))) continue;

    const busyUserIds = connected.filter(([, blocks]) => isBusy(blocks, slot)).map(([id]) => id);
    // An essential member with a known conflict rules the slot out entirely.
    if (busyUserIds.some((id) => (roles.get(id) ?? "essential") === "essential")) continue;

    const weight = (id: string) => ((roles.get(id) ?? "essential") === "essential" ? 1 : 0.5);
    const totalWeight = connected.reduce((sum, [id]) => sum + weight(id), 0);
    const freeWeight = connected
      .filter(([id]) => !busyUserIds.includes(id))
      .reduce((sum, [id]) => sum + weight(id), 0);
    const overlapScore = totalWeight === 0 ? 1 : freeWeight / totalWeight;

    results.push({
      ...slot,
      score: overlapScore * 0.7 + hourScore(startHour, endHour, request) * 0.3,
      freeCount: connected.length - busyUserIds.length,
      busyUserIds,
    });
  }
  return results.sort((a, b) => b.score - a.score || a.start.getTime() - b.start.getTime());
}

/** 1.0 inside the preferred hours, decaying by distance outside them; 0.6 when no preference. */
function hourScore(startHour: number, endHour: number, request: ParsedRequest): number {
  const { preferredStartHour: from, preferredEndHour: to } = request;
  if (from === null || to === null) {
    // Mild preference for daytime/evening over early morning.
    return startHour >= 10 && endHour <= 22 ? 0.6 : 0.4;
  }
  if (startHour >= from && endHour <= to) return 1;
  const distance = startHour < from ? from - startHour : endHour - to;
  return Math.max(0, 1 - distance / 4);
}

/**
 * Picks up to `count` slots from a ranked list, skipping ones that overlap an
 * already-picked slot and preferring different days so the options are
 * meaningfully different.
 */
export function pickDistinct(ranked: ScoredSlot[], count: number, timezone: string): ScoredSlot[] {
  const picked: ScoredSlot[] = [];
  const days = new Set<string>();
  // First pass: one per day. Second pass: fill any remaining spots.
  for (const pass of [0, 1]) {
    for (const slot of ranked) {
      if (picked.length >= count) break;
      if (picked.includes(slot) || picked.some((p) => overlaps(p, slot))) continue;
      const day = localDayKey(slot.start, timezone);
      if (pass === 0 && days.has(day)) continue;
      picked.push(slot);
      days.add(day);
    }
  }
  return picked.sort((a, b) => a.start.getTime() - b.start.getTime());
}
