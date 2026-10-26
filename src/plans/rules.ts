import type { CandidateSlot, PlanMember, Response, Vote } from "../types.ts";

// Pure decision rules for the plan state machine. No I/O, so every policy in
// the product spec is unit-testable in isolation.
//
//   collecting ──▶ proposed (round 1) ──▶ round 2 ──▶ round 3 ──▶ organizer_pick
//                       │                    │           │              │
//                       └──────────────▶ locked ◀────────┴──────────────┘
//   (no viable slots at all ──▶ failed)

export const MAX_ROUNDS = 3;
export const MAX_REMINDERS = 2;
/** Reminders go out at these fractions of the way from round start to deadline. */
export const REMINDER_AT = [0.5, 0.85];
/** How long to wait for calendar connections before proposing anyway. */
export const COLLECTING_GRACE_MS = 10 * 60_000;
export const MAYBE_WEIGHT = 0.5;

const HOUR = 3_600_000;

/**
 * How many options to send.
 * - 1 when confident: most calendars connected and a clear best slot.
 * - 2-3 when uncertain: many unknown calendars, or the top slots are close.
 * - At least 2 after a round got a "no", since we now know it's tricky.
 */
export function decideOptionCount(input: {
  round: number;
  memberCount: number;
  unknownCount: number;
  topScores: number[];
}): number {
  const unknownShare = input.memberCount === 0 ? 1 : input.unknownCount / input.memberCount;
  let count = 1;
  if (unknownShare > 0.5) count = 3;
  else if (unknownShare > 0.25) count = 2;

  const [first, second] = input.topScores;
  if (count === 1 && second !== undefined && first - second < 0.05) count = 2;
  if (input.round > 1) count = Math.max(count, 2);
  return Math.min(count, Math.max(input.topScores.length, 1));
}

/** Default response deadline: 24h, or halfway to the earliest proposed slot, whichever is sooner. */
export function computeDeadline(now: Date, earliestSlotStart: Date, overrideHours?: number): Date {
  if (overrideHours) return new Date(now.getTime() + overrideHours * HOUR);
  const halfway = now.getTime() + (earliestSlotStart.getTime() - now.getTime()) / 2;
  return new Date(Math.min(now.getTime() + 24 * HOUR, halfway));
}

/** Index of the reminder due now (0 or 1), or null. */
export function reminderDue(
  member: Pick<PlanMember, "remindersSent">,
  roundStartedAt: Date,
  deadline: Date,
  now: Date,
): number | null {
  if (member.remindersSent >= MAX_REMINDERS) return null;
  const span = deadline.getTime() - roundStartedAt.getTime();
  const dueAt = roundStartedAt.getTime() + span * REMINDER_AT[member.remindersSent];
  return now.getTime() >= dueAt && now < deadline ? member.remindersSent : null;
}

export interface SlotTally {
  slot: CandidateSlot;
  yes: number;
  no: number;
  maybe: number;
  /** yes + 0.5 × maybe: the ranking score. */
  score: number;
  essentialNo: boolean;
}

export function tally(
  slots: CandidateSlot[],
  responses: Response[],
  members: PlanMember[],
): SlotTally[] {
  const roles = new Map(members.map((m) => [m.userId, m.role]));
  return slots.map((slot) => {
    const votes = responses.filter((r) => r.slotId === slot.id);
    const count = (v: Vote) => votes.filter((r) => r.vote === v).length;
    const yes = count("yes");
    const maybe = count("maybe");
    return {
      slot,
      yes,
      no: count("no"),
      maybe,
      score: yes + MAYBE_WEIGHT * maybe,
      essentialNo: votes.some((r) => r.vote === "no" && (roles.get(r.userId) ?? "essential") === "essential"),
    };
  });
}

/** Best first: yes + ½ maybe, earliest on ties. */
const byScore = (a: SlotTally, b: SlotTally) =>
  b.score - a.score || Date.parse(a.slot.start) - Date.parse(b.slot.start);

/** A slot no essential member said no to, with at least one yes/maybe. */
const isViable = (t: SlotTally) => !t.essentialNo && t.yes + t.maybe > 0;

/** The option that would win if the round closed now, or null if none is viable. */
export function leadingSlot(slots: CandidateSlot[], responses: Response[], members: PlanMember[]): CandidateSlot | null {
  return tally(slots, responses, members).filter(isViable).sort(byScore)[0]?.slot ?? null;
}

export type RoundOutcome =
  | { type: "wait" }
  | { type: "lock"; slotId: string }
  | { type: "next_round" }
  | { type: "organizer_pick" };

/**
 * Decides what happens after a vote or a deadline.
 *
 * Quorum defaults to everyone. Before the deadline there are two shortcuts:
 * a slot every active essential member said yes or maybe to locks
 * immediately; if every slot already has an essential "no", the round moves
 * on. Otherwise we wait for the deadline.
 *
 * An option someone skipped is "no response" from them, not a "no". A slot
 * is viable when no essential member said no and it has at least one
 * yes/maybe. The best viable slot (yes + ½ maybe, earliest on ties) wins.
 */
export function evaluateRound(input: {
  round: number;
  slots: CandidateSlot[];
  responses: Response[];
  members: PlanMember[];
  deadlinePassed: boolean;
}): RoundOutcome {
  const { slots, responses, members } = input;
  if (slots.length === 0) return { type: input.round < MAX_ROUNDS ? "next_round" : "organizer_pick" };

  const active = members.filter((m) => !m.timedOut);
  const essential = active.filter((m) => m.role === "essential");
  // If everyone left is optional, they all count.
  const quorum = essential.length ? essential : active;
  const voteOf = (userId: string, slotId: string) =>
    responses.find((r) => r.userId === userId && r.slotId === slotId)?.vote;

  const tallies = tally(slots, responses, members);

  const canMake = (userId: string, slotId: string) => {
    const v = voteOf(userId, slotId);
    return v === "yes" || v === "maybe";
  };
  const agreed = tallies
    .filter((t) => quorum.length > 0 && quorum.every((m) => canMake(m.userId, t.slot.id)))
    .sort(byScore);
  if (agreed.length) return { type: "lock", slotId: agreed[0].slot.id };

  const allBlocked = tallies.every((t) => t.essentialNo);
  if (!input.deadlinePassed && !allBlocked) return { type: "wait" };

  const viable = tallies.filter(isViable).sort(byScore);
  if (viable.length) return { type: "lock", slotId: viable[0].slot.id };
  return { type: input.round < MAX_ROUNDS ? "next_round" : "organizer_pick" };
}

/** Best partial options across all rounds, for the organizer to choose from. */
export function bestPartialOptions(
  slots: CandidateSlot[],
  responses: Response[],
  members: PlanMember[],
  limit = 3,
): SlotTally[] {
  return tally(slots, responses, members)
    .sort((a, b) => b.score - a.score || a.no - b.no || Date.parse(a.slot.start) - Date.parse(b.slot.start))
    .slice(0, limit);
}
