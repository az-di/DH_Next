import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectToken, verifyConnectToken } from "../src/calendar/links.ts";
import { activityHours, localHour, pickDistinct, scoreSlots } from "../src/calendar/slots.ts";
import type { Availability } from "../src/calendar/availability.ts";
import type { MemberRole, ParsedRequest } from "../src/types.ts";

const TZ = "America/Los_Angeles";
// Sat Nov 7 2026 00:00 PST = 08:00Z; window covers Sat + Sun.
const request: ParsedRequest = {
  activity: "dinner",
  windowStart: "2026-11-07T08:00:00Z",
  windowEnd: "2026-11-09T08:00:00Z",
  durationMinutes: 120,
  preferredStartHour: 17,
  preferredEndHour: 22,
};
const notBefore = new Date("2026-11-01T00:00:00Z");
const pst = (day: number, hour: number) => new Date(Date.UTC(2026, 10, day, hour + 8));

test("connect tokens round-trip and reject tampering/expiry", () => {
  const token = createConnectToken("user-1", 1_000);
  assert.equal(verifyConnectToken(token, 2_000), "user-1");
  assert.equal(verifyConnectToken(token + "x", 2_000), null);
  assert.equal(verifyConnectToken(token, 1_000 + 8 * 24 * 3600 * 1000), null);
});

test("localHour respects timezone", () => {
  assert.equal(localHour(pst(7, 19), TZ), 19);
  assert.equal(localHour(new Date("2026-11-07T19:30:00Z"), "UTC"), 19.5);
});

test("prefers dinner hours when everyone is free", () => {
  const availability: Availability = new Map([
    ["a", []],
    ["b", []],
  ]);
  const ranked = scoreSlots({ request, timezone: TZ, availability, roles: new Map(), notBefore });
  const best = ranked[0];
  assert.ok(localHour(best.start, TZ) >= 17);
  assert.ok(localHour(best.end, TZ) <= 22);
  assert.equal(best.score, 1);
});

test("an essential member's conflict rules a slot out; optional only lowers score", () => {
  const busySatEvening = [{ start: pst(7, 17), end: pst(7, 23) }];
  const roles = new Map<string, MemberRole>([
    ["a", "essential"],
    ["b", "optional"],
  ]);

  const essentialBusy = scoreSlots({
    request,
    timezone: TZ,
    availability: new Map([["a", busySatEvening], ["b", []]]),
    roles,
    notBefore,
  });
  assert.ok(essentialBusy.every((s) => !(s.start >= pst(7, 17) && s.start < pst(7, 23))));

  const optionalBusy = scoreSlots({
    request,
    timezone: TZ,
    availability: new Map([["a", []], ["b", busySatEvening]]),
    roles,
    notBefore,
  });
  const satSeven = optionalBusy.find((s) => s.start.getTime() === pst(7, 19).getTime());
  assert.ok(satSeven && satSeven.score < 1);
  assert.deepEqual(satSeven.busyUserIds, ["b"]);
});

test("members without calendars don't block slots", () => {
  const ranked = scoreSlots({
    request,
    timezone: TZ,
    availability: new Map([["a", null], ["b", null]]),
    roles: new Map(),
    notBefore,
  });
  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].freeCount, 0);
});

test("excluded intervals (rejected earlier) are skipped", () => {
  const exclude = [{ start: pst(7, 0), end: pst(8, 0) }]; // all of Saturday
  const ranked = scoreSlots({
    request,
    timezone: TZ,
    availability: new Map([["a", []]]),
    roles: new Map(),
    exclude,
    notBefore,
  });
  assert.ok(ranked.every((s) => s.start >= pst(8, 0)));
});

test("never proposes unreasonable hours", () => {
  const ranked = scoreSlots({ request, timezone: TZ, availability: new Map(), roles: new Map(), notBefore });
  for (const s of ranked) {
    assert.ok(localHour(s.start, TZ) >= 8);
    assert.ok(localHour(s.start, TZ) + 2 <= 23);
  }
});

test("pickDistinct spreads options across days without overlap", () => {
  const ranked = scoreSlots({
    request,
    timezone: TZ,
    availability: new Map([["a", []]]),
    roles: new Map(),
    notBefore,
  });
  const picked = pickDistinct(ranked, 2, TZ);
  assert.equal(picked.length, 2);
  assert.notEqual(picked[0].start.getUTCDate(), picked[1].start.getUTCDate());
});

test("slots outside the activity's hours are excluded, not just ranked lower", () => {
  const hours = (r: ParsedRequest) =>
    scoreSlots({ request: r, timezone: TZ, availability: new Map(), roles: new Map(), notBefore }).map((s) => [
      localHour(s.start, TZ),
      localHour(s.end, TZ),
    ]);
  const dinner = hours(request);
  assert.ok(dinner.length > 0);
  assert.ok(dinner.every(([start, end]) => start >= 17 && end <= 22));

  const lunch = hours({ ...request, durationMinutes: 90, preferredStartHour: 11, preferredEndHour: 14 });
  assert.deepEqual([...new Set(lunch.map(([start]) => start))].sort(), [11, 11.5, 12, 12.5]);

  // Unknown activity: the 9 AM–10 PM default.
  const hangout = hours({ ...request, durationMinutes: 90, preferredStartHour: null, preferredEndHour: null });
  assert.equal(Math.min(...hangout.map(([start]) => start)), 9);
  assert.equal(Math.max(...hangout.map(([, end]) => end)), 22);
});

test("once every dinner-time slot is rejected, nothing else is offered", () => {
  const exclude = [
    { start: pst(7, 17), end: pst(7, 22) },
    { start: pst(8, 17), end: pst(8, 22) },
  ];
  const ranked = scoreSlots({ request, timezone: TZ, availability: new Map(), roles: new Map(), exclude, notBefore });
  assert.deepEqual(ranked, []);
});

