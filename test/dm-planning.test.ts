import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { MemoryRepo } from "../src/db/memory.ts";
import { ClaudeBrain } from "../src/llm/claude.ts";
import { TemplateBrain } from "../src/llm/index.ts";
import { parseAvailabilityWithRules } from "../src/llm/rules.ts";
import { ConsoleMessenger } from "../src/messaging/providers/console/index.ts";
import type { InboundMessage } from "../src/messaging/types.ts";
import { Coordinator } from "../src/plans/coordinator.ts";
import { clipWindows, collectionDeadline, describeWindow, invertWindows, MAX_DM_MEMBERS } from "../src/plans/dm-planning.ts";
import { findNamed, readNumber, routeDirect, type DmPlan } from "../src/plans/dm-routing.ts";
import type { Plan } from "../src/types.ts";

const TZ = "America/Los_Angeles";
const HOUR = 3_600_000;
const GROUP = "discord:channel:1";
const MAYA = "discord:user:maya";
const SAM = "discord:user:sam";
const THEO = "discord:user:theo";
const NAMES = { [MAYA]: "Maya", [SAM]: "Sam", [THEO]: "Theo" };

/** A messenger whose DMs to the given addresses fail, like someone blocking DMs from a server. */
class BlockingMessenger extends ConsoleMessenger {
  blocked: string[];
  constructor(blocked: string[]) {
    super();
    this.blocked = blocked;
  }
  override async sendDirect(address: string, content: string) {
    if (this.blocked.includes(address)) throw new Error("Cannot send messages to this user");
    return super.sendDirect(address, content);
  }
}

