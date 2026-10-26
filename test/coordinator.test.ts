import { test } from "node:test";
import assert from "node:assert/strict";
import { localHour } from "../src/calendar/slots.ts";
import { MemoryRepo } from "../src/db/memory.ts";
import { TemplateBrain } from "../src/llm/index.ts";
import { parseInbound } from "../src/messaging/inbound.ts";
import { ConsoleMessenger } from "../src/messaging/sendblue.ts";
import { Coordinator, extractOptional } from "../src/plans/coordinator.ts";
import { formatSlot, localParts, startOfLocalDay, zonedTimeToUtc } from "../src/time.ts";

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
  const { repo, messenger, send, plan } = setup();
  await send(ALICE, "@planner dinner next weekend");
  await send(BOB, "none");

  const p = await plan();
  assert.equal(p.round, 2);
  assert.equal(p.status, "proposed");
  const [r1, r2] = [1, 2].map((r) => repo.slots.filter((s) => s.round === r));
  assert.ok(r2.length >= 1);
  assert.ok(messenger.outbox.some((o) => /^That didn't work for everyone/.test(o.content)), "round 2 says round 1 didn't work");
  for (const a of r2) for (const b of r1) assert.ok(a.start >= b.end || a.end <= b.start, "no overlap with rejected");
  for (const s of r2) {
    const [start, end] = [s.start, s.end].map((t) => localHour(new Date(t), "America/Los_Angeles"));
    assert.ok(start >= 17 && end <= 22, `round 2 is still dinner time: ${s.start}`);
  }
});

test("round 2 with no dinner-time slots left goes to the organizer instead of off-hours times", async () => {
  const { repo, messenger, send, plan } = setup();
  await send(ALICE, "@planner dinner tomorrow");
  assert.equal(repo.slots.length, 2, "17–19 and 19–21 are the only non-overlapping dinners");
  await send(BOB, "none");

  const p = await plan();
  assert.equal(p.status, "organizer_pick");
  assert.equal(p.round, 2);
  assert.equal(repo.slots.length, 2, "no new (bad) slots were proposed");
  assert.match(messenger.outbox.at(-1)!.content, /Reply with a number/);
});

test("an explicit time outside the activity's usual hours is honored", async () => {
  const { messenger, send, plan } = setup();
  await send(ALICE, "@planner dinner at 4pm tomorrow");
  assert.equal((await plan()).status, "proposed");
  assert.deepEqual(optionBubbles(messenger).map((o) => o.content), ["Option 1: Thu, Oct 29, 4:00–6:00 PM"]);
});

test("an explicit late time is proposed even past 11 PM", async () => {
  const { messenger, send } = setup();
  await send(ALICE, "@planner drinks at 11pm tomorrow");
  assert.deepEqual(optionBubbles(messenger).map((o) => o.content), ["Option 1: Thu, Oct 29, 11:00 PM–1:00 AM"]);
});

test("\"tomorrow\" follows the coordinator's clock as it moves", async () => {
  const { messenger, send, advance } = setup(); // Wed Oct 28
  advance(2 * 24 * 3_600_000); // Fri Oct 30
  await send(ALICE, "@planner drinks at 11pm tomorrow");
  assert.deepEqual(optionBubbles(messenger).map((o) => o.content), ["Option 1: Sat, Oct 31, 11:00 PM–1:00 AM"]);
});

test("\"tomorrow\" uses the real date when no clock is injected", async () => {
  const messenger = new ConsoleMessenger();
  const coordinator = new Coordinator({
    repo: new MemoryRepo(),
    messenger,
    brain: new TemplateBrain(),
    timezone: "America/Los_Angeles",
    calendarsEnabled: false,
  });
  await coordinator.handleInbound(
    parseInbound({ content: "@planner drinks at 11pm tomorrow", from_number: ALICE, group_id: GROUP, participants: [ALICE, BOB], message_handle: "real-1" }),
  );
  const tz = "America/Los_Angeles";
  const t = localParts(startOfLocalDay(new Date(), tz, 1), tz);
  const start = zonedTimeToUtc(t.year, t.month, t.day, 23, tz);
  const expected = `Option 1: ${formatSlot(start, new Date(start.getTime() + 2 * 3_600_000), tz)}`;
  assert.deepEqual(optionBubbles(messenger).map((o) => o.content), [expected]);
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

test("a DM gets a how-to reply instead of starting a plan", async () => {
  const { repo, coordinator, messenger } = setup();
  await coordinator.handleInbound(
    parseInbound({ content: "hello?", from_number: ALICE, to_number: BOT, group_id: "", message_handle: "dm-1" }),
  );
  assert.equal(repo.plans.size, 0);
  assert.equal(messenger.outbox.at(-1)?.to, ALICE);
  assert.match(messenger.outbox.at(-1)!.content, /Add me to your group/);
});

test("a failed DM (e.g. allowlist rejection) doesn't break the plan", async () => {
  const { messenger, send, plan } = setup();
  messenger.sendDirect = async () => {
    throw new Error("Target not allowed for this project");
  };
  await send(ALICE, "@planner dinner next weekend");
  assert.equal((await plan()).status, "proposed");
});

test("organizer can mark people optional inline", () => {
  const { request, optionalPhones } = extractOptional("dinner next weekend optional: +15550000002, (555) 000-0003");
  assert.equal(request, "dinner next weekend");
  assert.deepEqual([...optionalPhones], ["+15550000002", "+15550000003"]);
});
