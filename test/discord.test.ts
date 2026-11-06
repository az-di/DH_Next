import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, isDiscordId, needsMembers, normalizeMention, reactionToInbound, toInbound } from "../src/messaging/discord.ts";
import { isMentioned } from "../src/messaging/mentions.ts";
import { RoutingMessenger, ConsoleMessenger } from "../src/messaging/sendblue.ts";
import { parseVotes } from "../src/messaging/votes.ts";

const BOT = "999";

test("a bot mention becomes the @planner form", () => {
  assert.equal(normalizeMention("<@999> dinner  next weekend", BOT, "planner"), "@planner dinner next weekend");
  assert.equal(normalizeMention("<@!999> hi", BOT, "planner"), "@planner hi");
  assert.ok(isMentioned(normalizeMention("<@999> dinner", BOT, "planner")));
});

test("a guild message maps to a namespaced group message", () => {
  const msg = toInbound(
    { id: "m1", channelId: "c1", content: "<@999> dinner", author: { id: "u1" }, inGuild: true },
    BOT,
    ["discord:user:u1"],
  );
  assert.equal(msg.groupId, "discord:channel:c1");
  assert.equal(msg.from, "discord:user:u1");
  assert.equal(msg.text, "@planner dinner");
});

test("the member list is fetched for a mention anywhere in a group message", () => {
  const inbound = (content: string, inGuild = true) =>
    toInbound({ id: "m", channelId: "c1", content, author: { id: "u1" }, inGuild }, BOT);
  assert.equal(needsMembers(inbound("<@999> dinner")), true);
  assert.equal(needsMembers(inbound("hey <@999> dinner next weekend")), true);
  assert.equal(needsMembers(inbound("dinner next weekend")), false);
  assert.equal(needsMembers(inbound("<@999> dinner", false)), false);
});

test("a DM has no group id", () => {
  const msg = toInbound({ id: "m", channelId: "d", content: "hi", author: { id: "u1" }, inGuild: false }, BOT);
  assert.equal(msg.groupId, null);
});

test("emoji reactions become votes on the reacted-to message", () => {
  const msg = reactionToInbound({ emoji: "👍", messageId: "bot-1", channelId: "c1", inGuild: true }, "u2", BOT);
  assert.deepEqual(parseVotes(msg), [
    { vote: "yes", optionNumber: null, targetHandle: "bot-1", quotedText: null },
  ]);
});

test("long replies are split under the 2000 char cap", () => {
  const parts = chunk(("x".repeat(90) + "\n").repeat(50));
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 2000));
});

test("RoutingMessenger sends Discord ids to Discord and the rest elsewhere", async () => {
  const discord = new ConsoleMessenger();
  const other = new ConsoleMessenger();
  const router = new RoutingMessenger(discord, other, isDiscordId);
  await router.sendGroup("discord:channel:1", "a");
  await router.sendDirect("+15550000001", "b");
  assert.equal(discord.outbox.length, 1);
  assert.equal(other.outbox.length, 1);
});