function setup({ blocked = [] as string[], people = [MAYA, SAM, THEO] } = {}) {
  const repo = new MemoryRepo();
  const messenger = new BlockingMessenger(blocked);
  let now = new Date("2026-10-28T17:00:00Z"); // Wed 10:00 PDT
  const coordinator = new Coordinator({
    repo,
    messenger,
    brain: new TemplateBrain(),
    now: () => now,
    timezone: TZ,
    calendarsEnabled: false,
    capabilities: () => ({ reactions: true, collectByDm: true }),
  });
  let seq = 0;
  const inbound = (from: string, text: string, groupId: string | null): InboundMessage => ({
    messageHandle: `m${++seq}`,
    from,
    botAddress: null,
    groupId,
    participants: groupId ? people : [],
    names: groupId ? NAMES : undefined,
    text,
    replyToHandle: null,
    reaction: null,
    isOutbound: false,
  });
  return {
    repo,
    messenger,
    coordinator,
    post: (from: string, text: string, group = GROUP) => coordinator.handleInbound(inbound(from, text, group)),
    /** Posts in a channel with a display name, like Discord does. */
    postIn: (from: string, text: string, group: string, groupName: string) =>
      coordinator.handleInbound({ ...inbound(from, text, group), groupName }),
    /** A DM, optionally using Discord's Reply on one of the bot's messages. */
    dm: (from: string, text: string, replyTo: string | null = null) =>
      coordinator.handleInbound({ ...inbound(from, text, null), replyToHandle: replyTo }),
    plan: () => [...repo.plans.values()].at(-1)!,
    planIn: (group: string) => [...repo.plans.values()].filter((p) => p.groupId === group).at(-1)!,
    /** The answer a person gave for the plan in this channel. */
    answer: (group: string, address: string) => {
      const planId = [...repo.plans.values()].filter((p) => p.groupId === group).at(-1)!.id;
      const userId = [...repo.users.values()].find((u) => u.address === address)!.id;
      return repo.members.find((m) => m.planId === planId && m.userId === userId)!.statedAvailability;
    },
    /** Handle of the latest DM to this person that matches, for replying to it. */
    handleOf: (address: string, pattern: RegExp) =>
      messenger.outbox.filter((m) => m.to === address && pattern.test(m.content)).at(-1)!.messageHandle,
    to: (address: string) => messenger.outbox.filter((m) => m.to === address).map((m) => m.content),
    last: (address: string) => messenger.outbox.filter((m) => m.to === address).at(-1)?.content ?? "",
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

// Next weekend from Wed Oct 28 is Sat Nov 7 and Sun Nov 8 (PST).
const REQUEST = "@planner hangout next weekend";

test("a request DMs everyone in the channel and proposes nothing yet", async () => {
  const { post, plan, to, last } = setup();
  await post(MAYA, REQUEST);

  assert.equal(plan().status, "collecting");
  assert.match(last(GROUP), /DMing everyone/);
  assert.equal(to(GROUP).length, 1, "no options posted in the channel");
  assert.match(last(MAYA), /You're planning hangout/);
  assert.match(last(SAM), /Hi Sam! Maya is planning hangout/);
  assert.match(last(THEO), /What times work for you/);
});

test("answers overlap, the organizer picks by DM, and it locks in the channel", async () => {
  const { post, dm, plan, last, to } = setup();
  await post(MAYA, REQUEST);

  await dm(MAYA, "saturday");
  assert.match(last(MAYA), /Got it for hangout: Sat.*Still waiting on 2 people/);
  await dm(SAM, "saturday after 6");
  assert.equal(plan().status, "collecting", "still waiting on Theo");
  await dm(THEO, "anytime");

  assert.equal(plan().status, "organizer_pick");
  const options = last(MAYA);
  assert.match(options, /3 of 3 answered/);
  assert.match(options, /1\. Sat, Nov 7, 6:00–7:30 PM \(works for everyone who answered\)/);
  assert.ok(!/Option|\bSun\b/.test(options.split("\n").slice(1).join()), options);
  assert.match(last(GROUP), /Maya is picking/);
  assert.ok(!to(SAM).some((m) => /reply here with a number/i.test(m)), "only the organizer is asked to pick");

  await dm(MAYA, "1");
  assert.equal(plan().status, "locked");
  assert.match(last(GROUP), /Locked in: hangout, Sat, Nov 7, 6:00–7:30 PM/);
  assert.ok(!/Didn't hear from/.test(last(GROUP)), "everyone answered");
});

test("with no overlap, the organizer sees the closest times and who can't make each", async () => {
  const { post, dm, plan, last } = setup({ people: [MAYA, SAM] });
  await post(MAYA, REQUEST);
  await dm(MAYA, "saturday");
  await dm(SAM, "sunday");

  assert.equal(plan().status, "organizer_pick");
  assert.match(last(MAYA), /\((Sam|Maya) can't\)/);
});

test("'none' counts as an answer, and an unreadable reply asks again", async () => {
  const { post, dm, plan, last, repo } = setup({ people: [MAYA, SAM] });
  await post(MAYA, REQUEST);

  await dm(SAM, "what's this about?");
  assert.match(last(SAM), /couldn't work out times/);
  assert.equal(repo.members.find((m) => m.statedAvailability !== null), undefined);

  await dm(SAM, "none");
  assert.match(last(SAM), /nothing works for you/);
  await dm(MAYA, "saturday");
  assert.equal(plan().status, "organizer_pick");
});

test("times outside the plan aren't taken as an answer", async () => {
  const { post, dm, last, repo } = setup({ people: [MAYA, SAM] });
  await post(MAYA, REQUEST);
  await dm(SAM, "tomorrow"); // Thursday, not next weekend
  assert.match(last(SAM), /couldn't work out times/);
  assert.equal(repo.members.find((m) => m.statedAvailability !== null), undefined);
});

test("answering again replaces the earlier answer", async () => {
  const { post, dm, last } = setup();
  await post(MAYA, REQUEST);
  await dm(SAM, "saturday");
  await dm(SAM, "sunday");
  assert.match(last(SAM), /Got it for hangout: Sun/);
  assert.ok(!/Sat/.test(last(SAM)));
});

test("someone who can't be DMed is named in the channel and not waited for", async () => {
  const logged = console.error;
  console.error = () => {};
  try {
    const { post, dm, plan, to, last } = setup({ blocked: [THEO] });
    await post(MAYA, REQUEST);
    assert.ok(to(GROUP).some((m) => /couldn't DM Theo/.test(m)));

    await dm(MAYA, "saturday");
    await dm(SAM, "saturday");
    assert.equal(plan().status, "organizer_pick");
    assert.match(last(MAYA), /2 of 3 answered, no reply from Theo/);

    await dm(MAYA, "1");
    assert.match(last(GROUP), /Didn't hear from Theo/);
  } finally {
    console.error = logged;
  }
});

test("if the organizer can't be DMed, they pick in the channel without exposing who said what", async () => {
  const logged = console.error;
  console.error = () => {};
  try {
    const { post, dm, plan, last, coordinator } = setup({ blocked: [MAYA], people: [MAYA, SAM, THEO] });
    await post(MAYA, REQUEST);
    await dm(SAM, "saturday");
    await dm(THEO, "sunday");

    assert.equal(plan().status, "organizer_pick");
    assert.match(last(GROUP), /Maya, reply here with a number/);
    assert.ok(!/can't\)/.test(last(GROUP)), last(GROUP));

    await post(SAM, "1");
    assert.equal(plan().status, "organizer_pick", "only the organizer can pick");
    await post(MAYA, "1");
    assert.equal(plan().status, "locked");
    assert.ok(coordinator);
  } finally {
    console.error = logged;
  }
});

test("reminders go to people who haven't answered, then the deadline moves on without them", async () => {
  const { post, dm, plan, coordinator, to, last, advance } = setup();
  await post(MAYA, REQUEST);
  await dm(MAYA, "saturday");
  await dm(SAM, "saturday");
  const before = to(THEO).length;

  advance(13 * HOUR);
  await coordinator.tick();
  assert.equal(to(THEO).length, before + 1);
  assert.match(last(THEO), /what times work for hangout/);
  assert.equal(to(SAM).filter((m) => /what times work for hangout/.test(m)).length, 0);

  advance(12 * HOUR); // past the 24h deadline
  await coordinator.tick();
  assert.equal(plan().status, "organizer_pick");
  assert.match(last(MAYA), /2 of 3 answered, no reply from Theo/);
});

test("late answers are turned away, and an organizer who never picks frees the channel", async () => {
  const { post, dm, plan, coordinator, last, advance } = setup({ people: [MAYA, SAM] });
  await post(MAYA, REQUEST);
  await dm(MAYA, "saturday");
  advance(25 * HOUR);
  await coordinator.tick();
  assert.equal(plan().status, "organizer_pick");

  await dm(SAM, "saturday");
  assert.match(last(SAM), /have closed/);

  await dm(MAYA, "maybe later");
  assert.match(last(MAYA), /reply with a number from 1 to/);
  await dm(MAYA, "9");
  assert.equal(plan().status, "organizer_pick");
  assert.match(last(MAYA), /reply with a number from 1 to/);

  advance(25 * HOUR);
  await coordinator.tick();
  assert.equal(plan().status, "failed");
  assert.match(last(GROUP), /Maya didn't pick a time/);

  await post(MAYA, REQUEST);
  assert.equal(plan().status, "collecting", "the channel can plan again");
});

const CH2 = "discord:channel:2";

test("someone in two open plans is asked which one, and naming it works", async () => {
  const { post, dm, answer, last } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner hangout next weekend");
  await post(MAYA, "@planner dinner next weekend", CH2);

  await dm(SAM, "saturday");
  assert.match(last(SAM), /Which did you mean\?.*\n1\. hangout .*\n2\. dinner /);
  assert.equal(answer(GROUP, SAM), null);
  assert.equal(answer(CH2, SAM), null);

  await dm(SAM, "dinner: saturday");
  assert.match(last(SAM), /Got it for dinner/);
  assert.equal(answer(GROUP, SAM), null);
});

test("answering 'which one?' by number keeps what they said", async () => {
  const { post, dm, answer, last } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner hangout next weekend");
  await post(MAYA, "@planner dinner next weekend", CH2);

  await dm(SAM, "saturday");
  await dm(SAM, "7");
  assert.match(last(SAM), /Which did you mean/, "an out-of-range number asks again");
  await dm(SAM, "2");
  assert.match(last(SAM), /Got it for dinner: Sat/);
  assert.equal(answer(GROUP, SAM), null);
  assert.equal(answer(CH2, SAM)?.length, 1);
});

test("two plans with the same name can be told apart", async () => {
  const { postIn, dm, answer, last } = setup({ people: [MAYA, SAM] });
  await postIn(MAYA, "@planner dinner next weekend", GROUP, "#friends");
  await postIn(THEO, "@planner dinner next weekend", CH2, "#work");

  await dm(SAM, "dinner: saturday");
  const question = last(SAM);
  assert.match(question, /1\. dinner in #friends \(organized by Maya, /);
  assert.match(question, /2\. dinner in #work \(organized by /);
  assert.equal(answer(GROUP, SAM), null);

  await dm(SAM, "2");
  assert.match(last(SAM), /Got it for dinner in #work: Sat/);
  assert.equal(answer(GROUP, SAM), null);
  assert.equal(answer(CH2, SAM)?.length, 1);
});

test("a longer plan name doesn't also count as the shorter one", async () => {
  const { post, dm, planIn, answer, last } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner dinner next weekend");
  await post(MAYA, "@planner dinner next weekend", CH2);
  planIn(CH2).request.activity = "dinner party"; // the offline parser only reads one word

  await dm(SAM, "dinner party: saturday");
  assert.match(last(SAM), /Got it for dinner party/);
  assert.equal(answer(GROUP, SAM), null);
});

test("a reply naming a closed plan isn't saved to the plan still open", async () => {
  const { post, dm, plan, planIn, answer, last, advance, coordinator } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner dinner next weekend");
  await dm(MAYA, "saturday");
  advance(25 * HOUR);
  await coordinator.tick();
  assert.equal(plan().status, "organizer_pick");
  await post(MAYA, "@planner hangout next weekend", CH2);

  await dm(SAM, "dinner: saturday");
  assert.match(last(SAM), /answers for dinner have closed.*If this was for hangout, say so by name/);
  assert.equal(answer(CH2, SAM), null);

  await dm(SAM, "hangout: saturday");
  assert.match(last(SAM), /Got it for hangout/);
  assert.equal(planIn(GROUP).status, "organizer_pick");
});

test("a reply naming a finished plan is told so", async () => {
  const { post, dm, plan, answer, last } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner dinner next weekend");
  await dm(MAYA, "saturday");
  await dm(SAM, "saturday");
  await dm(MAYA, "1");
  assert.equal(plan().status, "locked");
  await post(MAYA, "@planner hangout next weekend", CH2);

  await dm(SAM, "dinner: sunday instead");
  assert.match(last(SAM), /dinner is already finished.*If this was for hangout/);
  assert.equal(answer(CH2, SAM), null);
});

/** Maya is choosing a time for dinner in channel 1, and Sam has invited her to a hangout in channel 2. */
async function pickingAndInvited() {
  const context = setup({ people: [MAYA, SAM] });
  await context.post(MAYA, "@planner dinner next weekend");
  await context.dm(MAYA, "saturday");
  await context.dm(SAM, "saturday");
  assert.equal(context.planIn(GROUP).status, "organizer_pick");
  await context.post(SAM, "@planner hangout next weekend", CH2);
  return context;
}

test("a number that could be a pick or a time asks first, and locks nothing", async () => {
  const { dm, planIn, last } = await pickingAndInvited();
  await dm(MAYA, "1");
  assert.equal(planIn(GROUP).status, "organizer_pick");
  assert.match(last(MAYA), /1\. Pick Sat, Nov 7.* for dinner \(organized by you, /);
  assert.match(last(MAYA), /2\. Use "1" as your answer for hangout \(organized by Sam, /);

  await dm(MAYA, "2");
  assert.equal(planIn(GROUP).status, "organizer_pick", "chose to answer the hangout instead");
});

test("choosing the pick from that question locks it in", async () => {
  const { dm, planIn } = await pickingAndInvited();
  await dm(MAYA, "1");
  await dm(MAYA, "1");
  assert.equal(planIn(GROUP).status, "locked");
});

test("words still go to the plan collecting answers while the organizer is choosing elsewhere", async () => {
  const { dm, planIn, answer, last } = await pickingAndInvited();
  await dm(MAYA, "sunday");
  assert.match(last(MAYA), /Got it for hangout: Sun/);
  assert.equal(planIn(GROUP).status, "organizer_pick");
  assert.equal(answer(CH2, MAYA)?.length, 1);
});

test("an organizer choosing for two plans is asked which, and neither is skipped", async () => {
  const { post, dm, planIn, last } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner dinner next weekend");
  await dm(MAYA, "saturday");
  await dm(SAM, "saturday");
  await post(MAYA, "@planner hangout next weekend", CH2);
  await dm(MAYA, "hangout: saturday");
  await dm(SAM, "hangout: saturday");
  assert.equal(planIn(CH2).status, "organizer_pick");

  await dm(MAYA, "1");
  assert.match(last(MAYA), /1\. Pick .* for dinner.*\n2\. Pick .* for hangout/);
  await dm(MAYA, "1");
  assert.equal(planIn(GROUP).status, "locked");
  assert.equal(planIn(CH2).status, "organizer_pick");

  await dm(MAYA, "hangout 1");
  assert.equal(planIn(CH2).status, "locked");
});

test("a stale choice can't lock in a plan that has moved on", async () => {
  const { post, dm, planIn, last, advance, coordinator } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner dinner next weekend");
  await dm(MAYA, "saturday");
  await dm(SAM, "saturday");
  advance(23 * HOUR);
  await post(SAM, "@planner hangout next weekend", CH2);
  await dm(MAYA, "1"); // asks: pick dinner, or answer the hangout?

  advance(2 * HOUR); // the pick deadline passes, while the question can still be answered
  await coordinator.tick();
  assert.equal(planIn(GROUP).status, "failed");
  await dm(MAYA, "1");
  assert.equal(planIn(GROUP).status, "failed");
  assert.match(last(MAYA), /dinner is already finished/);
});

test("an old 'which one?' question expires", async () => {
  const { post, dm, answer, last, advance } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner hangout next weekend");
  await post(MAYA, "@planner dinner next weekend", CH2);
  await dm(SAM, "saturday");
  advance(25 * HOUR);
  await dm(SAM, "2");
  assert.match(last(SAM), /Which did you mean/);
  assert.equal(answer(CH2, SAM), null);
});

test("a word reply goes to the only plan they haven't answered, and says how to correct it", async () => {
  const { post, dm, answer, last } = setup({ people: [MAYA, SAM, THEO] });
  await post(MAYA, "@planner dinner next weekend");
  await dm(SAM, "saturday"); // the only plan so far
  await post(MAYA, "@planner hangout next weekend", CH2);

  await dm(SAM, "sunday");
  assert.match(last(SAM), /Got it for hangout: Sun.*If you meant dinner, say so by name, like "dinner: Saturday after 6"/);
  assert.equal(answer(CH2, SAM)?.length, 1);

  await dm(SAM, "saturday");
  assert.match(last(SAM), /Which did you mean/, "both answered now, so it could be a change to either");
});

test("replying to the bot's invite goes to that plan, with no question", async () => {
  const { post, dm, answer, last, handleOf } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner hangout next weekend");
  await post(MAYA, "@planner dinner next weekend", CH2);

  await dm(SAM, "saturday", handleOf(SAM, /planning hangout/));
  assert.match(last(SAM), /Got it for hangout: Sat/);
  assert.equal(answer(CH2, SAM), null);

  await dm(SAM, "sunday", handleOf(SAM, /Got it for hangout/));
  assert.match(last(SAM), /Got it for hangout: Sun/, "replying to a confirmation works too");
});

test("replying to the options picks for that plan, and a number there is never a time", async () => {
  const { dm, planIn, handleOf, last } = await pickingAndInvited();
  const options = handleOf(MAYA, /Here's what looks best/);
  await dm(MAYA, "saturday please", options);
  assert.match(last(MAYA), /For dinner, reply with a number/);
  await dm(MAYA, "1", options);
  assert.equal(planIn(GROUP).status, "locked");
});

test("a number replied to an invite is an answer, even while choosing elsewhere", async () => {
  const { dm, planIn, handleOf, last } = await pickingAndInvited();
  await dm(MAYA, "1", handleOf(MAYA, /planning hangout/));
  assert.equal(planIn(GROUP).status, "organizer_pick");
  assert.match(last(MAYA), /couldn't work out times for hangout/);
});

test("replying to a message about a finished plan doesn't touch other plans", async () => {
  const { post, dm, plan, answer, last, handleOf } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner dinner next weekend");
  const invite = handleOf(SAM, /planning dinner/);
  await dm(MAYA, "saturday");
  await dm(SAM, "saturday");
  await dm(MAYA, "1");
  assert.equal(plan().status, "locked");
  await post(MAYA, "@planner hangout next weekend", CH2);

  await dm(SAM, "actually sunday", invite);
  assert.match(last(SAM), /dinner is already finished/);
  assert.equal(answer(CH2, SAM), null);
});

test("a reply to a message the bot doesn't recognize falls back to the usual rules", async () => {
  const { post, dm, last } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner hangout next weekend");
  await dm(SAM, "saturday", "unknown-message");
  assert.match(last(SAM), /Got it for hangout: Sat/);
});

test("the invite says which channel the plan is in", async () => {
  const { postIn, last } = setup({ people: [MAYA, SAM] });
  await postIn(MAYA, "@planner dinner next weekend", GROUP, "#friends");
  assert.match(last(SAM), /Maya is planning dinner in #friends/);
});

test("a channel over the DM cap is refused, with no plan and no DMs", async () => {
  const people = Array.from({ length: MAX_DM_MEMBERS + 1 }, (_, i) => `discord:user:${i}`);
  const { post, repo, messenger, last } = setup({ people });
  await post(people[0], REQUEST);
  assert.equal(repo.plans.size, 0);
  assert.match(last(GROUP), /16 people.*up to 15/);
  assert.equal(messenger.outbox.filter((m) => m.kind === "direct").length, 0);
});

test("a DM with no plan going gets the usual pointer", async () => {
  const { dm, last } = setup();
  await dm(SAM, "hello?");
  assert.match(last(SAM), /I plan things for group chats/);
});

test("networks without the capability keep voting in the group", async () => {
  const repo = new MemoryRepo();
  const messenger = new ConsoleMessenger();
  const coordinator = new Coordinator({
    repo,
    messenger,
    brain: new TemplateBrain(),
    now: () => new Date("2026-10-28T17:00:00Z"),
    timezone: TZ,
    calendarsEnabled: false,
    capabilities: () => ({ reactions: true, collectByDm: false }),
  });
  await coordinator.handleInbound({
    messageHandle: "m",
    from: MAYA,
    botAddress: null,
    groupId: GROUP,
    participants: [MAYA, SAM],
    text: REQUEST,
    replyToHandle: null,
    reaction: null,
    isOutbound: false,
  });
  assert.equal([...repo.plans.values()][0].status, "proposed");
  assert.equal(messenger.outbox.filter((m) => m.kind === "direct").length, 0);
});

// ── Pure pieces ──────────────────────────────────────────────────────────

const dmPlan = (activity: string, status: Plan["status"] = "collecting", extra: Partial<DmPlan> = {}): DmPlan => ({
  plan: { id: activity, status, createdAt: "2026-10-28", request: { activity } } as unknown as Plan,
  isOrganizer: false,
  answered: false,
  optionCount: 0,
  ...extra,
});

test("numbers are read only when that's all the message says", () => {
  for (const [text, number] of [["2", 2], [" 2. ", 2], ["#2", 2], ["option 2", 2], ["2)", 2], [": 2", 2]] as const) {
    assert.equal(readNumber(text), number, text);
  }
  for (const text of ["2 pm", "2pm", "after 2", "the 2nd", "", "saturday"]) assert.equal(readNumber(text), null, text);
});

test("plan names match whole words, ignoring case", () => {
  const names = (text: string, plans: DmPlan[]) => findNamed(text, plans).named.map((p) => p.plan.request.activity);
  assert.deepEqual(names("Brunch on saturday", [dmPlan("run")]), []);
  assert.deepEqual(names("the RUN, saturday", [dmPlan("run")]), ["run"]);
  assert.deepEqual(names("c++ night saturday", [dmPlan("c++ night")]), ["c++ night"], "symbols in names are literal");
  assert.deepEqual(names("dinner party and dinner", [dmPlan("dinner"), dmPlan("dinner party")]), ["dinner", "dinner party"]);
});

test("routing with nothing to go on", () => {
  assert.deepEqual(routeDirect("hello", []), { kind: "none" });
  assert.deepEqual(routeDirect("hello", [dmPlan("dinner", "locked")]), { kind: "none" });
  assert.deepEqual(routeDirect("3", [dmPlan("dinner", "locked")]), { kind: "none" });
});

test("a pick out of range is corrected, not treated as a pick", () => {
  const route = routeDirect("9", [dmPlan("dinner", "organizer_pick", { isOrganizer: true, optionCount: 3 })]);
  assert.equal(route.kind, "pick_invalid");
});

test("only the organizer's plan counts as theirs to pick", () => {
  const route = routeDirect("1", [dmPlan("dinner", "organizer_pick", { optionCount: 0 })]);
  assert.equal(route.kind, "closed");
});

const window = { start: "2026-11-07T08:00:00.000Z", end: "2026-11-09T08:00:00.000Z" }; // Sat + Sun PST
const ctx = { now: new Date("2026-10-28T17:00:00Z"), timezone: TZ, activity: "dinner", window };

test("windows clip to the plan and merge", () => {
  assert.deepEqual(
    clipWindows(
      [
        { start: "2026-11-07T20:00:00.000Z", end: "2026-11-07T22:00:00.000Z" },
        { start: "2026-11-01T00:00:00.000Z", end: "2026-11-02T00:00:00.000Z" },
        { start: "2026-11-07T21:00:00.000Z", end: "2026-11-07T23:00:00.000Z" },
      ],
      window,
    ),
    [{ start: "2026-11-07T20:00:00.000Z", end: "2026-11-07T23:00:00.000Z" }],
  );
});

test("free times invert into busy times", () => {
  assert.deepEqual(invertWindows([], window), [window]);
  assert.deepEqual(invertWindows([window], window), []);
  assert.deepEqual(invertWindows([{ start: "2026-11-08T08:00:00.000Z", end: window.end }], window), [
    { start: window.start, end: "2026-11-08T08:00:00.000Z" },
  ]);
});

test("saved answers are described so people can check them", () => {
  const label = (start: string, end: string) => describeWindow({ start, end }, window, TZ);
  assert.equal(label(window.start, window.end), "any time");
  assert.equal(label(window.start, "2026-11-08T08:00:00.000Z"), "Sat, Nov 7 (all day)");
  assert.match(label("2026-11-08T02:00:00.000Z", "2026-11-08T08:00:00.000Z"), /^Sat, Nov 7, 6:00.*12:00 AM$/);
  assert.match(label("2026-11-08T02:00:00.000Z", "2026-11-09T02:00:00.000Z"), /^Sat, Nov 7.* to Sun, Nov 8/);
});

test("answers are due within 24 hours, but never under 30 minutes", () => {
  const now = new Date("2026-10-28T17:00:00Z");
  const due = (hoursToWindowEnd: number) =>
    (collectionDeadline(now, new Date(now.getTime() + hoursToWindowEnd * HOUR)).getTime() - now.getTime()) / HOUR;
  assert.equal(due(240), 24);
  assert.equal(due(6), 3);
  assert.equal(due(0.25), 0.5);
});

test("rules read simple replies and refuse to guess at mixed ones", () => {
  const read = (t: string) => parseAvailabilityWithRules(t, ctx);
  assert.deepEqual(read("anytime"), { kind: "windows", windows: [window] });
  assert.deepEqual(read("none"), { kind: "none" });
  assert.deepEqual(read("I can't make it"), { kind: "none" });
  assert.deepEqual(read("saturday after 6"), {
    kind: "windows",
    windows: [{ start: "2026-11-08T02:00:00.000Z", end: "2026-11-08T08:00:00.000Z" }],
  });
  assert.equal(read("Saturday after 6, not Sunday").kind, "unclear");
  assert.equal(read("what's this for?").kind, "unclear");
});

test("rules treat a day someone rules out as everything but that day", () => {
  for (const reply of ["not sunday", "can't do sunday"]) {
    const reading = parseAvailabilityWithRules(reply, ctx);
    assert.equal(reading.kind, "windows", reply);
    if (reading.kind === "windows") {
      assert.deepEqual(reading.windows, [{ start: window.start, end: "2026-11-08T08:00:00.000Z" }], reply);
    }
  }
});

function claudeReturning(output: unknown, behavior: { fail?: boolean } = {}) {
  const calls: any[] = [];
  const client = {
    beta: {
      messages: {
        parse: async (params: unknown) => {
          calls.push(params);
          if (behavior.fail) throw new Error("network down");
          return { stop_reason: "end_turn", parsed_output: output };
        },
      },
    },
  };
  return { brain: new ClaudeBrain(client as unknown as Anthropic), calls };
}

test("Claude's reading maps to times in the plan, in the plan's timezone", async () => {
  const { brain, calls } = claudeReturning({
    kind: "available",
    windows: [
      { start_local: "2026-11-07T18:00", end_local: "2026-11-07T24:00" },
      { start_local: "2026-11-20T18:00", end_local: "2026-11-20T20:00" }, // outside the plan
    ],
  });
  assert.deepEqual(await brain.parseAvailability("Saturday after 6, not Sunday", ctx), {
    kind: "windows",
    windows: [{ start: "2026-11-08T02:00:00.000Z", end: "2026-11-08T08:00:00.000Z" }],
  });
  assert.match(calls[0].messages[0].content, /Event: dinner/);
  assert.match(calls[0].messages[0].content, /Reply: Saturday after 6, not Sunday/);
});

test("Claude's other answers map too, and a failed call falls back to rules", async () => {
  assert.deepEqual(await claudeReturning({ kind: "nothing_works", windows: [] }).brain.parseAvailability("nope", ctx), { kind: "none" });
  assert.deepEqual(await claudeReturning({ kind: "unclear", windows: [] }).brain.parseAvailability("huh", ctx), { kind: "unclear" });
  const logged = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await claudeReturning(null, { fail: true }).brain.parseAvailability("anytime", ctx), {
      kind: "windows",
      windows: [window],
    });
  } finally {
    console.error = logged;
  }
});
