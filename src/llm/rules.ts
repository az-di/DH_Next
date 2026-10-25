import type { ParsedRequest } from "../types.ts";
import { localParts, startOfLocalDay } from "../time.ts";

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

  return {
    activity,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    durationMinutes: defaults.durationMinutes,
    preferredStartHour: defaults.preferredStartHour,
    preferredEndHour: defaults.preferredEndHour,
  };
}
