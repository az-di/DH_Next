import { test } from "node:test";
import assert from "node:assert/strict";
import type { Availability } from "../src/calendar/availability.ts";
import { scoreSlots } from "../src/calendar/slots.ts";
import {
  describePreferences,
  describeUpdate,
  isBlocked,
  mergePreferences,
  parsePreferencesWithRules,
  preferenceFit,
} from "../src/plans/preferences.ts";
import { zonedTimeToUtc } from "../src/time.ts";
import type { MemberRole, ParsedRequest, Preferences } from "../src/types.ts";

const TZ = "America/Los_Angeles";
const ALL = [0, 1, 2, 3, 4, 5, 6];
const prefs = (p: Partial<Preferences>): Preferences => ({ preferredTimes: [], preferredDays: [], never: [], ...p });
const sat = (hour: number) => zonedTimeToUtc(2026, 11, 7, hour, TZ); // Saturday Nov 7

test("rules: common phrasings", () => {
  const parse = parsePreferencesWithRules;
  assert.deepEqual(parse("no mornings"), { never: [{ days: ALL, from: 5, to: 12 }] });
  assert.deepEqual(parse("I don't do mornings"), { never: [{ days: ALL, from: 5, to: 12 }] });
  assert.deepEqual(parse("weekends only"), { preferredDays: [0, 6] });
  assert.deepEqual(parse("not before 10"), { never: [{ days: ALL, from: 0, to: 10 }] });
  assert.deepEqual(parse("nothing after 9pm"), { never: [{ days: ALL, from: 21, to: 24 }] });
  assert.deepEqual(parse("no friday nights"), { never: [{ days: [5], from: 21, to: 24 }] });
  assert.deepEqual(parse("I prefer evenings but no Fridays"), {
    never: [{ days: [5], from: 0, to: 24 }],
    preferredTimes: ["evening"],
  });
  assert.deepEqual(parse("forget my preferences"), { clear: true });
});

test("rules: plan requests and one-off constraints aren't preferences", () => {
  for (const text of ["dinner next weekend", "Sam is optional", "I'm optional", "I can't do this weekend", "I can't do tomorrow morning", "dinner next weekend not before 7"]) {
    assert.equal(parsePreferencesWithRules(text), null, text);
  }
});

test("merging keeps earlier nevers, replaces preferred times, and a new like drops a matching never", () => {
  let p = mergePreferences(null, { never: [{ days: ALL, from: 5, to: 12 }] });
  p = mergePreferences(p, { never: [{ days: [5], from: 0, to: 24 }], preferredTimes: ["evening"] });
  assert.deepEqual(p.never, [{ days: ALL, from: 5, to: 12 }, { days: [5], from: 0, to: 24 }]);
  p = mergePreferences(p, { preferredTimes: ["morning"] });
  assert.deepEqual(p.preferredTimes, ["morning"]);
  assert.deepEqual(p.never, [{ days: [5], from: 0, to: 24 }], "liking mornings drops 'never mornings'");
  assert.deepEqual(mergePreferences(p, { clear: true }), prefs({}));
});

test("never-times block overlapping slots, including the part of a late slot after midnight", () => {
  const p = prefs({ never: [{ days: ALL, from: 0, to: 10 }, { days: [0], from: 0, to: 24 }] });
  assert.equal(isBlocked(p, sat(9), 60, TZ), true);
  assert.equal(isBlocked(p, sat(10), 60, TZ), false);
  assert.equal(isBlocked(p, sat(23), 120, TZ), true, "Sat 11 PM–1 AM runs into Sunday");
  assert.equal(isBlocked(p, sat(19), 120, TZ), false);
});

test("fit: +1 when time and day match, -1 when neither does, null without preferences", () => {
  const p = prefs({ preferredTimes: ["evening"], preferredDays: [6] });
  assert.equal(preferenceFit(p, sat(18), TZ), 1);
  assert.equal(preferenceFit(p, sat(13), TZ), 0);
  assert.equal(preferenceFit(p, zonedTimeToUtc(2026, 11, 8, 13, TZ), TZ), -1);
  assert.equal(preferenceFit(prefs({}), sat(18), TZ), null);
});

test("descriptions read naturally", () => {
  assert.equal(describeUpdate({ never: [{ days: ALL, from: 5, to: 12 }], preferredTimes: ["evening"] }), "never mornings, prefers evenings");
  assert.equal(describeUpdate({ never: [{ days: ALL, from: 0, to: 10 }] }), "never before 10 AM");
  assert.equal(describeUpdate({ never: [{ days: [0, 6], from: 0, to: 24 }] }), "never weekends");
  assert.equal(describeUpdate({ preferredTimes: ["morning"], preferredDays: [6] }), "prefers mornings and Saturdays");
  assert.equal(describePreferences(prefs({})), "no preferences");
});

// A Saturday hangout window, 9 AM–10 PM, with nobody busy.
const request: ParsedRequest = {
  activity: "hangout",
  windowStart: sat(0).toISOString(),
  windowEnd: zonedTimeToUtc(2026, 11, 8, 0, TZ).toISOString(),
  durationMinutes: 120,
  preferredStartHour: null,
  preferredEndHour: null,
};
const free: Availability = new Map([["a", []], ["b", []]]);
const roles = new Map<string, MemberRole>([["a", "essential"], ["b", "essential"]]);
const score = (preferences?: Map<string, Preferences>, r = roles) =>
  scoreSlots({ request, timezone: TZ, availability: free, roles: r, notBefore: sat(0), preferences });
const startHours = (slots: { start: Date }[]) => slots.map((s) => (s.start.getTime() - sat(0).getTime()) / 3_600_000);

test("scoring is unchanged when nobody has preferences", () => {
  assert.deepEqual(score(new Map()), score());
});

test("an essential member's never-time is a hard filter; an optional member's only lowers the score", () => {
  const never = new Map([["b", prefs({ never: [{ days: ALL, from: 0, to: 17 }] })]]);
  assert.ok(startHours(score(never)).every((h) => h >= 17), "nothing before 5 PM");

  const optional = new Map<string, MemberRole>([["a", "essential"], ["b", "optional"]]);
  const ranked = score(never, optional);
  assert.ok(startHours(ranked).some((h) => h < 17), "still proposable");
  assert.ok(startHours(ranked.slice(0, 3)).every((h) => h >= 17), "but ranked below times b can make");
});

test("preferred times tilt the ranking among equally free slots", () => {
  const before = score();
  const evenings = score(new Map([["a", prefs({ preferredTimes: ["evening"] })]]));
  assert.notDeepEqual(startHours(before.slice(0, 1)), startHours(evenings.slice(0, 1)));
  assert.ok(startHours(evenings.slice(0, 3)).every((h) => h >= 17 && h < 21));
  // Small enough that someone being busy still matters more than taste.
  assert.ok(evenings[0].score - before[0].score <= 0.1);
});
