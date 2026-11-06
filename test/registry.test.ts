import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MemoryRepo } from "../src/db/memory.ts";
import { TemplateBrain } from "../src/llm/index.ts";
import { ConsoleMessenger, consoleProvider } from "../src/messaging/providers/console/index.ts";
import { sendblueProvider } from "../src/messaging/providers/sendblue/index.ts";
import { selectProviders } from "../src/messaging/registry.ts";
import { RoutingMessenger } from "../src/messaging/router.ts";
import type { Provider, ProviderDefinition } from "../src/messaging/types.ts";
import { Coordinator } from "../src/plans/coordinator.ts";
import { createServer } from "../src/server.ts";

function def(name: string, network: string, configured: boolean): ProviderDefinition {
  return { name, network, isConfigured: () => configured, create: () => Promise.reject(new Error("unused")) };
}
const names = (defs: ProviderDefinition[]) => defs.map((d) => d.name);

const AVAILABLE = [
  def("photon", "imessage", true),
  def("sendblue", "imessage", true),
  def("discord", "discord", true),
  def("telegram", "telegram", false),
  def("console", "imessage", false),
];

test("a blank list runs every configured provider, one per network", () => {
  assert.deepEqual(names(selectProviders([], AVAILABLE)), ["photon", "discord"]);
});

test("with no credentials anywhere, a blank list falls back to log-only", () => {
  const none = [def("photon", "imessage", false), def("console", "imessage", false)];
  assert.deepEqual(names(selectProviders([], none)), ["console"]);
});

test("an explicit list runs exactly what it names", () => {
  assert.deepEqual(names(selectProviders(["sendblue"], AVAILABLE)), ["sendblue"]);
  assert.deepEqual(names(selectProviders(["console", "telegram"], AVAILABLE)), ["console", "telegram"]);
});

test("an unknown name or two providers on one network is rejected", () => {
  assert.throws(() => selectProviders(["whatsap"], AVAILABLE), /Unknown messaging provider "whatsap"/);
  assert.throws(() => selectProviders(["photon", "sendblue"], AVAILABLE), /both serve imessage/);
});

test("the router sends each id to the network that owns it", async () => {
  const imessage = new ConsoleMessenger();
  const discord = new ConsoleMessenger();
  const telegram = new ConsoleMessenger();
  const router = new RoutingMessenger([
    { network: "imessage", capabilities: { reactions: true }, messenger: imessage },
    { network: "discord", capabilities: { reactions: true }, messenger: discord },
    { network: "telegram", capabilities: { reactions: false }, messenger: telegram },
  ]);
  await router.sendGroup("discord:channel:1", "a");
  await router.sendDirect("telegram:user:2", "b");
  await router.sendDirect("imessage:+15550000001", "c");
  assert.deepEqual(discord.outbox.map((m) => m.content), ["a"]);
  assert.deepEqual(telegram.outbox.map((m) => m.content), ["b"]);
  assert.deepEqual(imessage.outbox.map((m) => m.content), ["c"]);
});

test("the router refuses an id no running provider owns", () => {
  const router = new RoutingMessenger([{ network: "discord", capabilities: { reactions: true }, messenger: new ConsoleMessenger() }]);
  assert.throws(() => router.sendDirect("imessage:+15550000001", "c"), /no messaging provider is running/);
});

async function webhookStatus(providers: Provider[]) {
  const repo = new MemoryRepo();
  const coordinator = new Coordinator({ repo, messenger: new ConsoleMessenger(), brain: new TemplateBrain() });
  const handled: string[] = [];
  const onMessage = async (msg: { text: string }) => void handled.push(msg.text);
  const server = createServer({ repo, coordinator, inbound: { providers, onMessage } }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/sendblue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "hi", from_number: "+15550000001", message_handle: "m1" }),
  });
  server.closeAllConnections();
  server.close();
  return { status: res.status, handled };
}

test("the Sendblue webhook only exists when a provider that uses it is running", async () => {
  const discordOnly: Provider = { name: "discord", network: "discord", capabilities: { reactions: true }, messenger: new ConsoleMessenger() };
  assert.equal((await webhookStatus([discordOnly])).status, 404);

  for (const def of [consoleProvider, sendblueProvider]) {
    const { status, handled } = await webhookStatus([await def.create()]);
    assert.equal(status, 200, def.name);
    assert.deepEqual(handled, ["hi"], def.name);
  }
});
