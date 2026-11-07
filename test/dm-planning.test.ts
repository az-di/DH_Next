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
    dm: (from: string, text: string) => coordinator.handleInbound(inbound(from, text, null)),
    plan: () => [...repo.plans.values()].at(-1)!,
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

test("someone in two open plans is asked which one, and naming it works", async () => {
  const { post, dm, repo, last } = setup({ people: [MAYA, SAM] });
  await post(MAYA, "@planner hangout next weekend");
  await post(MAYA, "@planner dinner next weekend", "discord:channel:2");

  await dm(SAM, "saturday");
  assert.match(last(SAM), /in a few plans.*hangout and dinner/);
  assert.equal(repo.members.find((m) => m.statedAvailability !== null), undefined);

  await dm(SAM, "dinner: saturday");
  assert.match(last(SAM), /Got it for dinner/);
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
