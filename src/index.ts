import { config } from "./config.ts";
import { createRepo } from "./db/index.ts";
import { createBrain } from "./llm/index.ts";
import { withDedupe } from "./messaging/dedupe.ts";
import { createProviders } from "./messaging/registry.ts";
import { RoutingMessenger } from "./messaging/router.ts";
import type { Provider } from "./messaging/types.ts";
import { createMockDemo } from "./mock/index.ts";
import { Coordinator } from "./plans/coordinator.ts";
import { createServer } from "./server.ts";

// Local group chat at /mock with fake users, seeded calendars, and a fast-forward
// clock. It replaces real providers, so a demo never talks to real servers.
const mock = config.messagingProviders.includes("mock") ? await createMockDemo() : undefined;

let providers: Provider[] = [];
if (!mock) {
  try {
    providers = await createProviders(config.messagingProviders);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

const repo = mock?.repo ?? createRepo();
const messenger = mock?.messenger ?? new RoutingMessenger(providers);
const coordinator = new Coordinator({ repo, messenger, brain: createBrain(), ...mock?.coordinatorDeps });
const onMessage = withDedupe((msg) => coordinator.handleInbound(msg));
const app = createServer({ repo, coordinator, inbound: { providers, onMessage }, mock: mock?.server });

app.listen(config.port, () => {
  const names = mock ? "mock" : providers.map((p) => p.name).join(", ");
  console.log(`[server] listening on :${config.port} (messaging: ${names})`);
  if (mock) console.log(`[server] mock group chat: http://localhost:${config.port}/mock`);
});

for (const provider of providers) {
  provider.start?.(onMessage).catch((err) => {
    console.error(`[${provider.name}] inbound stopped:`, err);
    process.exit(1);
  });
}

// Scheduler: reminders, deadlines, and round transitions. A single in-process
// interval is enough for the MVP; move to a queue/cron when running >1 instance.
let ticking = false;
setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await coordinator.tick();
  } finally {
    ticking = false;
  }
}, config.schedulerIntervalMs);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await Promise.allSettled(providers.map((p) => p.stop?.()));
    process.exit(0);
  });
}
