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

test("partial voters: 👎 on option 1 and a skip on option 2 holds the round; one nudge, no reminders or timeout", async () => {
  const { repo, messenger, coordinator, send, plan, advance } = setup();
  await send(ALICE, "@planner dinner next weekend");
  const [first, second] = optionBubbles(messenger);
  const tap = (from: string, reaction: string, bubble: typeof first) =>
    send(from, "", { reaction, reply_to: { message_handle: bubble.messageHandle } });

  await tap(ALICE, "dislike", first);
  await tap(BOB, "like", second);
  await tap(CARA, "like", second);
  assert.equal((await plan()).status, "proposed", "Alice skipped option 2, so it can't lock early");

  const p = await plan();
  const span = Date.parse(p.deadline!) - Date.parse(p.roundStartedAt!);
  advance(span * 0.5);
  await coordinator.tick();
  advance(span * 0.36);
  await coordinator.tick();
  const directs = () => messenger.outbox.filter((o) => o.kind === "direct");
  assert.deepEqual(directs().map((o) => o.to), [ALICE], "only Alice, who skipped the leading option");
  assert.match(directs()[0].content, /Option 2 .* is looking likely/);
  assert.doesNotMatch(directs()[0].content, /reminder/);

  advance(span * 0.2);
  await coordinator.tick();
  const done = await plan();
  assert.equal(done.status, "locked");
  assert.equal(repo.slots.find((s) => s.id === done.lockedSlotId)!.optionNumber, 2);
  assert.ok(repo.members.every((m) => !m.timedOut), "nobody timed out");
  assert.equal(directs().length, 1, "no 'went ahead' DMs");
  assert.doesNotMatch(messenger.outbox.at(-1)!.content, /Didn't hear from/);
});

test("someone who voted on one option isn't reminded; someone who voted on none is", async () => {
  const { messenger, coordinator, send, plan, advance } = setup();
  await send(ALICE, "@planner dinner next weekend");
  await send(ALICE, "1");
  await send(BOB, "2 maybe");

  const p = await plan();
  const span = Date.parse(p.deadline!) - Date.parse(p.roundStartedAt!);
  advance(span * 0.5);
  await coordinator.tick();
  const reminders = messenger.outbox.filter((o) => o.kind === "direct" && /reminder/.test(o.content));
  assert.deepEqual(reminders.map((r) => r.to), [CARA]);
});

test("nudge is for essential members only and respects the 2-reminder cap", async () => {
  const { repo, messenger, coordinator, send, plan, advance } = setup();
  await send(ALICE, "@planner dinner next weekend optional: +15550000003");
  await send(ALICE, "1");
  await send(BOB, "2 maybe");
  await send(CARA, "3");

  const p = await plan();
  const span = Date.parse(p.deadline!) - Date.parse(p.roundStartedAt!);
  const bob = await repo.upsertUserByPhone(BOB);
  await repo.updateMember(p.id, bob.id, { remindersSent: 2 }); // already used up
  advance(span * 0.9);
  await coordinator.tick();
  assert.equal(messenger.outbox.filter((o) => o.kind === "direct").length, 0, "Bob is capped; Cara is optional");
});

const roleOf = async (repo: MemoryRepo, phone: string) => {
  const user = await repo.upsertUserByPhone(phone);
  return repo.members.find((m) => m.userId === user.id)!.role;
};

test("organizer marks people optional by name when starting a plan", async () => {
  const { repo, messenger, send, plan } = setup();
  await repo.upsertUserByPhone(CARA, { name: "Cara" });
  await send(ALICE, "@planner dinner next weekend, Cara is optional");
  assert.equal((await plan()).request.activity, "dinner", "the role clause isn't part of the request");
  assert.equal(await roleOf(repo, CARA), "optional");
  assert.equal(await roleOf(repo, BOB), "essential");
  assert.match(messenger.outbox[0].content, /^On it! .* Cara is optional\./);
});

test("mid-plan role change by name settles the round when the rest already agreed", async () => {
  const { repo, messenger, send, plan } = setup();
  await repo.upsertUserByPhone(BOB, { name: "Bob" });
  await repo.upsertUserByPhone(CARA, { name: "Cara" });
  await send(ALICE, "@planner dinner next weekend");
  await send(ALICE, "1");
  assert.equal((await plan()).status, "proposed");

  await send(BOB, "@planner Cara is optional");
  assert.match(messenger.outbox.at(-1)!.content, /Only …0001, who started this plan/);
  assert.equal(await roleOf(repo, CARA), "essential", "only the organizer can change roles");

  await send(ALICE, "@planner Bob and Cara are optional");
  assert.ok(messenger.outbox.some((o) => o.content === "Got it: Bob and Cara are optional."));
  assert.equal((await plan()).status, "locked", "Alice is the only required member and said yes");
});

test("an unknown name is asked about once, then applied when that person introduces themselves", async () => {
  const { repo, messenger, send } = setup();
  await send(ALICE, "@planner dinner next weekend, Sam is optional");
  const questions = () => messenger.outbox.filter((o) => /I don't know who Sam is yet/.test(o.content));
  assert.equal(questions().length, 1);
  assert.match(questions()[0].content, /reply "@planner I'm Sam"/);

  await send(ALICE, "@planner Sam is optional");
  assert.equal(questions().length, 1, "doesn't ask again");

  await send(CARA, "@planner I'm Sam");
  assert.equal((await repo.upsertUserByPhone(CARA)).name, "Sam");
  assert.equal(await roleOf(repo, CARA), "optional");
  assert.equal(messenger.outbox.at(-1)!.content, "Thanks, Sam! You're optional for dinner.");
});

test("an ambiguous name gets one question; the organizer answers with the full name", async () => {
  const { repo, messenger, send, plan } = setup();
  await repo.upsertUserByPhone(BOB, { name: "Sam Lee" });
  await repo.upsertUserByPhone(CARA, { name: "Sam Patel" });
  await send(ALICE, "@planner dinner next weekend");
  await send(ALICE, "@planner sam is optional");
  assert.match(messenger.outbox.at(-1)!.content, /^Which Sam do you mean: Sam Lee or Sam Patel\?/);
  assert.equal(await roleOf(repo, BOB), "essential");

  await send(ALICE, "@planner Sam Patel");
  assert.equal(messenger.outbox.at(-1)!.content, "Got it: Sam Patel is optional.");
  assert.equal(await roleOf(repo, CARA), "optional");
  assert.equal(await roleOf(repo, BOB), "essential");
  assert.deepEqual((await plan()).pendingRoles, []);
});

test("introducing yourself outside a plan just saves the name", async () => {
  const { repo, messenger, send } = setup();
  await send(BOB, "@planner my name is bob");
  assert.equal((await repo.upsertUserByPhone(BOB)).name, "Bob");
  assert.equal(messenger.outbox.at(-1)!.content, "Nice to meet you, Bob!");
  assert.equal(repo.plans.size, 0);
});

test("any member can make themselves optional, but not required and not someone else", async () => {
  const { repo, messenger, send } = setup();
  await repo.upsertUserByPhone(BOB, { name: "Bob" });
  await repo.upsertUserByPhone(CARA, { name: "Cara" });
  await send(ALICE, "@planner dinner next weekend, Bob is optional");

  await send(CARA, "@planner I'm optional");
  assert.equal(await roleOf(repo, CARA), "optional");
  assert.equal(messenger.outbox.at(-1)!.content, "Got it: Cara is optional.");

  await send(BOB, "@planner I'm required");
  assert.equal(await roleOf(repo, BOB), "optional", "can't override the organizer");
  assert.match(messenger.outbox.at(-1)!.content, /^Only …0001/);

  await send(CARA, "@planner I'm optional and Bob is required");
  assert.equal(await roleOf(repo, BOB), "optional", "a mixed statement is the organizer's call");
});

test("preferences in chat are saved, confirmed in one line, and don't start a plan", async () => {
  const { repo, messenger, send } = setup();
  await repo.upsertUserByPhone(BOB, { name: "Bob" });
  await send(BOB, "@planner I don't do mornings");
  assert.equal(messenger.outbox.at(-1)!.content, "Saved for Bob: never mornings.");
  assert.equal(repo.plans.size, 0);

  await send(BOB, "@planner I prefer evenings");
  const bob = await repo.upsertUserByPhone(BOB);
  assert.deepEqual(await repo.getPreferences(bob.id), {
    preferredTimes: ["evening"],
    preferredDays: [],
    never: [{ days: [0, 1, 2, 3, 4, 5, 6], from: 5, to: 12 }],
  });
});

test("a never-time in chat is a hard filter on the next proposal, even mid-plan", async () => {
  const { repo, send } = setup();
  await send(BOB, "@planner nothing after 7pm");
  await send(ALICE, "@planner dinner next weekend");
  const starts = repo.slots.map((s) => localHour(new Date(s.start), "America/Los_Angeles"));
  assert.ok(starts.length > 0);
  assert.ok(starts.every((h) => h === 17), `dinner (2h) has to end by 7 PM: ${starts}`);
});

test("a one-off constraint with no plan open doesn't start one", async () => {
  const { repo, messenger, send } = setup();
  await send(BOB, "@planner I can't do this Saturday");
  assert.equal(repo.plans.size, 0);
  assert.equal(messenger.outbox.length, 1);
  assert.match(messenger.outbox[0].content, /^There's nothing scheduled right now\./);
  assert.equal(repo.preferences.size, 0, "never saved as a preference");
});

test("a one-off constraint during a plan is a 'no' on the matching options, then the round is re-checked", async () => {
  const { repo, messenger, send, plan } = setup();
  await repo.upsertUserByPhone(CARA, { name: "Cara" });
  await send(ALICE, "@planner dinner next weekend"); // Sat Nov 7 – Sun Nov 8, 3 options
  const options = repo.slots.filter((s) => s.round === 1);
  const day = (iso: string) => localParts(new Date(iso), "America/Los_Angeles").weekday;
  const sunday = options.filter((s) => day(s.start) === 0).map((s) => s.optionNumber);
  assert.ok(sunday.length > 0 && sunday.length < options.length, "options on both days");

  await send(CARA, "@planner I can't do next sunday");
  const cara = await repo.upsertUserByPhone(CARA);
  const votes = repo.responses.filter((r) => r.userId === cara.id);
  assert.deepEqual(
    votes.map((v) => [repo.slots.find((s) => s.id === v.slotId)!.optionNumber, v.vote]),
    sunday.map((n) => [n, "no"]),
  );
  assert.match(messenger.outbox.at(-1)!.content, /^Got it, Cara: marked you as a no for option/);
  assert.equal(repo.preferences.size, 0, "plan-scoped only");

  // Re-checked: once everyone else agrees on a Saturday option, it locks without waiting on Cara.
  const saturday = options.find((s) => day(s.start) === 6)!;
  await send(ALICE, String(saturday.optionNumber));
  await send(BOB, String(saturday.optionNumber));
  assert.equal((await plan()).status, "proposed", "Cara hasn't said yes to it");
  await send(CARA, "@planner I can't do next saturday");
  assert.equal((await plan()).round, 2, "every option now has an essential no, so the round moves on");
});

test("a constraint that matches no current option says so and changes nothing", async () => {
  const { repo, messenger, send } = setup();
  await send(ALICE, "@planner dinner next weekend");
  await send(BOB, "@planner I'm busy tomorrow");
  assert.equal(repo.responses.length, 0);
  assert.match(messenger.outbox.at(-1)!.content, /None of the current options are then\./);
});
