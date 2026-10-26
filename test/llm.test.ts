import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequestWithRules } from "../src/llm/rules.ts";
import { formatOption, renderTemplate } from "../src/llm/templates.ts";
import { formatSlot, localParts, startOfLocalDay, zonedTimeToUtc } from "../src/time.ts";

const TZ = "America/Los_Angeles";
// Wednesday Oct 28 2026, 10:00 PDT
const now = new Date("2026-10-28T17:00:00Z");
const parse = (text: string) => parseRequestWithRules(text, { now, timezone: TZ });
const local = (iso: string) => localParts(new Date(iso), TZ);

test("zonedTimeToUtc handles DST on both sides of the switch", () => {
  assert.equal(zonedTimeToUtc(2026, 10, 28, 19, TZ).toISOString(), "2026-10-29T02:00:00.000Z"); // PDT
  assert.equal(zonedTimeToUtc(2026, 11, 7, 19, TZ).toISOString(), "2026-11-08T03:00:00.000Z"); // PST
  assert.equal(startOfLocalDay(now, TZ, 1).toISOString(), "2026-10-29T07:00:00.000Z");
});

test("formatSlot reads naturally", () => {
  const start = zonedTimeToUtc(2026, 11, 7, 19, TZ);
  const end = zonedTimeToUtc(2026, 11, 7, 21, TZ);
  assert.match(formatSlot(start, end, TZ), /^Sat, Nov 7, 7:00\s?–9:00\sPM$/);
  const lunchStart = zonedTimeToUtc(2026, 11, 7, 11, TZ, 30);
  const lunchEnd = zonedTimeToUtc(2026, 11, 7, 13, TZ);
  assert.match(formatSlot(lunchStart, lunchEnd, TZ), /11:30\sAM–1:00\sPM$/);
});

test("dinner next weekend", () => {
  const r = parse("dinner sometime next weekend")!;
  assert.equal(r.activity, "dinner");
  assert.equal(r.durationMinutes, 120);
  assert.equal(r.preferredStartHour, 17);
  // Coming weekend is Oct 31-Nov 1, so next weekend is Sat Nov 7 - Mon Nov 9 00:00.
  assert.deepEqual([local(r.windowStart).month, local(r.windowStart).day, local(r.windowStart).hour], [11, 7, 0]);
  assert.deepEqual([local(r.windowEnd).month, local(r.windowEnd).day], [11, 9]);
});

test("this weekend, tomorrow, named days", () => {
  const weekend = parse("drinks this weekend")!;
  assert.equal(weekend.activity, "drinks");
  assert.equal(local(weekend.windowStart).day, 31);

  const tomorrow = parse("lunch tomorrow")!;
  assert.equal(local(tomorrow.windowStart).day, 29);
  assert.equal(local(tomorrow.windowEnd).day, 30);

  const friday = parse("coffee friday")!;
  assert.equal(local(friday.windowStart).day, 30);

  const nextFriday = parse("coffee next friday")!;
  assert.equal(local(nextFriday.windowStart).day, 6);
});

test("defaults to the next week; rejects non-requests", () => {
  const r = parse("let's get together")!;
  assert.equal(r.activity, "hangout");
  assert.equal(r.windowStart, now.toISOString());
  assert.equal(parse("hi"), null);
});

test("templates keep voting instructions and option format stable", () => {
  const text = renderTemplate({
    kind: "proposal",
    activity: "dinner",
    round: 1,
    options: [{ optionNumber: 1, label: "Sat, Nov 7, 7:00–9:00 PM" }],
    deadlineLabel: "Thu 6:00 PM",
    reason: "confident",
  });
  assert.match(text, /👍 yes, 👎 no, ❓ maybe/);
  assert.match(text, /Thu 6:00 PM/);
  assert.equal(formatOption(2, "Sun, Nov 8, 6:00–8:00 PM"), "Option 2: Sun, Nov 8, 6:00–8:00 PM");
});

test("an explicit time replaces the activity's usual hours", () => {
  const hours = (text: string) => {
    const r = parse(text)!;
    return [r.preferredStartHour, r.preferredEndHour];
  };
  assert.deepEqual(hours("dinner saturday"), [17, 22]);
  assert.deepEqual(hours("dinner at 4pm saturday"), [16, 18]);
  assert.deepEqual(hours("dinner at 8 saturday"), [20, 22], "no am/pm: whichever fits dinner");
  assert.deepEqual(hours("breakfast at 8 tomorrow"), [8, 9]);
  assert.deepEqual(hours("coffee around 3:15 friday"), [15, 16], "snapped to the half-hour grid");
  assert.deepEqual(hours("hangout at 3 saturday"), [15, 16.5]);
  assert.deepEqual(hours("brunch in the afternoon sunday"), [12, 17]);
  assert.deepEqual(hours("dinner for 4 saturday"), [17, 22], "a party size isn't a time");
  assert.deepEqual(hours("game night next weekend"), [17, 23]);
});

test("an explicit time is flagged, and one past midnight stretches the window", () => {
  const late = parse("drinks at 11pm saturday")!;
  assert.deepEqual([late.preferredStartHour, late.preferredEndHour, late.timeRequested], [23, 25, true]);
  assert.deepEqual([local(late.windowEnd).day, local(late.windowEnd).hour], [1, 1], "Sun Nov 1, 1 AM");
  assert.equal(parse("drinks saturday")!.timeRequested, undefined);
  assert.equal(parse("brunch in the afternoon sunday")!.timeRequested, true);
});

test("later rounds acknowledge the last one didn't work, even with one option", () => {
  const proposal = (count: number, reason: "confident" | "uncertain" | "after_no") =>
    renderTemplate({
      kind: "proposal",
      activity: "dinner",
      round: reason === "after_no" ? 2 : 1,
      options: Array.from({ length: count }, (_, i) => ({ optionNumber: i + 1, label: `Option ${i + 1}` })),
      deadlineLabel: "Thu 6:00 PM",
      reason,
    });
  assert.equal(
    proposal(1, "after_no"),
    "That didn't work for everyone, so how about this for dinner instead? 👍 yes, 👎 no, ❓ maybe. Please answer by Thu 6:00 PM.",
  );
  assert.match(proposal(2, "after_no"), /^That didn't work for everyone, so here are 2 more for dinner\. Tap 👍\/👎\/❓/);
  assert.match(proposal(1, "confident"), /^How about this for dinner\?/);
  assert.match(proposal(3, "uncertain"), /^A few options for dinner\./);
});
