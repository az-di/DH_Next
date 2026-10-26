import type { Availability } from "../calendar/availability.ts";
import type { Repo } from "../db/repo.ts";
import { localParts, startOfLocalDay, zonedTimeToUtc } from "../time.ts";
import type { BusyBlock } from "../types.ts";

// The fake group behind /mock: five people with weekly free/busy patterns,
// so slot finding returns believable times without a real calendar.

export const MOCK_BOT = "+15550000000";
export const MOCK_GROUP_ID = "mock-group";
export const MOCK_GROUP_NAME = "Weekend Crew";

/** A recurring busy block in local time. Hours may be fractional (17.5 = 5:30 PM). */
export interface WeeklyBusy {
  days: number[]; // 0 = Sunday
  from: number;
  to: number;
}

export interface MockUser {
  phone: string;
  name: string;
  busy: WeeklyBusy[];
}

const WEEKDAYS = [1, 2, 3, 4, 5];

export const MOCK_USERS: MockUser[] = [
  {
    phone: "+15550000001",
    name: "Maya",
    busy: [
      { days: WEEKDAYS, from: 9, to: 17.5 },
      { days: [6], from: 10, to: 13 },
      { days: [0], from: 17, to: 19 },
    ],
  },
  {
    phone: "+15550000002",
    name: "Jordan",
    busy: [
      { days: WEEKDAYS, from: 8.5, to: 17 },
      { days: [5], from: 18, to: 21.5 },
      { days: [0], from: 9, to: 12 },
    ],
  },
  {
    phone: "+15550000003",
    name: "Priya",
    busy: [
      { days: WEEKDAYS, from: 10, to: 18 },
      { days: [3], from: 19, to: 21 },
      // Ends at 6 on Saturday, leaving room for a second dinner slot if round 1 is turned down.
      { days: [6], from: 16, to: 18 },
    ],
  },
  {
    phone: "+15550000004",
    name: "Sam",
    busy: [
      { days: WEEKDAYS, from: 9, to: 17 },
      { days: [2, 4], from: 18.5, to: 20.5 },
      { days: [6], from: 12, to: 16 },
    ],
  },
  {
    phone: "+15550000005",
    name: "Theo",
    busy: [
      { days: [1, 2, 3, 4], from: 9.5, to: 17.5 },
      { days: [5], from: 9.5, to: 15 },
      { days: [0], from: 13, to: 16 },
    ],
  },
];

/** Expands weekly patterns into concrete busy blocks overlapping [windowStart, windowEnd). */
export function busyBlocks(
  pattern: WeeklyBusy[],
  windowStart: Date,
  windowEnd: Date,
  timezone: string,
): BusyBlock[] {
  const blocks: BusyBlock[] = [];
  for (let offset = 0; ; offset++) {
    const dayStart = startOfLocalDay(windowStart, timezone, offset);
    if (dayStart >= windowEnd) break;
    // Read the date at local noon so a DST switch can't land us on the wrong day.
    const day = localParts(new Date(dayStart.getTime() + 12 * 3_600_000), timezone);
    for (const b of pattern.filter((b) => b.days.includes(day.weekday))) {
      const at = (h: number) =>
        zonedTimeToUtc(day.year, day.month, day.day, Math.floor(h), timezone, Math.round((h % 1) * 60));
      const block = { start: at(b.from), end: at(b.to) };
      if (block.start < windowEnd && windowStart < block.end) blocks.push(block);
    }
  }
  return blocks;
}

/**
 * Drop-in for `loadAvailability` that answers from the fixtures above.
 * Anyone not in `users` (e.g. a number typed into the chat by hand) is unknown.
 */
export function createFakeAvailability(users: MockUser[], timezone: string) {
  return async (repo: Repo, userIds: string[], windowStart: Date, windowEnd: Date): Promise<Availability> => {
    const result: Availability = new Map();
    for (const userId of userIds) {
      const phone = (await repo.getUser(userId))?.phone;
      const user = users.find((u) => u.phone === phone);
      result.set(userId, user ? busyBlocks(user.busy, windowStart, windowEnd, timezone) : null);
    }
    return result;
  };
}
