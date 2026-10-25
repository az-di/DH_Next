import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { MemoryRepo } from "../src/db/memory.ts";
import { TemplateBrain } from "../src/llm/index.ts";
import { MockChat, MockMessenger } from "../src/messaging/mock.ts";
import { ConsoleMessenger } from "../src/messaging/sendblue.ts";
import { busyBlocks, MOCK_BOT, MOCK_GROUP_ID, MOCK_USERS } from "../src/mock/fixtures.ts";
import { createMockDemo } from "../src/mock/index.ts";
import { Coordinator } from "../src/plans/coordinator.ts";
import { createServer } from "../src/server.ts";

const TZ = "America/Los_Angeles";
const [MAYA, JORDAN, PRIYA, SAM, THEO] = MOCK_USERS.map((u) => u.phone);

test("mock messenger delivers group messages and DMs to the mock chat", async () => {
  const chat = new MockChat(MOCK_BOT, () => new Date("2026-10-28T17:00:00Z"));
  let changes = 0;
  chat.onChange(() => changes++);
  const messenger = new MockMessenger(chat);

  const group = await messenger.sendGroup(MOCK_GROUP_ID, "Option 1: Sat");
  const dm = await messenger.sendDirect(MAYA, "reminder");
  assert.equal(group.groupId, MOCK_GROUP_ID);
  assert.equal(dm.groupId, null);
  assert.notEqual(group.messageHandle, dm.messageHandle);
  assert.deepEqual(
    chat.messages.map((m) => [m.from, m.text, m.sentAt]),
    [[MOCK_BOT, "Option 1: Sat", "2026-10-28T17:00:00.000Z"]],
  );
  assert.deepEqual(chat.directs.map((d) => [d.to, d.text]), [[MAYA, "reminder"]]);

  assert.ok(chat.react(group.messageHandle!, JORDAN, "👍"));
  assert.ok(!chat.react("missing", JORDAN, "👍"));
  assert.deepEqual(chat.messages[0].reactions, { [JORDAN]: "👍" });
  assert.equal(changes, 3);
});

test("seeded free/busy expands weekly patterns in local time", () => {
  const maya = MOCK_USERS[0].busy;
  // Sat Oct 31 – Mon Nov 2 2026 (PDT → PST on Sunday).
  const blocks = busyBlocks(maya, new Date("2026-10-31T07:00:00Z"), new Date("2026-11-03T08:00:00Z"), TZ);
  assert.deepEqual(
    blocks.map((b) => [b.start.toISOString(), b.end.toISOString()]),
    [
      ["2026-10-31T17:00:00.000Z", "2026-10-31T20:00:00.000Z"], // Sat 10–1 PDT
      ["2026-11-02T01:00:00.000Z", "2026-11-02T03:00:00.000Z"], // Sun 5–7 PST
      ["2026-11-02T17:00:00.000Z", "2026-11-03T01:30:00.000Z"], // Mon 9–5:30 PST
    ],
  );
  // Only blocks overlapping the window come back.
  assert.deepEqual(busyBlocks(maya, new Date("2026-10-31T21:00:00Z"), new Date("2026-10-31T23:00:00Z"), TZ), []);
});

