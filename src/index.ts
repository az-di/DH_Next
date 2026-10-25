import { config, hasPhoton, hasSendblue } from "./config.ts";
import { createRepo } from "./db/index.ts";
import { createBrain } from "./llm/index.ts";
import { createDeduper } from "./messaging/dedupe.ts";
import { createPhotonTransport, type PhotonTransport } from "./messaging/photon.ts";
import { ConsoleMessenger, SendblueMessenger, type Messenger } from "./messaging/sendblue.ts";
import { createMockDemo, type MockDemo } from "./mock/index.ts";
import { Coordinator } from "./plans/coordinator.ts";
import { createServer } from "./server.ts";

// Pick the messaging provider: explicit MESSAGING_PROVIDER wins, otherwise the
// first one with credentials (Photon, then Sendblue), otherwise log-only.
const provider =
  config.messagingProvider || (hasPhoton() ? "photon" : hasSendblue() ? "sendblue" : "console");

let photon: PhotonTransport | undefined;
let mock: MockDemo | undefined;
let messenger: Messenger;
if (provider === "photon") {
  try {
    photon = await createPhotonTransport();
  } catch (err) {
    console.error(`[photon] ${(err as Error).message}`);
    process.exit(1);
  }
  messenger = photon.messenger;
} else if (provider === "sendblue") {
  messenger = new SendblueMessenger();
} else if (provider === "mock") {
  // Local group chat at /mock with fake users, seeded calendars, and a fast-forward clock.
  mock = await createMockDemo();
  messenger = mock.messenger;
} else {
  console.warn("[messaging] no provider credentials — messages will be logged, not sent");
  messenger = new ConsoleMessenger();
}

const repo = mock?.repo ?? createRepo();
const coordinator = new Coordinator({ repo, messenger, brain: createBrain(), ...mock?.coordinatorDeps });
const app = createServer({ repo, coordinator, photon, mock: mock?.server });

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} (messaging: ${provider})`);
  if (provider === "sendblue") console.log(`[server] Sendblue webhook: ${config.publicBaseUrl}/webhooks/sendblue`);
  if (mock) console.log(`[server] mock group chat: http://localhost:${config.port}/mock`);
  if (photon && config.photon.inbound === "webhook") {
    console.log(`[server] Photon webhook: ${config.publicBaseUrl}/webhooks/photon`);
  }
});

// Photon stream mode: no public URL needed, the SDK holds a connection open.
if (photon && config.photon.inbound === "stream") {
  const firstTime = createDeduper();
  console.log("[photon] listening for iMessages on the Spectrum stream");
  photon
    .listen((msg) => (firstTime(msg.messageHandle) ? coordinator.handleInbound(msg) : Promise.resolve()))
    .catch((err) => {
      console.error("[photon] inbound stream stopped:", err);
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
    await photon?.stop().catch(() => {});
    process.exit(0);
  });
}