test("activity hours fall back to the default and always fit the duration", () => {
  assert.deepEqual(activityHours(request), { from: 17, to: 22 });
  assert.deepEqual(activityHours({ ...request, preferredStartHour: 21, preferredEndHour: 2 }), { from: 9, to: 22 });
  // An explicit "at 4" with a 1-hour window still fits a 2-hour dinner.
  assert.deepEqual(activityHours({ ...request, preferredStartHour: 16, preferredEndHour: 17 }), { from: 16, to: 18 });
});

test("an explicitly requested time skips the 8 AM–11 PM limit; times the bot picks don't", () => {
  // "drinks at 11pm Saturday": 11 PM–1 AM, window extended to Sun 1 AM.
  const drinks: ParsedRequest = {
    activity: "drinks",
    windowStart: "2026-11-07T08:00:00Z",
    windowEnd: "2026-11-08T09:00:00Z",
    durationMinutes: 120,
    preferredStartHour: 23,
    preferredEndHour: 25,
  };
  const slots = (r: ParsedRequest) =>
    scoreSlots({ request: r, timezone: TZ, availability: new Map(), roles: new Map(), notBefore });
  assert.deepEqual(slots({ ...drinks, timeRequested: true }).map((s) => [s.start, s.end]), [[pst(7, 23), pst(8, 1)]]);
  assert.deepEqual(slots(drinks), [], "without the explicit ask, 11 PM is too late");

  // Usual hours that start early (6–10 AM) still don't get pre-8 AM slots.
  const early = slots({ ...drinks, windowEnd: "2026-11-08T08:00:00Z", durationMinutes: 60, preferredStartHour: 6, preferredEndHour: 10 });
  assert.deepEqual(early.map((s) => localHour(s.start, TZ)).sort(), [8, 8.5, 9]);
});

test("connect page asks what to call you, prefills a name set in chat, and saves it", async (t) => {
  const { default: express } = await import("express");
  const { config } = await import("../src/config.ts");
  const { MemoryRepo } = await import("../src/db/memory.ts");
  const { createCalendarRouter } = await import("../src/calendar/routes.ts");
  const saved = { ...config.google };
  Object.assign(config.google, { clientId: "client", clientSecret: "secret" });
  const repo = new MemoryRepo();
  const server = express().use(createCalendarRouter(repo)).listen(0);
  t.after(() => {
    server.close();
    Object.assign(config.google, saved);
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;

  const user = await repo.upsertUserByPhone("+15550000009", { name: `Sam "<b>"` });
  const token = createConnectToken(user.id);
  const html = await (await fetch(`${base}/connect?t=${encodeURIComponent(token)}`)).text();
  assert.match(html, /What should we call you\?/);
  assert.match(html, /value="Sam &quot;&lt;b&gt;&quot;"/, "prefilled and escaped");

  const submit = (name: string) =>
    fetch(`${base}/connect`, { method: "POST", redirect: "manual", body: new URLSearchParams({ t: token, name }) });
  const res = await submit("  Sam   Patel ");
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location")!, /^https:\/\/accounts\.google\.com\//);
  assert.equal(user.name, "Sam Patel");

  await submit("");
  assert.equal(user.name, "Sam Patel", "leaving it blank keeps the name");
  assert.equal((await fetch(`${base}/connect`, { method: "POST", body: new URLSearchParams({ t: "bad" }) })).status, 400);
});

test("preferences form: prefilled from chat, saved on submit, and unusual blocks are kept", async (t) => {
  const { default: express } = await import("express");
  const { MemoryRepo } = await import("../src/db/memory.ts");
  const { createCalendarRouter } = await import("../src/calendar/routes.ts");
  const repo = new MemoryRepo();
  const server = express().use(createCalendarRouter(repo)).listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;

  const user = await repo.upsertUserByPhone("+15550000008", { name: "Theo" });
  const all = [0, 1, 2, 3, 4, 5, 6];
  // As if Theo had said "@planner I don't do mornings, no friday nights, I prefer evenings".
  await repo.savePreferences(user.id, {
    preferredTimes: ["evening"],
    preferredDays: [],
    never: [{ days: all, from: 5, to: 12 }, { days: [5], from: 21, to: 24 }],
  });
  const token = encodeURIComponent(createConnectToken(user.id));
  const html = await (await fetch(`${base}/preferences?t=${token}`)).text();
  assert.match(html, /name="times" value="evening" checked/);
  assert.match(html, /name="never_times" value="morning" checked/);
  assert.match(html, /never after 9 PM on Fridays/, "a block the simple controls can't show is listed to keep");

  const keep = /name="keep_never" value="([^"]+)"/.exec(html)![1].replaceAll("&quot;", '"');
  const body = new URLSearchParams([
    ["t", decodeURIComponent(token)],
    ["name", "Theo"],
    ["days", "6"],
    ["never_times", "morning"],
    ["never_days", "0"],
    ["not_after", "22"],
    ["keep_never", keep],
  ]);
  const res = await fetch(`${base}/preferences`, { method: "POST", redirect: "manual", body });
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location")!, /saved=1/);
  assert.deepEqual(await repo.getPreferences(user.id), {
    preferredTimes: [],
    preferredDays: [6],
    never: [
      { days: all, from: 5, to: 12 },
      { days: [0], from: 0, to: 24 },
      { days: all, from: 22, to: 24 },
      { days: [5], from: 21, to: 24 },
    ],
  });
  assert.match(await (await fetch(`${base}${res.headers.get("location")}`)).text(), /Saved ✓/);
});
