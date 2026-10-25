import { config } from "../config.ts";
import { MemoryRepo } from "../db/memory.ts";
import { MockChat, MockMessenger } from "../messaging/mock.ts";
import type { CoordinatorDeps } from "../plans/coordinator.ts";
import { MockClock } from "./clock.ts";
import { createFakeAvailability, MOCK_BOT, MOCK_USERS, type MockUser } from "./fixtures.ts";
import type { MockDemoDeps } from "./routes.ts";

export interface MockDemo {
  messenger: MockMessenger;
  /** Always in-memory, so reset can clear it and demo data never reaches Supabase. */
  repo: MemoryRepo;
  /** Spread into the Coordinator: the mock clock and seeded free/busy. */
  coordinatorDeps: Pick<CoordinatorDeps, "now" | "loadAvailability" | "calendarsEnabled">;
  /** Passed to createServer, which mounts /mock. */
  server: Omit<MockDemoDeps, "coordinator">;
}

export async function createMockDemo(
  users: MockUser[] = MOCK_USERS,
  timezone = config.defaultTimezone,
): Promise<MockDemo> {
  const repo = new MemoryRepo();
  const clock = new MockClock();
  const chat = new MockChat(MOCK_BOT, clock.now);
  for (const user of users) await repo.upsertUserByPhone(user.phone, { name: user.name });
  return {
    messenger: new MockMessenger(chat),
    repo,
    coordinatorDeps: {
      now: clock.now,
      loadAvailability: createFakeAvailability(users, timezone),
      // Everyone already "has" a calendar, so nobody is sent a connect link.
      calendarsEnabled: false,
    },
    server: { repo, chat, clock, users, timezone },
  };
}
