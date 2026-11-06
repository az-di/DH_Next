import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MemoryRepo } from "../src/db/memory.ts";
import { TemplateBrain } from "../src/llm/index.ts";
import { addressing } from "../src/messaging/address.ts";
import { withDedupe } from "../src/messaging/dedupe.ts";
import { toInbound as discordInbound } from "../src/messaging/providers/discord/index.ts";
import { toInbound as photonInbound } from "../src/messaging/providers/photon/index.ts";
import { parseInbound as sendblueInbound } from "../src/messaging/providers/sendblue/parse.ts";
import { PROVIDERS, selectProviders } from "../src/messaging/registry.ts";
import { RoutingMessenger } from "../src/messaging/router.ts";
import type { InboundHandler, InboundMessage, Messenger, Provider, ProviderDefinition } from "../src/messaging/types.ts";
import { Coordinator } from "../src/plans/coordinator.ts";
import { createServer } from "../src/server.ts";

// ── The contract every provider has to meet ──────────────────────────────

test("registered providers have unique names and connect-free definitions", () => {
  const names = PROVIDERS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length);
  for (const def of PROVIDERS) {
    assert.ok(def.name && def.network, "name and network");
    assert.equal(typeof def.isConfigured(), "boolean", def.name);
  }
});

// What each provider turns one group message into, built from its own wire format.
const inboundSamples: Record<string, { network: string; msg: InboundMessage }> = {
  sendblue: {
    network: "imessage",
    msg: sendblueInbound({ content: "hi", from_number: "+15550000001", to_number: "+15550000000", group_id: "g", participants: ["+15550000001"], message_handle: "m" }),
  },
  photon: {
    network: "imessage",
    msg: photonInbound(
      { id: "g", isGroup: true, phone: "+15550000000" },
      { id: "m", direction: "inbound", sender: { id: "+15550000001" }, content: { type: "text", text: "hi" } },
      ["+15550000001"],
    ),
  },
  discord: {
    network: "discord",
    msg: discordInbound({ id: "m", channelId: "g", content: "hi", author: { id: "1" }, inGuild: true }, "9", ["discord:user:1"]),
  },
};

for (const [name, { network, msg }] of Object.entries(inboundSamples)) {
  test(`${name}: every address it produces carries the ${network} prefix`, () => {
    const addresses = [msg.from, msg.groupId, ...msg.participants, msg.botAddress].filter((a) => a !== null);
    assert.ok(addresses.length >= 3, "sample includes sender, group, and a participant");
    for (const address of addresses) assert.ok(address!.startsWith(`${network}:`), `${address}`);
  });
}

test("an unknown sender stays blank instead of becoming a bare prefix", () => {
  assert.equal(sendblueInbound({ content: "hi", message_handle: "m" }).from, "");
});

// ── A new network, built only from what a provider folder would contain ──

function fakeTelegram(options: { reactions: boolean; failDmsTo?: string[] }) {
  const { wrap, unwrap } = addressing("telegram");
  const sent: { to: string; content: string; handle: string }[] = [];
  let next = 0;
  const record = (to: string, content: string) => {
    const handle = `tg-${++next}`;
    sent.push({ to, content, handle });
    return handle;
  };
  const messenger: Messenger = {
    async sendGroup(groupId, content) {
      return { messageHandle: record(unwrap(groupId), content), groupId };
    },
    async sendDirect(address, content) {
      if (options.failDmsTo?.includes(address)) throw new Error("user has not started the bot");
      return { messageHandle: record(unwrap(address), content), groupId: null };
    },
  };
  const definition: ProviderDefinition = {
    name: "telegram",
    network: "telegram",
    isConfigured: () => true,
    async create(): Promise<Provider> {
      return {
        name: "telegram",
        network: "telegram",
        capabilities: { reactions: options.reactions },
        messenger,
        routes(app, onMessage) {
          app.post("/webhooks/telegram", (readJson), async (req, res) => {
            const u = req.body;
            res.json({ ok: true });
            await onMessage({
              messageHandle: String(u.id),
              from: wrap(u.from),
              botAddress: null,
              groupId: wrap(u.chat),
              participants: u.members.map(wrap),
              names: u.names,
              text: u.text,
              replyToHandle: null,
              reaction: null,
              isOutbound: false,
            });
          });
        },
      };
    },
  };
  return { definition, sent };
}

