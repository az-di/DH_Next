import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDeadline,
  decideOptionCount,
  evaluateRound,
  reminderDue,
  tally,
} from "../src/plans/rules.ts";
import type { CandidateSlot, PlanMember, Response, Vote } from "../src/types.ts";

const H = 3_600_000;
const member = (userId: string, extra: Partial<PlanMember> = {}): PlanMember => ({
  planId: "p",
  userId,
  role: "essential",
  remindersSent: 0,
  lastRemindedAt: null,
  timedOut: false,
  ...extra,
});
const slot = (id: string, hour: number): CandidateSlot => ({
  id,
  planId: "p",
  round: 1,
  optionNumber: Number(id.slice(1)),
  start: new Date(Date.UTC(2026, 10, 7, hour)).toISOString(),
  end: new Date(Date.UTC(2026, 10, 7, hour + 2)).toISOString(),
  score: 1,
});
const vote = (userId: string, slotId: string, v: Vote): Response => ({
  id: `${userId}-${slotId}`,
  planId: "p",
  slotId,
  userId,
  vote: v,
  createdAt: "",
});

test("option count: 1 when confident, more when uncertain or after a no", () => {
  assert.equal(decideOptionCount({ round: 1, memberCount: 4, unknownCount: 0, topScores: [1, 0.8, 0.7] }), 1);
  assert.equal(decideOptionCount({ round: 1, memberCount: 4, unknownCount: 0, topScores: [1, 0.99, 0.7] }), 2);
  assert.equal(decideOptionCount({ round: 1, memberCount: 4, unknownCount: 2, topScores: [1, 0.8, 0.7] }), 2);
  assert.equal(decideOptionCount({ round: 1, memberCount: 4, unknownCount: 3, topScores: [1, 0.8, 0.7] }), 3);
  assert.equal(decideOptionCount({ round: 2, memberCount: 4, unknownCount: 0, topScores: [1, 0.8, 0.7] }), 2);
  assert.equal(decideOptionCount({ round: 2, memberCount: 4, unknownCount: 0, topScores: [1] }), 1);
});

test("deadline: 24h or halfway to the earliest slot, whichever is sooner", () => {
  const now = new Date(0);
  assert.equal(computeDeadline(now, new Date(10 * 24 * H)).getTime(), 24 * H);
  assert.equal(computeDeadline(now, new Date(6 * H)).getTime(), 3 * H);
  assert.equal(computeDeadline(now, new Date(6 * H), 2).getTime(), 2 * H);
});

test("reminders: at most two, at 50% and 85% of the window", () => {
  const start = new Date(0);
  const deadline = new Date(10 * H);
  assert.equal(reminderDue({ remindersSent: 0 }, start, deadline, new Date(4 * H)), null);
  assert.equal(reminderDue({ remindersSent: 0 }, start, deadline, new Date(5 * H)), 0);
  assert.equal(reminderDue({ remindersSent: 1 }, start, deadline, new Date(6 * H)), null);
  assert.equal(reminderDue({ remindersSent: 1 }, start, deadline, new Date(8.5 * H)), 1);
  assert.equal(reminderDue({ remindersSent: 2 }, start, deadline, new Date(9.9 * H)), null);
  assert.equal(reminderDue({ remindersSent: 0 }, start, deadline, new Date(11 * H)), null);
});

test("maybe counts as half a yes", () => {
  const [a, b] = tally(
    [slot("s1", 18), slot("s2", 20)],
    [vote("u1", "s1", "yes"), vote("u2", "s1", "maybe"), vote("u1", "s2", "maybe"), vote("u2", "s2", "maybe")],
    [member("u1"), member("u2")],
  );
  assert.equal(a.score, 1.5);
  assert.equal(b.score, 1);
});

const base = { round: 1, deadlinePassed: false };

test("unanimous yes locks immediately", () => {
  const out = evaluateRound({
    ...base,
    slots: [slot("s1", 18), slot("s2", 20)],
    responses: [vote("u1", "s2", "yes"), vote("u2", "s2", "yes")],
    members: [member("u1"), member("u2")],
  });
  assert.deepEqual(out, { type: "lock", slotId: "s2" });
});

test("waits for quorum (everyone) before deciding", () => {
  const out = evaluateRound({
    ...base,
    slots: [slot("s1", 18)],
    responses: [vote("u1", "s1", "yes")],
    members: [member("u1"), member("u2")],
  });
  assert.deepEqual(out, { type: "wait" });
});

test("after everyone answers, best viable slot wins; essential no blocks, optional no doesn't", () => {
  const slots = [slot("s1", 18), slot("s2", 20)];
  const members = [member("u1"), member("u2"), member("u3", { role: "optional" })];
  const out = evaluateRound({
    ...base,
    slots,
    members,
    responses: [
      vote("u1", "s1", "yes"), vote("u2", "s1", "no"), vote("u3", "s1", "yes"),
      vote("u1", "s2", "maybe"), vote("u2", "s2", "yes"), vote("u3", "s2", "no"),
    ],
  });
  assert.deepEqual(out, { type: "lock", slotId: "s2" });
});

test("a single essential no moves to the next round without waiting", () => {
  const out = evaluateRound({
    ...base,
    slots: [slot("s1", 18)],
    responses: [vote("u1", "s1", "no")],
    members: [member("u1"), member("u2"), member("u3")],
  });
  assert.deepEqual(out, { type: "next_round" });
});

test("round 3 with nothing viable goes to the organizer", () => {
  const out = evaluateRound({
    ...base,
    round: 3,
    slots: [slot("s1", 18)],
    responses: [vote("u1", "s1", "no")],
    members: [member("u1")],
  });
  assert.deepEqual(out, { type: "organizer_pick" });
});

test("deadline decides without timed-out members", () => {
  const out = evaluateRound({
    round: 1,
    deadlinePassed: true,
    slots: [slot("s1", 18)],
    responses: [vote("u1", "s1", "yes")],
    members: [member("u1"), member("u2", { timedOut: true })],
  });
  assert.deepEqual(out, { type: "lock", slotId: "s1" });
});
