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
