import { loadAvailability } from "../calendar/availability.ts";
import { connectUrl } from "../calendar/links.ts";
import { pickDistinct, scoreSlots } from "../calendar/slots.ts";
import { config, hasGoogle } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import { formatOption, type Brain, type BotMessage } from "../llm/index.ts";
import type { InboundMessage } from "../messaging/inbound.ts";
import { isMentioned, stripMention } from "../messaging/mentions.ts";
import type { Messenger } from "../messaging/sendblue.ts";
import { parseVotes, type ParsedVote } from "../messaging/votes.ts";
import { formatDeadline, formatSlot } from "../time.ts";
import type { CandidateSlot, MemberRole, Plan, PlanMember, User } from "../types.ts";
import { KeyedLock } from "./lock.ts";
import {
  bestPartialOptions,
  COLLECTING_GRACE_MS,
  computeDeadline,
  decideOptionCount,
  evaluateRound,
  reminderDue,
} from "./rules.ts";

export interface CoordinatorDeps {
  repo: Repo;
  messenger: Messenger;
  brain: Brain;
  now?: () => Date;
  timezone?: string;
  /** Whether calendars can be connected (Google configured). */
  calendarsEnabled?: boolean;
  /** Free/busy lookup. Defaults to connected calendars; the /mock demo swaps in seeded data. */
  loadAvailability?: typeof loadAvailability;
}

/**
 * The central coordinator. Each member's "agent" is their profile and
 * calendar on the server; this class negotiates for all of them, which is
 * more reliable, debuggable, and private than agent-to-agent chatter.
 */
export class Coordinator {
  private repo: Repo;
  private messenger: Messenger;
  private brain: Brain;
  private now: () => Date;
  private timezone: string;
  private calendarsEnabled: boolean;
  private loadAvailability: typeof loadAvailability;
  private lock = new KeyedLock();

  constructor(deps: CoordinatorDeps) {
    this.repo = deps.repo;
    this.messenger = deps.messenger;
    this.brain = deps.brain;
    this.now = deps.now ?? (() => new Date());
    this.timezone = deps.timezone ?? config.defaultTimezone;
    this.calendarsEnabled = deps.calendarsEnabled ?? hasGoogle();
    this.loadAvailability = deps.loadAvailability ?? loadAvailability;
  }

  // ───────────────────────────── inbound ─────────────────────────────

  async handleInbound(msg: InboundMessage): Promise<void> {
    if (msg.isOutbound || !msg.from) return;
    if (!msg.groupId) {
      // MVP plans live in group chats. A DM gets a pointer (and proves the line works).
      if (msg.text && !msg.reaction) await this.sayDirect(msg.from, { kind: "dm_help" });
      return;
    }
    const groupId = msg.groupId;
    await this.lock.run(groupId, async () => {
      const sender = await this.repo.upsertUserByPhone(msg.from);
      const open = await this.repo.getOpenPlanForGroup(groupId);

      if (!msg.reaction && isMentioned(msg.text)) {
        if (open) await this.say(groupId, { kind: "already_open", activity: open.request.activity });
        else await this.startPlan(msg, sender);
        return;
      }
      if (!open) return; // not addressed to us
      if (open.status === "proposed") await this.handleVotes(open, sender, msg);
      else if (open.status === "organizer_pick") await this.handleOrganizerPick(open, sender, msg.text);
    });
  }

  private async startPlan(msg: InboundMessage, organizer: User): Promise<void> {
    const groupId = msg.groupId!;
    const { request: requestText, optionalPhones } = extractOptional(stripMention(msg.text));
    const request = await this.brain.parseRequest(requestText, { now: this.now(), timezone: this.timezone });
    if (!request) {
      await this.say(groupId, { kind: "parse_failed" });
      return;
    }

    const phones = new Set([msg.from, ...msg.participants]);
    if (msg.botNumber) phones.delete(msg.botNumber);
    if (config.sendblue.fromNumber) phones.delete(config.sendblue.fromNumber);

    const plan = await this.repo.createPlan({
      groupId,
      organizerId: organizer.id,
      status: "collecting",
      round: 1,
      request,
      rawRequest: msg.text,
      timezone: this.timezone,
      deadline: null,
      roundStartedAt: null,
      lockedSlotId: null,
    });

    const unconnected: User[] = [];
    for (const phone of phones) {
      const user = await this.repo.upsertUserByPhone(phone);
      const role: MemberRole = optionalPhones.has(phone) ? "optional" : "essential";
      await this.repo.addMember(plan.id, user.id, role);
      if (this.calendarsEnabled && !(await this.repo.getCalendarConnection(user.id))) unconnected.push(user);
    }

    await this.say(groupId, {
      kind: "ack",
      activity: request.activity,
      windowLabel: windowLabel(request.windowStart, request.windowEnd, this.timezone),
      unconnectedNames: unconnected.map(displayName),
    });

    if (unconnected.length === 0) {
      await this.proposeRound(plan, "confident");
      return;
    }
    // Give people a few minutes to connect calendars; the scheduler proposes after.
    for (const user of unconnected) {
      await this.sayDirect(user.phone, {
        kind: "connect_calendar",
        name: user.name,
        url: connectUrl(user.id),
        activity: request.activity,
      });
    }
    await this.repo.updatePlan(plan.id, {
      deadline: new Date(this.now().getTime() + COLLECTING_GRACE_MS).toISOString(),
    });
  }

