import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepo } from "../src/db/memory.ts";
import { TemplateBrain } from "../src/llm/index.ts";
import { parseInbound } from "../src/messaging/inbound.ts";
import { ConsoleMessenger } from "../src/messaging/sendblue.ts";
import { Coordinator, extractOptional } from "../src/plans/coordinator.ts";

const BOT = "+15550000000";
const ALICE = "+15550000001";
const BOB = "+15550000002";
const CARA = "+15550000003";
const GROUP = "group-1";

function setup() {
  const repo = new MemoryRepo();
  const messenger = new ConsoleMessenger();
  let now = new Date("2026-10-28T17:00:00Z"); // Wed 10:00 PDT
  const coordinator = new Coordinator({
    repo,
    messenger,
    brain: new TemplateBrain(),
    now: () => now,
    timezone: "America/Los_Angeles",
    calendarsEnabled: false,
  });
  let seq = 0;
  const send = (from: string, content: string, extra: Record<string, unknown> = {}) =>
    coordinator.handleInbound(
      parseInbound({
        content,
        from_number: from,
        to_number: BOT,
        group_id: GROUP,
        participants: [ALICE, BOB, CARA, BOT],
        message_handle: `in-${++seq}`,
        ...extra,
      }),
    );
  const plan = async () => (await repo.getOpenPlanForGroup(GROUP)) ?? [...repo.plans.values()].at(-1)!;
  return { repo, messenger, coordinator, send, plan, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const optionBubbles = (m: ConsoleMessenger) => m.outbox.filter((o) => o.content.startsWith("Option "));

test("happy path: request → options → votes → locked", async () => {
  const { repo, messenger, send, plan } = setup();
  await send(ALICE, "@planner dinner sometime next weekend");

  const p = await plan();
  assert.equal(p.status, "proposed");
  assert.equal(repo.members.length, 3, "bot is not a member");
  // No calendars connected → uncertain → 3 options.
  assert.equal(optionBubbles(messenger).length, 3);

  await send(ALICE, "2");
  await send(BOB, "2 yes, 1 maybe");
  assert.equal((await plan()).status, "proposed", "still waiting on Cara");
  await send(CARA, "2");

  const locked = await plan();
  assert.equal(locked.status, "locked");
  const slot = repo.slots.find((s) => s.id === locked.lockedSlotId)!;
  assert.equal(slot.optionNumber, 2);
  assert.match(messenger.outbox.at(-1)!.content, /Locked in: dinner/);
});

test("tapback on an option bubble counts as a vote on that option", async () => {
  const { repo, messenger, send, plan } = setup();
  await send(ALICE, "@planner lunch tomorrow");
  const bubble = optionBubbles(messenger)[0];

  await send(BOB, "", { reaction: "like", reply_to: { message_handle: bubble.messageHandle } });
  const votes = await repo.listResponses((await plan()).id);
  assert.equal(votes.length, 1);
  assert.equal(repo.slots.find((s) => s.id === votes[0].slotId)!.optionNumber, 1);
});

test("a no on every option moves to round 2 with fresh times", async () => {
  const { repo, send, plan } = setup();
  await send(ALICE, "@planner dinner next weekend");
  await send(BOB, "none");

  const p = await plan();
  assert.equal(p.round, 2);
  assert.equal(p.status, "proposed");
  const [r1, r2] = [1, 2].map((r) => repo.slots.filter((s) => s.round === r));
  assert.ok(r2.length >= 2);
  for (const a of r2) for (const b of r1) assert.ok(a.start >= b.end || a.end <= b.start, "no overlap with rejected");
});

test("after 3 failed rounds the organizer picks", async () => {
  const { messenger, send, plan } = setup();
  await send(ALICE, "@planner dinner next weekend");
  await send(ALICE, "1 yes 2 yes 3 yes");
  for (let i = 0; i < 3; i++) await send(BOB, "none");

  assert.equal((await plan()).status, "organizer_pick");
  assert.match(messenger.outbox.at(-1)!.content, /Reply with a number/);

  await send(BOB, "1"); // not the organizer: ignored
  assert.equal((await plan()).status, "organizer_pick");
  await send(ALICE, "1");
  assert.equal((await plan()).status, "locked");
});

test("reminders (max 2), then the deadline decides without silent members", async () => {
  const { repo, messenger, coordinator, send, plan, advance } = setup();
  await send(ALICE, "@planner dinner next weekend");
  await send(ALICE, "1 2 3");
  await send(BOB, "1");
  await send(BOB, "2 no 3 no");

  const p = await plan();
  const span = Date.parse(p.deadline!) - Date.parse(p.roundStartedAt!);
  const reminders = () => messenger.outbox.filter((o) => o.kind === "direct" && /reminder/.test(o.content));

  advance(span * 0.5);
  await coordinator.tick();
  advance(span * 0.36);
  await coordinator.tick();
  await coordinator.tick();
  assert.equal(reminders().length, 2);
  assert.ok(reminders().every((r) => r.to === CARA));

  advance(span * 0.2);
  await coordinator.tick();
  const done = await plan();
  assert.equal(done.status, "locked");
  assert.equal(repo.slots.find((s) => s.id === done.lockedSlotId)!.optionNumber, 1);
  assert.ok(repo.members.find((m) => m.timedOut), "Cara timed out");
  assert.ok(messenger.outbox.some((o) => o.to === CARA && /went ahead and picked/.test(o.content)));
});

test("chatter and second requests are handled politely", async () => {
  const { messenger, send } = setup();
  await send(ALICE, "lol hi");
  assert.equal(messenger.outbox.length, 0, "ignores messages without a plan or mention");
  await send(ALICE, "@planner hi");
  assert.match(messenger.outbox.at(-1)!.content, /didn't quite get that/);
  await send(ALICE, "@planner dinner next weekend");
  await send(BOB, "@planner drinks friday");
  assert.match(messenger.outbox.at(-1)!.content, /still working on dinner/);
});

test("organizer can mark people optional inline", () => {
  const { request, optionalPhones } = extractOptional("dinner next weekend optional: +15550000002, (555) 000-0003");
  assert.equal(request, "dinner next weekend");
  assert.deepEqual([...optionalPhones], ["+15550000002", "+15550000003"]);
});
