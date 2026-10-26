import { localParts } from "../time.ts";
import type { PreferenceUpdate, Preferences, TimeOfDay, WeeklyBlock } from "../types.ts";

// Manual preferences: preferred times of day and days (scoring only) and
// times that never work (a hard filter, like a busy block). Set in chat
// ("@planner I don't do mornings") or on the connect page.

/** Local-hour buckets, by a slot's start time. Night runs to midnight; nothing is proposed after. */
export const TIME_OF_DAY: Record<TimeOfDay, { from: number; to: number }> = {
  morning: { from: 5, to: 12 },
  afternoon: { from: 12, to: 17 },
  evening: { from: 17, to: 21 },
  night: { from: 21, to: 24 },
};
const BUCKETS = Object.keys(TIME_OF_DAY) as TimeOfDay[];

export function timeOfDay(hour: number): TimeOfDay {
  return BUCKETS.find((t) => hour >= TIME_OF_DAY[t].from && hour < TIME_OF_DAY[t].to) ?? "night";
}

export const EMPTY_PREFERENCES: Preferences = { preferredTimes: [], preferredDays: [], never: [] };

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const WEEKEND = [0, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** True when the slot overlaps a time this person said never works. */
export function isBlocked(prefs: Preferences, start: Date, durationMinutes: number, timezone: string): boolean {
  if (prefs.never.length === 0) return false;
  const p = localParts(start, timezone);
  const from = p.hour + p.minute / 60;
  const to = from + durationMinutes / 60;
  // Split at midnight so a late slot is also checked against the next day.
  const pieces = [{ day: p.weekday, from, to: Math.min(to, 24) }];
  if (to > 24) pieces.push({ day: (p.weekday + 1) % 7, from: 0, to: to - 24 });
  return prefs.never.some((b) => pieces.some((x) => b.days.includes(x.day) && x.from < b.to && b.from < x.to));
}

/**
 * How well a slot fits someone's preferred times and days: +1 (all match) to
 * -1 (none do), or null when they have no preferences to compare against.
 */
export function preferenceFit(prefs: Preferences, start: Date, timezone: string): number | null {
  const p = localParts(start, timezone);
  const parts: number[] = [];
  if (prefs.preferredTimes.length) parts.push(prefs.preferredTimes.includes(timeOfDay(p.hour + p.minute / 60)) ? 1 : -1);
  if (prefs.preferredDays.length) parts.push(prefs.preferredDays.includes(p.weekday) ? 1 : -1);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

const isFullDay = (b: WeeklyBlock) => b.from <= 0 && b.to >= 24;
const sameBlock = (a: WeeklyBlock, b: WeeklyBlock) =>
  a.from === b.from && a.to === b.to && a.days.join() === b.days.join();

/** Sorted, de-duplicated days and hours clamped to 0–24. Null if it covers nothing. */
export function normalizeBlock(b: WeeklyBlock): WeeklyBlock | null {
  const days = [...new Set(b.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const from = Math.max(0, Math.min(24, b.from));
  const to = Math.max(0, Math.min(24, b.to));
  return days.length && from < to ? { days, from, to } : null;
}

export function mergePreferences(prev: Preferences | null, update: PreferenceUpdate): Preferences {
  const base = update.clear || !prev ? EMPTY_PREFERENCES : prev;
  const times = update.preferredTimes?.length ? [...new Set(update.preferredTimes)] : base.preferredTimes;
  const days = update.preferredDays?.length ? [...new Set(update.preferredDays)].sort() : base.preferredDays;
  // Saying you now like a time or day drops an older "never" for exactly that.
  const never = base.never.filter(
    (b) =>
      !update.preferredTimes?.some((t) => b.from === TIME_OF_DAY[t].from && b.to === TIME_OF_DAY[t].to) &&
      !(isFullDay(b) && update.preferredDays?.length && b.days.every((d) => update.preferredDays!.includes(d))),
  );
  for (const raw of update.never ?? []) {
    const b = normalizeBlock(raw);
    if (b && !never.some((x) => sameBlock(x, b))) never.push(b);
  }
  return { preferredTimes: times, preferredDays: days, never };
}

// ─────────────────────────── describing ───────────────────────────

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const joinAnd = (items: string[]) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

function dayLabel(days: number[], plural: boolean): string {
  const key = days.join();
  if (key === ALL_DAYS.join()) return "";
  if (key === WEEKEND.join()) return plural ? "weekends" : "weekend";
  if (key === WEEKDAYS.join()) return plural ? "weekdays" : "weekday";
  if (days.length === 1) return cap(DAY_NAMES[days[0]]) + (plural ? "s" : "");
  return joinAnd(days.map((d) => SHORT_DAYS[d]));
}

export function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "midnight";
  if (h === 12) return "noon";
  const hour = Math.floor(h);
  const minutes = Math.round((h - hour) * 60);
  return `${hour % 12 || 12}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""} ${hour < 12 ? "AM" : "PM"}`;
}

export function describeBlock(b: WeeklyBlock): string {
  const bucket = BUCKETS.find((t) => TIME_OF_DAY[t].from === b.from && TIME_OF_DAY[t].to === b.to);
  // "after 9 PM" reads better than "nights" for the same 21–24 block.
  const when =
    b.from <= 0
      ? `before ${hourLabel(b.to)}`
      : b.to >= 24
        ? `after ${hourLabel(b.from)}`
        : bucket
          ? `${bucket}s`
          : `${hourLabel(b.from)}–${hourLabel(b.to)}`;
  const everyDay = b.days.join() === ALL_DAYS.join();
  if (isFullDay(b)) return `never ${everyDay ? "any day" : dayLabel(b.days, true)}`;
  if (everyDay) return `never ${when}`;
  if (bucket && b.to < 24) return `never ${dayLabel(b.days, false)} ${when}`;
  return `never ${when} on ${dayLabel(b.days, true)}`;
}

/** "never mornings, prefers evenings": what one update saved, for the one-line confirmation. */
export function describeUpdate(update: PreferenceUpdate): string {
  const parts: string[] = [];
  if (update.clear) parts.push("cleared your old preferences");
  for (const b of update.never ?? []) {
    const n = normalizeBlock(b);
    if (n) parts.push(describeBlock(n));
  }
  const liked = (update.preferredTimes ?? []).map((t) => `${t}s`);
  if (update.preferredDays?.length) liked.push(dayLabel([...update.preferredDays].sort(), true) || "any day");
  if (liked.length) parts.push(`prefers ${joinAnd(liked)}`);
  return parts.join(", ");
}

export function describePreferences(prefs: Preferences): string {
  return describeUpdate(prefs) || "no preferences";
}

// ─────────────────────────── rules parser ──────────────────────────

// Plurals only: "mornings" and "fridays" are standing rules, while "tomorrow
// morning" or "this weekend" is about one plan and isn't saved.
const PART_WORDS: [RegExp, TimeOfDay][] = [
  [/\bmornings\b/, "morning"],
  [/\bafternoons\b/, "afternoon"],
  [/\bevenings\b/, "evening"],
  [/\b(?:late\s+)?nights\b/, "night"],
];
const DAY_WORDS: [RegExp, number[]][] = [
  [/\bweekends\b/, WEEKEND],
  [/\bweekdays\b/, WEEKDAYS],
  ...DAY_NAMES.map((d, i): [RegExp, number[]] => [new RegExp(`\\b${d}s\\b`), [i]]),
];
// "friday nights", "weekend mornings": the day may be singular when a plural part follows.
const COMBO_DAYS: [string, number[]][] = [
  ["weekends?", WEEKEND],
  ["weekdays?", WEEKDAYS],
  ...DAY_NAMES.map((d, i): [string, number[]] => [`${d}s?`, [i]]),
];
const NEGATIVE = /\b(no|not|never|nothing|can't|cant|cannot|don't|dont|doesn't|doesnt|hate|avoid|out)\b/;
const POSITIVE = /\b(prefer|prefers|preferably|like|love|best|ideal|ideally|only|usually|good)\b/;
const FIRST_PERSON = /\b(i|i'm|im|me|my)\b/;
const CLEAR = /\b(clear|reset|forget|delete|remove)\b.*\b(preferences?|prefs)\b/;
const LIMIT = /\b(?:not|nothing|never|no)\s+(before|earlier than|after|later than)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/;

/** "not before 10" → 10 AM, "not after 9" → 9 PM: a bare hour is read the way people mean it. */
function limitHour(hour: number, minute: number, meridiem: string | undefined, before: boolean): number | null {
  if (hour > 24 || minute >= 60) return null;
  let h: number;
  if (meridiem) h = (hour % 12) + (meridiem === "pm" ? 12 : 0);
  else if (hour > 12) h = hour;
  else if (before) h = hour >= 7 ? hour : hour + 12;
  else h = hour === 12 ? 24 : hour + 12;
  return h + minute / 60;
}

/**
 * Common phrasings: "no mornings", "I don't do mornings", "weekends only",
 * "not before 10", "nothing after 9pm", "no Friday nights", "I prefer
 * evenings", "forget my preferences". Null when the message isn't about the
 * sender's schedule. Claude handles everything else.
 */
export function parsePreferencesWithRules(text: string): PreferenceUpdate | null {
  const t = text.toLowerCase().replace(/[’]/g, "'").trim();
  // A preference is about yourself, or a short fragment like "no mornings";
  // "dinner next weekend not before 7" is a plan request.
  if (!FIRST_PERSON.test(t) && t.split(/\s+/).length > 4) return null;

  const update: PreferenceUpdate = {};
  const never: WeeklyBlock[] = [];
  const times = new Set<TimeOfDay>();
  const days = new Set<number>();
  if (CLEAR.test(t)) update.clear = true;

  for (let clause of t.split(/\bbut\b|[,.;!]|\band\b(?=\s+(?:i|no|not|never|prefer)\b)/)) {
    const limit = LIMIT.exec(clause);
    if (limit) {
      const before = limit[1].startsWith("before") || limit[1].startsWith("earlier");
      const h = limitHour(Number(limit[2]), Number(limit[3] ?? 0), limit[4], before);
      if (h !== null) never.push(before ? { days: ALL_DAYS, from: 0, to: h } : { days: ALL_DAYS, from: h, to: 24 });
      clause = clause.replace(limit[0], " ");
    }
    const negative = NEGATIVE.test(clause);
    const positive = !negative && POSITIVE.test(clause);
    if (!negative && !positive) continue;

    // "friday nights": a day and a part of day together.
    const combos: WeeklyBlock[] = [];
    for (const [day, dayList] of COMBO_DAYS) {
      for (const [partRe, part] of PART_WORDS) {
        const combo = new RegExp(`\\b${day}\\s+${partRe.source.replace(/^\\b/, "")}`);
        if (combo.test(clause)) {
          combos.push({ days: dayList, ...TIME_OF_DAY[part] });
          clause = clause.replace(combo, " ");
        }
      }
    }
    const partsHere = PART_WORDS.filter(([re]) => re.test(clause)).map(([, p]) => p);
    const daysHere = DAY_WORDS.filter(([re]) => re.test(clause)).flatMap(([, d]) => d);

    if (negative) {
      never.push(...combos);
      for (const p of partsHere) never.push({ days: ALL_DAYS, ...TIME_OF_DAY[p] });
      if (daysHere.length) never.push({ days: [...new Set(daysHere)].sort(), from: 0, to: 24 });
    } else {
      for (const c of combos) {
        c.days.forEach((d) => days.add(d));
        times.add(timeOfDay(c.from));
      }
      partsHere.forEach((p) => times.add(p));
      daysHere.forEach((d) => days.add(d));
    }
  }

  if (never.length) update.never = never;
  if (times.size) update.preferredTimes = [...times];
  if (days.size) update.preferredDays = [...days].sort();
  return Object.keys(update).length ? update : null;
}