  // ───────────────────────────── rounds ──────────────────────────────

  private async proposeRound(plan: Plan, reason: "confident" | "after_no"): Promise<void> {
    const now = this.now();
    const members = await this.repo.listMembers(plan.id);
    const roles = new Map(members.map((m) => [m.userId, m.role]));
    const availability = await this.loadAvailability(
      this.repo,
      members.map((m) => m.userId),
      new Date(plan.request.windowStart),
      new Date(plan.request.windowEnd),
    );

    // Each "no" narrows the window: never re-propose a rejected time.
    const previous = await this.repo.listSlots(plan.id);
    const ranked = scoreSlots({
      request: plan.request,
      timezone: plan.timezone,
      availability,
      roles,
      exclude: previous.map((s) => ({ start: new Date(s.start), end: new Date(s.end) })),
      notBefore: now,
    });

    if (ranked.length === 0) {
      if (previous.length) await this.startOrganizerPick(plan);
      else await this.fail(plan);
      return;
    }

    const unknownCount = [...availability.values()].filter((v) => v === null).length;
    const count = decideOptionCount({
      round: plan.round,
      memberCount: members.length,
      unknownCount,
      topScores: ranked.slice(0, 3).map((s) => s.score),
    });
    const picked = pickDistinct(ranked, count, plan.timezone);
    const deadline = computeDeadline(now, picked[0].start);

    const slots = await this.repo.addSlots(
      picked.map((s, i) => ({
        planId: plan.id,
        round: plan.round,
        optionNumber: i + 1,
        start: s.start.toISOString(),
        end: s.end.toISOString(),
        score: s.score,
      })),
    );
    await this.repo.updatePlan(plan.id, {
      status: "proposed",
      deadline: deadline.toISOString(),
      roundStartedAt: now.toISOString(),
    });
    for (const m of members) await this.repo.updateMember(plan.id, m.userId, { remindersSent: 0 });

    await this.say(plan.groupId, {
      kind: "proposal",
      activity: plan.request.activity,
      round: plan.round,
      options: slots.map((s) => ({ optionNumber: s.optionNumber, label: this.slotLabel(s, plan) })),
      deadlineLabel: formatDeadline(deadline, plan.timezone),
      reason: reason === "after_no" ? "after_no" : count > 1 ? "uncertain" : "confident",
    });
    // One bubble per option so each can be tapbacked on its own.
    for (const slot of slots) {
      const sent = await this.messenger.sendGroup(
        plan.groupId,
        formatOption(slot.optionNumber, this.slotLabel(slot, plan)),
      );
      if (sent.messageHandle) await this.repo.linkProposalMessage(sent.messageHandle, plan.id, slot.id);
    }
  }

  private async handleVotes(plan: Plan, voter: User, msg: InboundMessage): Promise<void> {
    const votes = parseVotes(msg);
    if (votes.length === 0) return;

    let member = (await this.repo.listMembers(plan.id)).find((m) => m.userId === voter.id);
    // Someone added to the chat after the plan started still gets a say, without blocking quorum.
    member ??= await this.repo.addMember(plan.id, voter.id, "optional");

    const slots = await this.repo.listSlots(plan.id, plan.round);
    let recorded = 0;
    for (const vote of votes) {
      for (const slot of await this.resolveSlots(vote, slots, msg)) {
        await this.repo.recordVote(plan.id, slot.id, voter.id, vote.vote);
        recorded++;
      }
    }
    if (recorded === 0) return;
    if (member.timedOut) await this.repo.updateMember(plan.id, voter.id, { timedOut: false });

    await this.advance(plan, false);
  }

