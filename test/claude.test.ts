import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { MemoryRepo } from "../src/db/memory.ts";
import { ClaudeBrain } from "../src/llm/claude.ts";
import { parseInbound } from "../src/messaging/inbound.ts";
import { ConsoleMessenger } from "../src/messaging/sendblue.ts";
import { Coordinator } from "../src/plans/coordinator.ts";

const TZ = "America/Los_Angeles";
const now = new Date("2026-10-28T17:00:00Z"); // Wed 10:00 PDT
const opts = { now, timezone: TZ };
const ALL = [0, 1, 2, 3, 4, 5, 6];

/** A stand-in Anthropic client: structured parses return `output` (or refuse/throw); compose echoes the draft. */
function fakeClient(output: unknown = null, behavior: { refuse?: boolean; fail?: boolean } = {}) {
  const calls = { parse: [] as any[], create: 0 };
  const client = {
    beta: {
      messages: {
        parse: async (params: unknown) => {
          calls.parse.push(params);
          if (behavior.fail) throw new Error("network down");
          return { stop_reason: behavior.refuse ? "refusal" : "end_turn", parsed_output: behavior.refuse ? null : output };
        },
        create: async (params: any) => {
          calls.create++;
          const draft = String(params.messages[0].content).replace(/^Rewrite this draft:\n\n/, "");
          return { stop_reason: "end_turn", content: [{ type: "text", text: draft }] };
        },
      },
    },
  };
  return { brain: new ClaudeBrain(client as unknown as Anthropic), calls };
}

const empty = { request: null, roles: [], preference: null, constraint_windows: [] };

test("confident rules skip Claude entirely", async () => {
  const { brain, calls } = fakeClient();
  assert.equal((await brain.interpret("dinner next weekend", opts)).kind, "request");
  assert.equal((await brain.interpret("no mornings", opts)).kind, "preference");
  assert.equal((await brain.interpret("I can't do this Saturday", opts)).kind, "constraint");
  assert.equal((await brain.interpret("Sam is optional", opts)).kind, "roles");
  assert.equal(calls.parse.length, 0);
});

test("one Claude call when the rules aren't sure, mapped by kind", async () => {
  const cases: [string, unknown, unknown][] = [
    [
      "mornings are rough, weekend evenings are ideal",
      {
        ...empty,
        kind: "preference",
        preference: {
          preferred_times: ["evening"],
          preferred_days: ["saturday", "sunday"],
          never: [{ days: [], from_hour: 0, to_hour: 10 }, { days: ["friday"], from_hour: 21, to_hour: 30 }],
          clear_existing: false,
        },
      },
      {
        kind: "preference",
        update: {
          never: [{ days: ALL, from: 0, to: 10 }, { days: [5], from: 21, to: 24 }],
          preferredTimes: ["evening"],
          preferredDays: [0, 6],
        },
      },
    ],
    [
      "we don't need Sam but Priya has to come",
      { ...empty, kind: "role_change", roles: [{ names: ["Sam"], role: "optional" }, { names: ["Priya", " "], role: "required" }] },
      { kind: "roles", roles: [{ names: ["Sam"], role: "optional" }, { names: ["Priya"], role: "essential" }] },
    ],
    [
      "the 31st is no good for me",
      { ...empty, kind: "one_off_constraint", constraint_windows: [{ start_local: "2026-10-31T00:00", end_local: "2026-10-31T24:00" }] },
      { kind: "constraint", windows: [{ start: "2026-10-31T07:00:00.000Z", end: "2026-11-01T07:00:00.000Z" }] },
    ],
    ["hey there", { ...empty, kind: "other" }, { kind: "other" }],
  ];
  for (const [text, output, expected] of cases) {
    const { brain, calls } = fakeClient(output);
    assert.deepEqual(await brain.interpret(text, opts), expected, text);
    assert.equal(calls.parse.length, 1, text);
    assert.equal(calls.parse[0].model, "claude-opus-5-5");
    assert.equal(calls.parse[0].output_config.effort, "low");
  }
});

test("a request Claude reads, with role statements inline", async () => {
  const { brain } = fakeClient({
    ...empty,
    kind: "new_request",
    request: {
      activity: "dinner",
      window_start_local: "2026-11-15T00:00",
      window_end_local: "2026-11-22T00:00",
      duration_minutes: 120,
      preferred_start_hour: 17,
      preferred_end_hour: 22,
      time_requested: false,
    },
    roles: [{ names: ["Sam"], role: "optional" }],
  });
  const out = await brain.interpret("dinner after the 15th, we don't need Sam", opts);
  assert.equal(out.kind, "request");
  if (out.kind !== "request") return;
  assert.equal(out.request.activity, "dinner");
  assert.equal(out.request.windowStart, "2026-11-15T08:00:00.000Z");
  assert.deepEqual(out.roles, [{ names: ["Sam"], role: "optional" }]);
});

test("errors, refusals, and unusable answers fall back to the rules' reading", async () => {
  const text = "dinner after the 15th"; // rules read it as dinner in the next week, but aren't confident
  for (const { brain } of [
    fakeClient(null, { fail: true }),
    fakeClient(null, { refuse: true }),
    fakeClient({ ...empty, kind: "new_request" }), // no request fields
  ]) {
    const out = await brain.interpret(text, opts);
    assert.equal(out.kind, "request");
    assert.equal(out.kind === "request" && out.request.activity, "dinner");
  }
});

test('round-trips for "@planner dinner next weekend": no parse call, only the two composed messages', async () => {
  const { brain, calls } = fakeClient();
  const repo = new MemoryRepo();
  const messenger = new ConsoleMessenger();
  const coordinator = new Coordinator({ repo, messenger, brain, now: () => now, timezone: TZ, calendarsEnabled: false });
  await coordinator.handleInbound(
    parseInbound({
      content: "@planner dinner next weekend",
      from_number: "+15550000001",
      group_id: "g",
      participants: ["+15550000001", "+15550000002"],
      message_handle: "m1",
    }),
  );
  assert.equal([...repo.plans.values()][0].status, "proposed");
  assert.equal(calls.parse.length, 0, "rules understood the request");
  assert.equal(calls.create, 2, "the ack and the proposal intro are reworded; option bubbles never are");
});
