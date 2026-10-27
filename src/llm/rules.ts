import type { ParsedRequest } from "../types.ts";
import { localParts, startOfLocalDay, zonedTimeToUtc } from "../time.ts";

// Rule-based request parser. Handles the common phrasings well enough for a
// demo without an API key, and backs up Claude if a call fails.

interface ActivityDefaults {
  durationMinutes: number;
  preferredStartHour: number | null;
  preferredEndHour: number | null;
}

export const ACTIVITY_DEFAULTS: Record<string, ActivityDefaults> = {
  breakfast: { durationMinutes: 60, preferredStartHour: 8, preferredEndHour: 11 },
  coffee: { durationMinutes: 60, preferredStartHour: 8, preferredEndHour: 17 },
  brunch: { durationMinutes: 90, preferredStartHour: 10, preferredEndHour: 14 },
  lunch: { durationMinutes: 90, preferredStartHour: 11, preferredEndHour: 14 },
  dinner: { durationMinutes: 120, preferredStartHour: 17, preferredEndHour: 22 },
  drinks: { durationMinutes: 120, preferredStartHour: 18, preferredEndHour: 23 },
  movie: { durationMinutes: 150, preferredStartHour: 13, preferredEndHour: 23 },
  hike: { durationMinutes: 180, preferredStartHour: 8, preferredEndHour: 17 },
  game: { durationMinutes: 180, preferredStartHour: 17, preferredEndHour: 23 },
  call: { durationMinutes: 60, preferredStartHour: 9, preferredEndHour: 21 },
};

const ACTIVITY_ALIASES: [RegExp, string][] = [
  [/\bbreakfast\b/, "breakfast"],
  [/\b(coffee|boba|tea)\b/, "coffee"],
  [/\bbrunch\b/, "brunch"],
  [/\blunch\b/, "lunch"],
  [/\b(dinner|supper)\b/, "dinner"],
  [/\b(drinks?|beers?|bar|happy hour)\b/, "drinks"],
  [/\b(movie|film)\b/, "movie"],
  [/\b(hike|hiking)\b/, "hike"],
  [/\b(game night|games|board games)\b/, "game"],
  [/\b(call|zoom|facetime)\b/, "call"],
];

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function parseRequestWithRules(
  text: string,
  { now, timezone }: { now: Date; timezone: string },
): ParsedRequest | null {
  const t = text.toLowerCase();
  const activityKey = ACTIVITY_ALIASES.find(([re]) => re.test(t))?.[1];
  const defaults = activityKey
    ? ACTIVITY_DEFAULTS[activityKey]
    : { durationMinutes: 90, preferredStartHour: null, preferredEndHour: null };
  const activity = activityKey === "game" ? "game night" : (activityKey ?? "hangout");

  const today = localParts(now, timezone).weekday;
  const day = (offset: number) => startOfLocalDay(now, timezone, offset);
  const daysUntil = (weekday: number) => (weekday - today + 7) % 7;

  // Offset to the Saturday of the current/coming weekend (-1 on a Sunday).
  const comingSat = today === 0 ? -1 : daysUntil(6);
  let start: Date;
  let end: Date;
  let hasTimeWords = true;

  if (/\b(tonight|today)\b/.test(t)) {
    start = now;
    end = day(1);
  } else if (/\btomorrow\b/.test(t)) {
    start = day(1);
    end = day(2);
  } else if (/\bnext weekend\b/.test(t)) {
    // The weekend after the current/coming one. Claude handles regional nuance.
    start = day(comingSat + 7);
    end = day(comingSat + 9);
  } else if (/\bweekend\b/.test(t)) {
    start = comingSat <= 0 ? now : day(comingSat);
    end = day(comingSat + 2);
  } else if (/\bnext week\b/.test(t)) {
    const monOffset = daysUntil(1) || 7;
    start = day(monOffset);
    end = day(monOffset + 7);
  } else if (/\bthis week\b/.test(t)) {
    start = now;
    end = day(daysUntil(1) || 7);
  } else {
    const named = DAY_NAMES.findIndex((d) => new RegExp(`\\b${d}\\b`).test(t));
    if (named >= 0) {
      const offset = daysUntil(named) + (new RegExp(`\\bnext ${DAY_NAMES[named]}\\b`).test(t) ? 7 : 0);
      start = offset === 0 ? now : day(offset);
      end = day(offset + 1);
    } else {
      // No time words: look across the next week.
      hasTimeWords = false;
      start = now;
      end = day(8);
    }
  }

  // A request needs some hint of intent; "@planner hi" shouldn't start a plan.
  const hasIntent = /\b(hang|hangout|meet|get together|plan|sometime|catch up)\b/.test(t);
  if (!activityKey && !hasTimeWords && !hasIntent) return null;

  // Slots outside the preferred hours are never proposed, so an explicit ask
  // ("at 4pm", "in the morning") replaces the activity's usual hours.
  const asked = requestedHours(t, defaults);
  // "Drinks at 11pm" runs past midnight: let the window cover the end of it.
  if (asked && asked.to > 24) end = new Date(end.getTime() + (asked.to - 24) * 3_600_000);
  return {
    activity,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    durationMinutes: defaults.durationMinutes,
    preferredStartHour: asked?.from ?? defaults.preferredStartHour,
    preferredEndHour: asked?.to ?? defaults.preferredEndHour,
    ...(asked && { timeRequested: true }),
  };
}

const DAY_PARTS: [RegExp, { from: number; to: number }][] = [
  [/\bmorning\b/, { from: 8, to: 12 }],
  [/\bafternoon\b/, { from: 12, to: 17 }],
  [/\bevening\b/, { from: 17, to: 22 }],
];