  private async resolveSlots(vote: ParsedVote, slots: CandidateSlot[], msg: InboundMessage) {
    if (vote.allOptions) return slots;
    if (vote.targetHandle) {
      const linked = await this.repo.getProposalMessage(vote.targetHandle);
      const slot = linked && slots.find((s) => s.id === linked.slotId);
      if (slot) return [slot];
    }
    if (vote.optionNumber !== null) return slots.filter((s) => s.optionNumber === vote.optionNumber);
    if (msg.replyToHandle) {
      const linked = await this.repo.getProposalMessage(msg.replyToHandle);
      const slot = linked && slots.find((s) => s.id === linked.slotId);
      if (slot) return [slot];
    }
    // A bare "yes" is only unambiguous when there's a single option.
    return slots.length === 1 ? slots : [];
  }

  /** Re-evaluates the current round and acts on the outcome. */
  private async advance(plan: Plan, deadlinePassed: boolean): Promise<void> {
    const [slots, responses, members] = await Promise.all([
      this.repo.listSlots(plan.id, plan.round),
      this.repo.listResponses(plan.id),
      this.repo.listMembers(plan.id),
    ]);
    const outcome = evaluateRound({ round: plan.round, slots, responses, members, deadlinePassed });

    switch (outcome.type) {
      case "wait":
        return;
      case "lock":
        await this.lockIn(plan, outcome.slotId);
        return;
      case "next_round": {
        const next = await this.repo.updatePlan(plan.id, { round: plan.round + 1 });
        await this.proposeRound(next, "after_no");
        return;
      }
      case "organizer_pick":
        await this.startOrganizerPick(plan);
        return;
    }
  }

  private async lockIn(plan: Plan, slotId: string): Promise<void> {
    const slot = (await this.repo.listSlots(plan.id)).find((s) => s.id === slotId)!;
    const [responses, members] = await Promise.all([
      this.repo.listResponses(plan.id),
      this.repo.listMembers(plan.id),
    ]);
    await this.repo.updatePlan(plan.id, { status: "locked", lockedSlotId: slotId, deadline: null });

    const slotVotes = responses.filter((r) => r.slotId === slotId);
    const names = async (ids: string[]) =>
      (await Promise.all(ids.map((id) => this.repo.getUser(id)))).flatMap((u) => (u ? [displayName(u)] : []));
    const maybeIds = slotVotes.filter((r) => r.vote === "maybe").map((r) => r.userId);
    const missing = members.filter((m) => !slotVotes.some((r) => r.userId === m.userId));

    const label = this.slotLabel(slot, plan);
    await this.say(plan.groupId, {
      kind: "locked",
      activity: plan.request.activity,
      slotLabel: label,
      maybeNames: await names(maybeIds),
      missingNames: await names(missing.map((m) => m.userId)),
    });
    // People we decided without get a direct heads-up.
    await this.notifyTimedOut(plan, members, label);
  }

  private async startOrganizerPick(plan: Plan): Promise<void> {
    const [slots, responses, members] = await Promise.all([
      this.repo.listSlots(plan.id),
      this.repo.listResponses(plan.id),
      this.repo.listMembers(plan.id),
    ]);
    const options = bestPartialOptions(slots, responses, members);
    if (options.length === 0) {
      await this.fail(plan);
      return;
    }
    await this.repo.updatePlan(plan.id, { status: "organizer_pick", deadline: null });
    await this.say(plan.groupId, {
      kind: "organizer_pick",
      activity: plan.request.activity,
      options: options.map((t, i) => ({
        optionNumber: i + 1,
        label: this.slotLabel(t.slot, plan),
        yes: t.yes,
        maybe: t.maybe,
      })),
    });
  }

  private async handleOrganizerPick(plan: Plan, sender: User, text: string): Promise<void> {
    if (sender.id !== plan.organizerId) return;
    const choice = /^\s*(\d)\s*$/.exec(text);
    if (!choice) return;
    const [slots, responses, members] = await Promise.all([
      this.repo.listSlots(plan.id),
      this.repo.listResponses(plan.id),
      this.repo.listMembers(plan.id),
    ]);
    const picked = bestPartialOptions(slots, responses, members)[Number(choice[1]) - 1];
    if (picked) await this.lockIn(plan, picked.slot.id);
  }

  private async fail(plan: Plan): Promise<void> {
    await this.repo.updatePlan(plan.id, { status: "failed", deadline: null });
    await this.say(plan.groupId, { kind: "failed", activity: plan.request.activity });
  }

