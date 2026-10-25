import { config } from "./config.ts";
import { createRepo } from "./db/index.ts";
import { createBrain } from "./llm/index.ts";
import { createMessenger } from "./messaging/sendblue.ts";
import { Coordinator } from "./plans/coordinator.ts";
import { createServer } from "./server.ts";

const repo = createRepo();
const coordinator = new Coordinator({ repo, messenger: createMessenger(), brain: createBrain() });
const app = createServer({ repo, coordinator });

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  console.log(`[server] Sendblue webhook: ${config.publicBaseUrl}/webhooks/sendblue`);
});

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