async function startMock() {
  const demo = await createMockDemo(MOCK_USERS, TZ);
  const { clock, chat, repo } = demo.server;
  clock.advance(Date.parse("2026-10-28T17:00:00Z") - Date.now()); // Wed 10:00 PDT
  const coordinator = new Coordinator({
    repo,
    messenger: demo.messenger,
    brain: new TemplateBrain(),
    timezone: TZ,
    ...demo.coordinatorDeps,
  });
  const server = createServer({ repo, coordinator, mock: demo.server }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { demo, clock, chat, repo, base, post, close };
}

/** The webhook acknowledges first and processes in the background, so poll. */
async function until(check: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("mock chat runs a full plan through the real webhook path", async (t) => {
  const { chat, repo, clock, base, post, close } = await startMock();
  t.after(close);

  const page = await fetch(`${base}/mock`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Mock Group Chat<\/title>/);

  assert.equal((await post("/mock/api/send", { from: MAYA, text: "@planner dinner next weekend" })).status, 200);
  const options = () => chat.messages.filter((m) => m.text.startsWith("Option "));
  await until(() => options().length === 2, "option bubbles");
  // Priya is busy Saturday until 7:30 and Maya Sunday until 7, so the seeded calendars pick these.
  assert.deepEqual(
    options().map((m) => m.text),
    ["Option 1: Sat, Nov 7, 7:30–9:30 PM", "Option 2: Sun, Nov 8, 7:00–9:00 PM"],
  );
  const [opt1, opt2] = options();

  // Tapback 👍 on option 1, swipe-reply "no" to option 2. Theo stays silent.
  for (const from of [MAYA, JORDAN, PRIYA, SAM]) {
    assert.equal((await post("/mock/api/react", { from, target: opt1.handle, emoji: "👍" })).status, 200);
    assert.equal((await post("/mock/api/send", { from, text: "no", replyTo: opt2.handle })).status, 200);
  }
  await until(async () => (await repo.listResponses([...repo.plans.keys()][0])).length === 8, "8 votes");
  assert.deepEqual(chat.messages.at(-1)!.replyTo, opt2.handle);
  assert.deepEqual(Object.values(opt1.reactions), ["👍", "👍", "👍", "👍"]);

  // 12h in: halfway to the deadline, so only Theo gets a reminder.
  const ff = await post("/mock/api/fast-forward", { hours: 12 });
  assert.equal(ff.body.plan.status, "proposed");
  assert.deepEqual(chat.directs.map((d) => d.to), [THEO]);
  assert.match(chat.directs[0].text, /reminder/);
  assert.ok(Math.abs(Date.parse(ff.body.now) - Date.parse("2026-10-29T05:00:00Z")) < 5000);

  // Deadline: decide without Theo and tell him directly.
  const done = await post("/mock/api/fast-forward", { to: "deadline" });
  assert.equal(done.body.plan.status, "locked");
  assert.equal(done.body.plan.lockedLabel, "Sat, Nov 7, 7:30–9:30 PM");
  assert.match(chat.messages.at(-1)!.text, /Locked in: dinner, Sat, Nov 7, 7:30–9:30 PM\. Didn't hear from Theo\./);
  assert.equal(chat.directs.at(-1)!.to, THEO);
  assert.equal((await post("/mock/api/fast-forward", { to: "deadline" })).status, 409, "nothing left to wait for");

  const reset = await post("/mock/api/reset");
  assert.equal(reset.body.plan, null);
  assert.deepEqual([reset.body.messages, reset.body.directs], [[], []]);
  assert.equal([...repo.plans.values()].filter((p) => p.groupId === MOCK_GROUP_ID).length, 0);
  assert.deepEqual([repo.members, repo.slots, repo.responses, [...repo.proposalMessages]], [[], [], [], []]);
  assert.ok(Math.abs(clock.now().getTime() - Date.now()) < 1000, "clock is back to real time");
  assert.equal(repo.users.size, MOCK_USERS.length, "fake users are kept");

  // A fresh plan works after reset (handles stay unique for the deduper).
  await post("/mock/api/send", { from: JORDAN, text: "@planner lunch tomorrow" });
  await until(() => chat.messages.some((m) => m.text.startsWith("Option ")), "a new proposal");
});

test("mock endpoints reject unknown senders and tapbacks", async (t) => {
  const { post, close } = await startMock();
  t.after(close);
  assert.equal((await post("/mock/api/send", { from: "+15559999999", text: "hi" })).status, 400);
  assert.equal((await post("/mock/api/send", { from: MAYA, text: "  " })).status, 400);
  assert.equal((await post("/mock/api/react", { from: MAYA, target: "nope", emoji: "👍" })).status, 400);
  assert.equal((await post("/mock/api/fast-forward", { hours: -1 })).status, 400);
});

test("/mock isn't served unless the mock provider is on", async (t) => {
  const repo = new MemoryRepo();
  const coordinator = new Coordinator({ repo, messenger: new ConsoleMessenger(), brain: new TemplateBrain() });
  const server = createServer({ repo, coordinator }).listen(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/mock`)).status, 404);
  assert.equal((await fetch(`${base}/mock/api/reset`, { method: "POST" })).status, 404);
});