// "at 4", "around 7:30", "4pm", "at 7ish". A bare number needs at/around so "dinner for 4" isn't a time.
const CLOCK_TIME = /\b(?:at|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:ish)?\b|\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/;

/** Local hours the request explicitly asks for, or null to use the activity's usual hours. */
function requestedHours(t: string, defaults: ActivityDefaults): { from: number; to: number } | null {
  const duration = defaults.durationMinutes / 60;
  const m = CLOCK_TIME.exec(t);
  if (m) {
    const hour = Number(m[1] ?? m[4]);
    const minute = Number(m[2] ?? m[5] ?? 0);
    const meridiem = m[3] ?? m[6];
    if (hour >= 1 && hour <= 12 && minute < 60) {
      let h: number;
      if (meridiem) {
        h = (hour % 12) + (meridiem === "pm" ? 12 : 0);
      } else {
        // "dinner at 8" is 8 PM, "breakfast at 8" is 8 AM: take whichever fits the activity.
        const { preferredStartHour: from, preferredEndHour: to } = defaults;
        const fits = [hour % 12, (hour % 12) + 12].find((c) => from !== null && to !== null && c >= from && c + duration <= to);
        h = fits ?? (hour < 8 ? hour + 12 : hour);
      }
      // Snap to the half-hour grid slots are proposed on.
      const start = Math.floor((h + minute / 60) * 2) / 2;
      return { from: start, to: start + duration };
    }
  }
  return DAY_PARTS.find(([re]) => re.test(t))?.[1] ?? null;
}

// Words a request can be made of that the rules above fully understand.
const KNOWN_REQUEST_WORDS = new Set(
  [
    "breakfast coffee boba tea brunch lunch dinner supper drink drinks beer beers bar happy hour movie movies film",
    "hike hiking game games board call zoom facetime night",
    "today tonight tomorrow weekend week next this sometime morning afternoon evening",
    "lets let's let us we should could get grab go do have some a an the for on at around in plan hang hangout",
    "out meet up catch together please maybe am pm ish",
    ...DAY_NAMES,
  ]
    .join(" ")
    .split(" "),
);

/**
 * True when every word of the request is one the rules understand ("dinner
 * next weekend", "drinks at 11pm tomorrow"), so their parse can be trusted
 * without asking Claude. "Dinner after the 15th" isn't.
 */
export function requestFullyUnderstood(text: string): boolean {
  const words = text.toLowerCase().replace(/[’]/g, "'").replace(/[.,!?;:]/g, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => KNOWN_REQUEST_WORDS.has(w) || /^\d{1,2}(:\d{2})?(am|pm)?(ish)?$/.test(w));
}

const ONE_OFF_NEGATIVE =
  /\b(can't|cant|cannot|won't|wont|bad|busy|out|unavailable|not free|not available|doesn't work|doesnt work|don't work|dont work|won't work|no good)\b/;
const ONE_OFF_PARTS: [RegExp, { from: number; to: number }][] = [
  [/\bmorning\b/, { from: 5, to: 12 }],
  [/\bafternoon\b/, { from: 12, to: 17 }],
  [/\bevening\b/, { from: 17, to: 21 }],
  [/\bnight\b/, { from: 17, to: 24 }],
];

/**
 * A constraint about specific dates, not a standing preference: "I can't do
 * this Saturday", "tomorrow morning is bad", "I'm out Friday night", "this
 * weekend doesn't work". Returns the windows that don't work, or null.
 */
export function parseConstraintWithRules(
  text: string,
  { now, timezone }: { now: Date; timezone: string },
): { start: string; end: string }[] | null {
  const t = text.toLowerCase().replace(/[’]/g, "'");
  if (!ONE_OFF_NEGATIVE.test(t) || ACTIVITY_ALIASES.some(([re]) => re.test(t))) return null;

  const today = localParts(now, timezone).weekday;
  const daysUntil = (weekday: number) => (weekday - today + 7) % 7;
  let offsets: number[] | null = null;
  if (/\btonight\b|\btoday\b/.test(t)) offsets = [0];
  else if (/\btomorrow\b/.test(t)) offsets = [1];
  else if (/\b(this|next)?\s*weekend\b/.test(t)) {
    const sat = today === 0 ? -1 : daysUntil(6);
    const base = /\bnext weekend\b/.test(t) ? sat + 7 : sat;
    offsets = [base, base + 1].filter((o) => o >= 0);
  } else {
    // Singular day names only: "fridays" is a standing preference, handled elsewhere.
    const named = DAY_NAMES.findIndex((d) => new RegExp(`\\b${d}\\b`).test(t));
    if (named >= 0) offsets = [daysUntil(named) + (new RegExp(`\\bnext ${DAY_NAMES[named]}\\b`).test(t) ? 7 : 0)];
  }
  if (!offsets) return null;

  const part = /\btonight\b/.test(t) ? { from: 17, to: 24 } : (ONE_OFF_PARTS.find(([re]) => re.test(t))?.[1] ?? { from: 0, to: 24 });
  // Wall-clock hours on that local date, so a DST switch doesn't shift the window.
  const at = (offset: number, hour: number) => {
    if (hour >= 24) return startOfLocalDay(now, timezone, offset + 1);
    const d = localParts(new Date(startOfLocalDay(now, timezone, offset).getTime() + 12 * 3_600_000), timezone);
    return zonedTimeToUtc(d.year, d.month, d.day, hour, timezone);
  };
  return offsets.map((offset) => ({
    start: at(offset, part.from).toISOString(),
    end: at(offset, part.to).toISOString(),
  }));
}
