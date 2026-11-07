import { localHour, type ScoredSlot } from "../calendar/slots.ts";
import { formatSlot } from "../time.ts";
import type { TimeWindow } from "../types.ts";

// Pure rules for planning by DM (Capabilities.collectByDm): the bot asks each
// member privately what times work, then the organizer picks from the overlap.

/** More than this and the bot refuses, since mass DMs can get a Discord bot flagged. */
export const MAX_DM_MEMBERS = 15;
export const MAX_DM_OPTIONS = 3;
/** How long the organizer has to pick before the plan closes and frees the channel. */
export const ORGANIZER_PICK_MS = 24 * 3_600_000;

const MIN_COLLECTION_MS = 30 * 60_000;
const MAX_COLLECTION_MS = 24 * 3_600_000;

/** When answers are due: 24h, or halfway to the end of the window if sooner, but never under 30 minutes. */
export function collectionDeadline(now: Date, windowEnd: Date): Date {
  const halfway = (windowEnd.getTime() - now.getTime()) / 2;
  return new Date(now.getTime() + Math.max(MIN_COLLECTION_MS, Math.min(MAX_COLLECTION_MS, halfway)));
}

/** Keeps the parts of `windows` inside `bounds`, merged and in order. */
export function clipWindows(windows: TimeWindow[], bounds: TimeWindow): TimeWindow[] {
  const clipped = windows
    .map((w) => ({
      start: Math.max(Date.parse(w.start), Date.parse(bounds.start)),
      end: Math.min(Date.parse(w.end), Date.parse(bounds.end)),
    }))
    .filter((w) => w.start < w.end)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const w of clipped) {
    const last = merged.at(-1);
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return merged.map((w) => ({ start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() }));
}

/** The parts of `bounds` not covered by `windows`: turns "when I'm free" into "when I'm busy". */
export function invertWindows(windows: TimeWindow[], bounds: TimeWindow): TimeWindow[] {
  const gaps: TimeWindow[] = [];
  let cursor = bounds.start;
  for (const w of clipWindows(windows, bounds)) {
    if (cursor < w.start) gaps.push({ start: cursor, end: w.start });
    cursor = w.end;
  }
  if (Date.parse(cursor) < Date.parse(bounds.end)) gaps.push({ start: cursor, end: new Date(bounds.end).toISOString() });
  return gaps;
}

/** Describes a saved answer so people can check it: "any time", "Sat, Nov 7 (all day)", or the exact range. */
export function describeWindow(w: TimeWindow, bounds: TimeWindow, timezone: string): string {
  const start = new Date(w.start);
  const end = new Date(w.end);
  if (start.getTime() <= Date.parse(bounds.start) && end.getTime() >= Date.parse(bounds.end)) return "any time";

  const dayOf = (date: Date) =>
    new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" }).format(date);
  // Measured just before the end, so a window ending at midnight belongs to the day it covers.
  const lastDay = dayOf(new Date(end.getTime() - 1));
  const moment = (date: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  if (dayOf(start) !== lastDay) return `${moment(start)} to ${moment(end)}`;
  const allDay = localHour(start, timezone) === 0 && localHour(end, timezone) === 0;
  return allDay ? `${lastDay} (all day)` : formatSlot(start, end, timezone);
}

/** The slots with the fewest conflicts: the overlap when there is one, otherwise the closest thing to it. */
export function fewestConflicts(ranked: ScoredSlot[]): ScoredSlot[] {
  const least = Math.min(...ranked.map((s) => s.conflictUserIds.length));
  return ranked.filter((s) => s.conflictUserIds.length === least);
}
