import { test } from "node:test";
import assert from "node:assert/strict";
import { toInbound, type SpaceInfo } from "../src/messaging/photon.ts";
import { MemoryRepo } from "../src/db/memory.ts";
import { TemplateBrain } from "../src/llm/index.ts";
import { ConsoleMessenger } from "../src/messaging/sendblue.ts";
import { parseVotes } from "../src/messaging/votes.ts";
import { Coordinator } from "../src/plans/coordinator.ts";

const group: SpaceInfo = { id: "any;+;chat123", isGroup: true, phone: "+15550009999" };
const dm: SpaceInfo = { id: "any;-;+15550000001", isGroup: false, phone: "+15550009999" };

test("text in a group maps to an inbound group message", () => {
  const msg = toInbound(
    group,
    { id: "m1", direction: "inbound", sender: { id: "+15550000001" }, content: { type: "text", text: " @planner dinner " } },
    ["+15550000001", "+15550000002"],
  );
  assert.deepEqual(msg, {
    messageHandle: "m1",
    from: "+15550000001",
    botNumber: "+15550009999",
    groupId: "any;+;chat123",
    participants: ["+15550000001", "+15550000002"],
    text: "@planner dinner",
    replyToHandle: null,
    reaction: null,
    isOutbound: false,
  });
});

test("a native tapback becomes a vote on the reacted-to bubble", () => {
  const msg = toInbound(group, {
    id: "m2",
    direction: "inbound",
    sender: { id: "+15550000002" },
    content: { type: "reaction", emoji: "👎", target: { id: "bot-option-1" } },
  });
  assert.deepEqual(parseVotes(msg), [
    { vote: "no", optionNumber: null, targetHandle: "bot-option-1", quotedText: null },
  ]);
});

test("question tapback is maybe; laugh is ignored", () => {
  const react = (emoji: string) =>
    parseVotes(
      toInbound(group, {
        id: emoji,
        direction: "inbound",
        sender: { id: "+1" },
        content: { type: "reaction", emoji, target: { id: "t" } },
      }),
    );
  assert.equal(react("❓")[0].vote, "maybe");
  assert.deepEqual(react("😂"), []);
});

test("a threaded reply unwraps to its text and remembers the target", () => {
  const msg = toInbound(group, {
    id: "m3",
    direction: "inbound",
    sender: { id: "+15550000003" },
    content: { type: "reply", target: { id: "bot-option-2" }, content: { type: "text", text: "yes" } },
  });
  assert.equal(msg.text, "yes");
  assert.equal(msg.replyToHandle, "bot-option-2");
});

test("DMs have no group id; outbound echoes are flagged", () => {
  const msg = toInbound(dm, { id: "m4", direction: "outbound", content: { type: "text", text: "hi" } });
  assert.equal(msg.groupId, null);
  assert.equal(msg.isOutbound, true);
  assert.equal(msg.from, "");
});

test("non-text content yields empty text (ignored downstream)", () => {
  const msg = toInbound(group, { id: "m5", direction: "inbound", sender: { id: "+1" }, content: { type: "attachment" } });
  assert.equal(msg.text, "");
  assert.equal(msg.reaction, null);
});

// Mirrors step 5 of docs/testing-photon.md so the guide stays accurate.
test("testing guide voting walkthrough locks option 2", async () => {
  const repo = new MemoryRepo();
  const messenger = new ConsoleMessenger();
  const coordinator = new Coordinator({
    repo,
    messenger,
    brain: new TemplateBrain(),
    now: () => new Date("2026-10-25T17:00:00Z"),
    timezone: "America/Los_Angeles",
    calendarsEnabled: false,
  });
  const ME = "+15550000001";
  const FRIEND = "+15550000002";
  let n = 0;
  const say = (from: string, text: string) =>
    coordinator.handleInbound(
      toInbound(group, { id: `w${++n}`, direction: "inbound", sender: { id: from }, content: { type: "text", text } }, [ME, FRIEND]),
    );
  const react = (from: string, emoji: string, target: string) =>
    coordinator.handleInbound(
      toInbound(group, { id: `w${++n}`, direction: "inbound", sender: { id: from }, content: { type: "reaction", emoji, target: { id: target } } }),
    );
  const status = async () => (await repo.getPlan([...repo.plans.keys()][0]))!.status;

  await say(ME, "@planner lunch tomorrow");
  const bubbles = messenger.outbox.filter((o) => o.content.startsWith("Option "));
  assert.equal(bubbles.length, 2, "a 90-minute lunch fits twice between 11 and 2");

  await react(ME, "👎", bubbles[1].messageHandle);
  assert.equal(await status(), "proposed");
  await say(FRIEND, "1 maybe, 2 yes"); // I skipped option 1: no response, not a no
  assert.equal(await status(), "proposed");
  await say(ME, "2"); // changes my option 2 vote to yes
  assert.equal(await status(), "locked");
  const plan = await repo.getPlan([...repo.plans.keys()][0]);
  assert.equal(repo.slots.find((s) => s.id === plan!.lockedSlotId)!.optionNumber, 2);
});