// Reads JSON without relying on the app's global parser, which runs after provider routes.
const readJson = (req: any, _res: any, next: () => void) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk));
  req.on("end", () => {
    req.body = JSON.parse(raw);
    next();
  });
};

async function startWith(telegram: ReturnType<typeof fakeTelegram>, calendarsEnabled = false) {
  // Goes through the same pieces as index.ts: registry → provider → router → coordinator → server.
  const [def] = selectProviders(["telegram"], [...PROVIDERS, telegram.definition]);
  const provider = await def.create();
  const repo = new MemoryRepo();
  const router = new RoutingMessenger([provider]);
  const coordinator = new Coordinator({
    repo,
    messenger: router,
    brain: new TemplateBrain(),
    now: () => new Date("2026-10-28T17:00:00Z"),
    timezone: "America/Los_Angeles",
    calendarsEnabled,
    supportsReactions: (id) => router.supportsReactions(id),
  });
  const onMessage: InboundHandler = withDedupe((msg) => coordinator.handleInbound(msg));
  const server = createServer({ repo, coordinator, inbound: { providers: [provider], onMessage } }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/telegram`;
  let id = 0;
  const say = async (from: string, text: string, names?: Record<string, string>) => {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ++id, from, chat: "chat1", members: ["1", "2"], names, text }),
    });
    // The route acknowledges first; wait for the coordinator to finish with the message.
    await new Promise((resolve) => setTimeout(resolve, 20));
  };
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { repo, say, close };
}

test("a new network plans end to end with no changes outside its own provider", async () => {
  const telegram = fakeTelegram({ reactions: true });
  const { repo, say, close } = await startWith(telegram);
  try {
    await say("1", "@planner dinner next weekend");
    const plan = [...repo.plans.values()][0];
    assert.equal(plan.groupId, "telegram:chat1");
    assert.equal(plan.status, "proposed");
    assert.ok(telegram.sent.every((m) => m.to === "chat1"), "sends use the network's own ids");

    await say("1", "1");
    await say("2", "1");
    assert.equal(plan.status, "locked");
    assert.match(telegram.sent.at(-1)!.content, /Locked in: dinner/);
  } finally {
    close();
  }
});

test("copy only offers emoji votes on networks that support them", async () => {
  for (const reactions of [true, false]) {
    const telegram = fakeTelegram({ reactions });
    const { say, close } = await startWith(telegram);
    try {
      await say("1", "@planner dinner next weekend");
      const intro = telegram.sent.find((m) => /options for dinner/.test(m.content))!.content;
      assert.equal(/👍/.test(intro), reactions, intro);
      assert.match(intro, /[Rr]eply with the numbers/);
    } finally {
      close();
    }
  }
});

test("a failed calendar DM is reported to the group, without posting the personal link", async () => {
  const telegram = fakeTelegram({ reactions: true, failDmsTo: ["telegram:2"] });
  const { say, close } = await startWith(telegram, true);
  const logged = console.error;
  console.error = () => {};
  try {
    await say("1", "@planner dinner next weekend", { "telegram:1": "Maya", "telegram:2": "Sam" });
    const toGroup = telegram.sent.filter((m) => m.to === "chat1").map((m) => m.content);
    assert.ok(toGroup.some((c) => /couldn't DM Sam a calendar link/.test(c)), toGroup.join("\n"));
    assert.ok(!toGroup.some((c) => /https?:\/\//.test(c)), "no link in the group");
    assert.ok(telegram.sent.some((m) => m.to === "1" && /https?:\/\//.test(m.content)), "Maya still got hers");
  } finally {
    console.error = logged;
    close();
  }
});

test("names from the network fill gaps but never replace a name someone gave", async () => {
  const telegram = fakeTelegram({ reactions: true });
  const { repo, say, close } = await startWith(telegram);
  try {
    await repo.upsertUserByAddress("telegram:2", { name: "Sammy" });
    await say("1", "@planner dinner next weekend", { "telegram:1": "Maya", "telegram:2": "Sam" });
    assert.equal((await repo.upsertUserByAddress("telegram:1")).name, "Maya");
    assert.equal((await repo.upsertUserByAddress("telegram:2")).name, "Sammy");
  } finally {
    close();
  }
});
