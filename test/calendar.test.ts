import { test } from "node:test";
import assert from "node:assert/strict";
import { createConnectToken, verifyConnectToken } from "../src/calendar/links.ts";
import { localHour, pickDistinct, scoreSlots } from "../src/calendar/slots.ts";
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