  // ──────────────────────────── scheduler ────────────────────────────

  /** Called periodically: grace periods, reminders, and deadlines. */
  async tick(): Promise<void> {
    for (const plan of await this.repo.listOpenPlans()) {
      try {
        await this.lock.run(plan.groupId, () => this.tickPlan(plan.id));
      } catch (err) {
        console.error(`[scheduler] plan ${plan.id} failed:`, err);
      }
    }
  }

  private async tickPlan(planId: string): Promise<void> {
    const plan = await this.repo.getPlan(planId); // re-read inside the lock
    if (!plan || !plan.deadline) return;
    const now = this.now();
    const deadline = new Date(plan.deadline);

    if (plan.status === "collecting") {
      if (now >= deadline) await this.proposeRound(plan, "confident");
      return;
    }
    if (plan.status !== "proposed") return;

    const [members, slots, responses] = await Promise.all([
      this.repo.listMembers(plan.id),
      this.repo.listSlots(plan.id, plan.round),
      this.repo.listResponses(plan.id),
    ]);
    const pending = members.filter(
      (m) => !m.timedOut && slots.some((s) => !responses.some((r) => r.slotId === s.id && r.userId === m.userId)),
    );

    if (now >= deadline) {
      // Decide without the people who didn't answer.
      for (const m of pending) await this.repo.updateMember(plan.id, m.userId, { timedOut: true });
      await this.advance(plan, true);
      return;
    }

    const roundStartedAt = new Date(plan.roundStartedAt ?? plan.updatedAt);
    for (const m of pending) {
      if (reminderDue(m, roundStartedAt, deadline, now) === null) continue;
      const user = await this.repo.getUser(m.userId);
      if (!user) continue;
      await this.sayDirect(user.phone, {
        kind: "reminder",
        name: user.name,
        activity: plan.request.activity,
        deadlineLabel: formatDeadline(deadline, plan.timezone),
        remaining: 1 - m.remindersSent,
      });
      await this.repo.updateMember(plan.id, m.userId, {
        remindersSent: m.remindersSent + 1,
        lastRemindedAt: now.toISOString(),
      });
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async notifyTimedOut(plan: Plan, members: PlanMember[], slotLabel: string | null) {
    for (const m of members.filter((m) => m.timedOut)) {
      const user = await this.repo.getUser(m.userId);
      if (user) {
        await this.sayDirect(user.phone, {
          kind: "timed_out",
          name: user.name,
          activity: plan.request.activity,
          slotLabel,
        });
      }
    }
  }

  private slotLabel(slot: CandidateSlot, plan: Plan) {
    return formatSlot(new Date(slot.start), new Date(slot.end), plan.timezone);
  }

  private async say(groupId: string, message: BotMessage) {
    return this.messenger.sendGroup(groupId, await this.brain.compose(message));
  }

  /**
   * DMs are best-effort: a failed calendar link or reminder (e.g. Photon's
   * shared-pool allowlist rejecting an unregistered number) must not break the plan.
   */
  private async sayDirect(phone: string, message: BotMessage) {
    try {
      return await this.messenger.sendDirect(phone, await this.brain.compose(message));
    } catch (err) {
      console.error(`[coordinator] direct message to ${phone} failed:`, err);
      return null;
    }
  }
}

function displayName(user: User): string {
  return user.name ?? `…${user.phone.slice(-4)}`;
}

function windowLabel(startIso: string, endIso: string, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" });
  const first = fmt.format(new Date(startIso));
  const last = fmt.format(new Date(Date.parse(endIso) - 1));
  return first === last ? `on ${first}` : `between ${first} and ${last}`;
}

/**
 * Organizer can mark people optional inline:
 * "@planner dinner next weekend optional: +15551234567, +15557654321"
 */
export function extractOptional(text: string): { request: string; optionalPhones: Set<string> } {
  const match = /\boptional:?\s+(.+)$/i.exec(text);
  if (!match) return { request: text, optionalPhones: new Set() };
  const phones = match[1].split(/[,;]|\band\b/).map((part) => {
    const digits = part.replace(/\D/g, "");
    if (digits.length < 10 || /[a-z]/i.test(part)) return null;
    return digits.length === 10 ? `+1${digits}` : `+${digits}`;
  });
  // Every entry must be a phone number; otherwise "optional" was just part of the request.
  if (phones.some((p) => p === null)) return { request: text, optionalPhones: new Set() };
  return { request: text.slice(0, match.index).trim(), optionalPhones: new Set(phones as string[]) };
}
