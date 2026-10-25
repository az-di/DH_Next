import { hasGoogle } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import type { BusyBlock } from "../types.ts";
import { fetchBusy, getAccessToken } from "./google.ts";

/**
 * Busy blocks per member. `null` means "unknown": no calendar connected, or
 * the lookup failed. Unknown members don't block slots, but they lower the
 * system's confidence (more options get proposed).
 */
export type Availability = Map<string, BusyBlock[] | null>;

export async function loadAvailability(
  repo: Repo,
  userIds: string[],
  windowStart: Date,
  windowEnd: Date,
): Promise<Availability> {
  const result: Availability = new Map();
  await Promise.all(
    userIds.map(async (userId) => {
      const conn = hasGoogle() ? await repo.getCalendarConnection(userId) : null;
      if (!conn) {
        result.set(userId, null);
        return;
      }
      try {
        const token = await getAccessToken(conn, repo);
        result.set(userId, await fetchBusy(token, windowStart, windowEnd));
      } catch (err) {
        console.error(`[calendar] free/busy failed for ${userId}:`, err);
        result.set(userId, null);
      }
    }),
  );
  return result;
}
