import { loadAvailability } from "../calendar/availability.ts";
import { connectUrl } from "../calendar/links.ts";
import { pickDistinct, scoreSlots } from "../calendar/slots.ts";
import { config, hasGoogle } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import { formatOption, type Brain, type BotMessage } from "../llm/index.ts";
import { localPart } from "../messaging/address.ts";
import type { Capabilities, InboundMessage, Messenger } from "../messaging/types.ts";
import { isMentioned, stripMention } from "../messaging/mentions.ts";
import { parseVotes, type ParsedVote } from "../messaging/votes.ts";
import { formatDeadline, formatSlot } from "../time.ts";
import type {
  CandidateSlot,
  MemberRole,
  ParsedRequest,
  Plan,
  PlanMember,
  PreferenceUpdate,
  Preferences,
  TimeWindow,
  User,
} from "../types.ts";
import {
  clipWindows,
  collectionDeadline,
  describeWindow,
  fewestConflicts,
  invertWindows,
  MAX_DM_MEMBERS,
  MAX_DM_OPTIONS,
  ORGANIZER_PICK_MS,
} from "./dm-planning.ts";
import { KeyedLock } from "./lock.ts";
import { mergePreferences, describeUpdate } from "./preferences.ts";
import { isSelf, parseNameIntro, resolveName, type RoleStatement } from "./roles.ts";
import {
  bestPartialOptions,
  COLLECTING_GRACE_MS,
  computeDeadline,
  decideOptionCount,
  evaluateRound,
  leadingSlot,
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
  /** What the network behind a group chat can do. Defaults to emoji votes in the group. */
  capabilities?: (groupId: string) => Capabilities | undefined;
}

const DEFAULT_CAPABILITIES: Capabilities = { reactions: true, collectByDm: false };

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
  private capabilitiesOf: (groupId: string) => Capabilities;
  private lock = new KeyedLock();

  constructor(deps: CoordinatorDeps) {
    this.repo = deps.repo;
    this.messenger = deps.messenger;
    this.brain = deps.brain;
    this.now = deps.now ?? (() => new Date());
    this.timezone = deps.timezone ?? config.defaultTimezone;
    this.calendarsEnabled = deps.calendarsEnabled ?? hasGoogle();
    this.loadAvailability = deps.loadAvailability ?? loadAvailability;
    this.capabilitiesOf = (groupId) => deps.capabilities?.(groupId) ?? DEFAULT_CAPABILITIES;
  }

  // ───────────────────────────── inbound ─────────────────────────────

  async handleInbound(msg: InboundMessage): Promise<void> {
    if (msg.isOutbound || !msg.from) return;
    if (!msg.groupId) {
      if (msg.text && !msg.reaction) await this.handleDirect(msg);
      return;
    }
    const groupId = msg.groupId;
    await this.lock.run(groupId, async () => {
      const sender = await this.repo.upsertUserByAddress(msg.from);
      const open = await this.repo.getOpenPlanForGroup(groupId);

      if (!msg.reaction && isMentioned(msg.text)) {
        const text = stripMention(msg.text);
        const name = parseNameIntro(text);
        if (name) {
          await this.saveName(groupId, sender, name, open);
          return;
        }
        const { request: withoutPhones, optionalPhones } = extractOptional(text);
        const meaning = await this.brain.interpret(withoutPhones, { now: this.now(), timezone: this.timezone });
        switch (meaning.kind) {
          case "preference":
            await this.savePreferences(groupId, sender, meaning.update);
            break;
          case "constraint":
            if (open) await this.applyConstraint(open, sender, meaning.windows);
            else await this.say(groupId, { kind: "nothing_scheduled" });
            break;
          case "request":
            if (open) await this.handleOpenMention(open, sender, text, meaning.roles);
            else await this.startPlan(msg, sender, meaning.request, meaning.roles, optionalPhones);
            break;
          case "roles":
          case "other":
            // A bare name can answer "Which Sam do you mean?", so "other" goes to the open plan too.
            if (open) await this.handleOpenMention(open, sender, text, meaning.kind === "roles" ? meaning.roles : []);
            else await this.say(groupId, { kind: "parse_failed" });
            break;
        }
        return;
      }
      if (!open) return; // not addressed to us
      if (open.status === "proposed") await this.handleVotes(open, sender, msg);
      else if (open.status === "organizer_pick") await this.handleOrganizerPick(open, sender, msg.text);
    });
  }

  private async startPlan(
    msg: InboundMessage,
    organizer: User,
    request: ParsedRequest,
    statements: RoleStatement[],
    optionalPhones: Set<string>,
  ): Promise<void> {
    const groupId = msg.groupId!;

    const addresses = new Set([msg.from, ...msg.participants]);
    if (msg.botAddress) addresses.delete(msg.botAddress);

    const byDm = this.capabilitiesOf(groupId).collectByDm;
    if (byDm && addresses.size > MAX_DM_MEMBERS) {
      await this.say(groupId, { kind: "too_many_people", count: addresses.size, max: MAX_DM_MEMBERS });
      return;
    }

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
      pendingRoles: [],
    });

    const unconnected: User[] = [];
    for (const address of addresses) {
      let user = await this.repo.upsertUserByAddress(address);
      // A name from the network fills a gap, but never replaces one the person told us.
      const networkName = msg.names?.[address];
      if (!user.name && networkName) user = await this.repo.upsertUserByAddress(address, { name: networkName });
      const role: MemberRole = optionalPhones.has(localPart(address)) ? "optional" : "essential";
      await this.repo.addMember(plan.id, user.id, role);
      if (!byDm && this.calendarsEnabled && !(await this.repo.getCalendarConnection(user.id))) unconnected.push(user);
    }
    const roles = await this.applyRoles(plan, statements, organizer);
    const optional = (await this.repo.listMembers(plan.id)).filter((m) => m.role === "optional");
    const optionalNames = (await Promise.all(optional.map((m) => this.repo.getUser(m.userId)))).flatMap((u) =>
      u ? [displayName(u)] : [],
    );

    if (byDm) {
      await this.askEveryone(plan, optionalNames, roles.question);
      return;
    }

    await this.say(groupId, {
      kind: "ack",
      activity: request.activity,
      windowLabel: windowLabel(request.windowStart, request.windowEnd, this.timezone),
      unconnectedNames: unconnected.map(displayName),
      optionalNames,
    });
    if (roles.question) await this.say(groupId, roles.question);

    if (unconnected.length === 0) {
      await this.proposeRound(plan, "confident");
      return;
    }
    // Give people a few minutes to connect calendars; the scheduler proposes after.
    const unreachable: string[] = [];
    for (const user of unconnected) {
      const sent = await this.sayDirect(user.address, {
        kind: "connect_calendar",
        name: user.name,
        url: connectUrl(user.id),
        activity: request.activity,
      });
      if (!sent) unreachable.push(displayName(user));
    }
    if (unreachable.length) await this.say(groupId, { kind: "dm_failed", names: unreachable });
    await this.repo.updatePlan(plan.id, {
      deadline: new Date(this.now().getTime() + COLLECTING_GRACE_MS).toISOString(),
    });
  }

  // ───────────────────────── planning by DM ──────────────────────────
  //
  // collecting: everyone is asked by DM, and their answers are saved on the member.
  // organizer_pick: once all are in (or the deadline passes), the organizer picks.

  private async askEveryone(created: Plan, optionalNames: string[], question: BotMessage | null): Promise<void> {
    const now = this.now();
    const deadline = collectionDeadline(now, new Date(created.request.windowEnd));
    const plan = await this.repo.updatePlan(created.id, {
      deadline: deadline.toISOString(),
      roundStartedAt: now.toISOString(),
    });
    const { activity } = plan.request;
    const label = windowLabel(plan.request.windowStart, plan.request.windowEnd, plan.timezone);
    const deadlineLabel = formatDeadline(deadline, plan.timezone);

    await this.say(plan.groupId, { kind: "availability_asked", activity, windowLabel: label, deadlineLabel, optionalNames });
    if (question) await this.say(plan.groupId, question);

    const organizer = await this.repo.getUser(plan.organizerId);
    const unreachable: string[] = [];
    for (const member of await this.repo.listMembers(plan.id)) {
      const user = await this.repo.getUser(member.userId);
      if (!user) continue;
      const sent = await this.sayDirect(user.address, {
        kind: "availability_ask",
        name: user.name,
        organizerName: user.id === plan.organizerId || !organizer ? null : displayName(organizer),
        activity,
        windowLabel: label,
        deadlineLabel,
      });
      if (sent) continue;
      // Nobody should wait for an answer that can't come.
      unreachable.push(displayName(user));
      await this.repo.updateMember(plan.id, user.id, { timedOut: true });
    }
    if (unreachable.length) await this.say(plan.groupId, { kind: "dm_unreachable", names: unreachable });
    await this.closeCollectionIfDone(plan);
  }

  /** A DM to the bot: an answer about times, the organizer's pick, or someone who needs pointing to a group. */
  private async handleDirect(msg: InboundMessage): Promise<void> {
    const sender = await this.repo.upsertUserByAddress(msg.from);
    const text = stripMention(msg.text);

    const plans: Plan[] = [];
    for (const plan of await this.repo.listOpenPlans()) {
      if (!this.capabilitiesOf(plan.groupId).collectByDm) continue;
      if ((await this.repo.listMembers(plan.id)).some((m) => m.userId === sender.id)) plans.push(plan);
    }
    const picking = plans.filter((p) => p.status === "organizer_pick" && p.organizerId === sender.id);
    const collecting = plans.filter((p) => p.status === "collecting");

    if (picking.length && /^\s*\d+\s*$/.test(text)) {
      const plan = picking.at(-1)!;
      await this.lock.run(plan.groupId, () => this.handleOrganizerPick(plan, sender, text));
      return;
    }
    if (collecting.length) {
      const named = collecting.filter((p) => text.toLowerCase().includes(p.request.activity.toLowerCase()));
      const plan = collecting.length === 1 ? collecting[0] : named.length === 1 ? named[0] : null;
      if (plan) await this.lock.run(plan.groupId, () => this.saveAvailability(plan.id, sender, text));
      else await this.sayDirect(sender.address, { kind: "availability_which", activities: collecting.map((p) => p.request.activity) });
      return;
    }
    if (picking.length) {
      const plan = picking.at(-1)!;
      const optionCount = (await this.repo.listSlots(plan.id, plan.round)).length;
      await this.sayDirect(sender.address, { kind: "pick_invalid", activity: plan.request.activity, optionCount });
      return;
    }
    if (plans.length) {
      await this.sayDirect(sender.address, { kind: "availability_closed", activity: plans.at(-1)!.request.activity });
      return;
    }
    await this.sayDirect(sender.address, { kind: "dm_help" });
  }

  private async saveAvailability(planId: string, sender: User, text: string): Promise<void> {
    const plan = await this.repo.getPlan(planId); // re-read inside the lock
    if (!plan) return;
    const { activity, windowStart, windowEnd } = plan.request;
    if (plan.status !== "collecting") {
      await this.sayDirect(sender.address, { kind: "availability_closed", activity });
      return;
    }
    const window: TimeWindow = { start: windowStart, end: windowEnd };
    const reading = await this.brain.parseAvailability(text, { now: this.now(), timezone: plan.timezone, activity, window });
    const windows = reading.kind === "windows" ? clipWindows(reading.windows, window) : [];
    // Times entirely outside the plan aren't an answer, so ask again rather than count them as "nothing works".
    if (reading.kind === "unclear" || (reading.kind === "windows" && windows.length === 0)) {
      await this.sayDirect(sender.address, {
        kind: "availability_unclear",
        activity,
        windowLabel: windowLabel(windowStart, windowEnd, plan.timezone),
      });
      return;
    }

    await this.repo.updateMember(plan.id, sender.id, { statedAvailability: windows, timedOut: false });
    const waitingOn = (await this.repo.listMembers(plan.id)).filter(isAwaitedAnswer).length;
    await this.sayDirect(sender.address, {
      kind: "availability_saved",
      activity,
      windowLabels: windows.map((w) => describeWindow(w, window, plan.timezone)),
      waitingOn,
    });
    await this.closeCollectionIfDone(plan);
  }

  private async closeCollectionIfDone(plan: Plan): Promise<void> {
    if (!(await this.repo.listMembers(plan.id)).some(isAwaitedAnswer)) await this.offerTimesToOrganizer(plan);
  }

  /** Finds the overlap in what people said and asks the organizer to choose. */
  private async offerTimesToOrganizer(plan: Plan): Promise<void> {
    const members = await this.repo.listMembers(plan.id);
    const bounds: TimeWindow = { start: plan.request.windowStart, end: plan.request.windowEnd };
    const availability = await this.loadAvailability(
      this.repo,
      members.map((m) => m.userId),
      new Date(bounds.start),
      new Date(bounds.end),
    );
    const preferences = new Map<string, Preferences>();
    for (const m of members) {
      const prefs = await this.repo.getPreferences(m.userId);
      if (prefs) preferences.set(m.userId, prefs);
      if (m.statedAvailability === null) continue;
      const busy = invertWindows(m.statedAvailability, bounds).map((w) => ({ start: new Date(w.start), end: new Date(w.end) }));
      availability.set(m.userId, [...(availability.get(m.userId) ?? []), ...busy]);
    }
    const ranked = scoreSlots({
      request: plan.request,
      timezone: plan.timezone,
      availability,
      // Everyone counts as optional here so conflicts lower a slot instead of removing it:
      // when nothing suits everyone, the organizer still sees the closest times.
      roles: new Map(members.map((m) => [m.userId, "optional" as const])),
      notBefore: this.now(),
      preferences,
      anyReasonableHour: true,
    });
    if (ranked.length === 0) {
      await this.fail(plan);
      return;
    }
    const picked = pickDistinct(fewestConflicts(ranked), MAX_DM_OPTIONS, plan.timezone);
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
    const deadline = new Date(this.now().getTime() + ORGANIZER_PICK_MS);
    await this.repo.updatePlan(plan.id, { status: "organizer_pick", deadline: deadline.toISOString() });

    const nameOf = async (id: string) => {
      const user = await this.repo.getUser(id);
      return user ? displayName(user) : "someone";
    };
    const noAnswer = members.filter((m) => m.statedAvailability === null);
    const summary = { activity: plan.request.activity, answered: members.length - noAnswer.length, total: members.length };
    const organizer = await this.repo.getUser(plan.organizerId);
    const noAnswerNames = await Promise.all(noAnswer.map((m) => nameOf(m.userId)));
    const options = await Promise.all(
      slots.map(async (slot, i) => ({
        optionNumber: slot.optionNumber,
        label: this.slotLabel(slot, plan),
        cantNames: await Promise.all(picked[i].conflictUserIds.map(nameOf)),
      })),
    );

    const delivered =
      organizer &&
      (await this.sayDirect(organizer.address, { kind: "availability_options", organizerName: null, noAnswerNames, options, ...summary }));
    const organizerName = organizer ? displayName(organizer) : "the organizer";
    if (delivered) {
      await this.say(plan.groupId, { kind: "organizer_picking", organizerName, ...summary });
      return;
    }
    // The organizer can't be DMed, so they pick in the group. Who said what stays private.
    await this.say(plan.groupId, {
      kind: "availability_options",
      organizerName,
      noAnswerNames: [],
      options: options.map((o) => ({ ...o, cantNames: [] })),
      ...summary,
    });
  }

  // ───────────────────────────── roles ───────────────────────────────

  /**
   * Applies "Sam is optional"-style statements to plan members by name. Names
   * that don't match exactly one member are kept as pending and asked about
   * once, in a single question.
   */
  private async applyRoles(plan: Plan, statements: RoleStatement[], sender: User) {
    const changes: { name: string; role: MemberRole }[] = [];
    if (statements.length === 0) return { changes, question: null };
    const members = await this.repo.listMembers(plan.id);
    const people = (await Promise.all(members.map((m) => this.repo.getUser(m.userId)))).flatMap((u) => (u ? [u] : []));
    let pending = [...plan.pendingRoles];
    const unknown: string[] = [];
    const ambiguous: { name: string; options: string[] }[] = [];

    for (const { names, role } of statements) {
      for (const name of names) {
        const found = isSelf(name) ? { kind: "match" as const, user: sender } : resolveName(name, people);
        if (found.kind === "match") {
          // Someone added to the chat after the plan started isn't a member yet.
          if (isSelf(name)) await this.repo.addMember(plan.id, sender.id, role);
          await this.repo.updateMember(plan.id, found.user.id, { role });
          changes.push({ name: displayName(found.user), role });
          pending = pending.filter((p) => !p.candidates.includes(found.user.id) && !sameName(p.name, name));
          continue;
        }
        const asked = pending.find((p) => sameName(p.name, name));
        if (asked) {
          asked.role = role; // already asked once; just keep the latest wish
          continue;
        }
        const options = found.kind === "ambiguous" ? found.options : [];
        pending.push({ name, role, candidates: options.map((u) => u.id) });
        if (options.length) ambiguous.push({ name: titleCase(name), options: options.map(displayName) });
        else unknown.push(titleCase(name));
      }
    }
    await this.repo.updatePlan(plan.id, { pendingRoles: pending });
    const question: BotMessage | null =
      unknown.length || ambiguous.length ? { kind: "role_question", unknown, ambiguous } : null;
    return { changes, question };
  }

  /** An @mention while a plan is open: a role change from the organizer, or a polite "busy". */
  private async handleOpenMention(plan: Plan, sender: User, text: string, parsed: RoleStatement[]): Promise<void> {
    let statements = parsed;
    // A bare name ("@planner Sam Patel") answers "Which Sam do you mean?"
    if (statements.length === 0 && sender.id === plan.organizerId) {
      const answer = await this.answerAmbiguous(plan, text);
      if (answer) statements = [answer];
    }
    if (statements.length === 0) {
      await this.say(plan.groupId, { kind: "already_open", activity: plan.request.activity });
      return;
    }
    // Anyone can make themselves optional; everything else is the organizer's call.
    const selfOptional = statements.every((s) => s.role === "optional" && s.names.every(isSelf));
    if (sender.id !== plan.organizerId && !selfOptional) {
      const organizer = await this.repo.getUser(plan.organizerId);
      await this.say(plan.groupId, { kind: "organizer_only", organizerName: organizer ? displayName(organizer) : "the organizer" });
      return;
    }
    const { changes, question } = await this.applyRoles(plan, statements, sender);
    if (changes.length) await this.say(plan.groupId, { kind: "roles_set", changes });
    if (question) await this.say(plan.groupId, question);
    // Fewer required people can settle the current round.
    if (changes.length && plan.status === "proposed") await this.advance(plan, false);
  }

  private async answerAmbiguous(plan: Plan, text: string): Promise<RoleStatement | null> {
    for (const p of plan.pendingRoles.filter((p) => p.candidates.length > 1)) {
      const options = (await Promise.all(p.candidates.map((id) => this.repo.getUser(id)))).flatMap((u) => (u ? [u] : []));
      if (resolveName(text, options).kind === "match") return { names: [text], role: p.role };
    }
    return null;
  }

  /** "@planner I'm Sam": remember the name, and apply a role that was waiting on it. */
  private async saveName(groupId: string, sender: User, name: string, open: Plan | null): Promise<void> {
    const user = await this.repo.upsertUserByAddress(sender.address, { name });
    const isMember = open !== null && (await this.repo.listMembers(open.id)).some((m) => m.userId === user.id);
    const waiting = isMember
      ? open.pendingRoles.find((p) => p.candidates.length === 0 && resolveName(p.name, [user]).kind === "match")
      : undefined;
    if (!open || !waiting) {
      await this.say(groupId, { kind: "name_saved", name, role: null, activity: null });
      return;
    }
    await this.repo.updateMember(open.id, user.id, { role: waiting.role });
    await this.repo.updatePlan(open.id, { pendingRoles: open.pendingRoles.filter((p) => p !== waiting) });
    await this.say(groupId, { kind: "name_saved", name, role: waiting.role, activity: open.request.activity });
    if (open.status === "proposed") await this.advance(open, false);
  }

  // ─────────────────────────── preferences ───────────────────────────

  /** "@planner I don't do mornings": merge into what they saved before and confirm in one line. */
  private async savePreferences(groupId: string, sender: User, update: PreferenceUpdate): Promise<void> {
    const merged = mergePreferences(await this.repo.getPreferences(sender.id), update);
    await this.repo.savePreferences(sender.id, merged);
    await this.say(groupId, { kind: "preferences_saved", name: displayName(sender), summary: describeUpdate(update) });
  }

  /**
   * "I can't do this Saturday" while a plan is open: a "no" from the sender on
   * every current option in those windows. Plan-scoped only, never saved.
   */
  private async applyConstraint(plan: Plan, sender: User, windows: { start: string; end: string }[]): Promise<void> {
    const slots = plan.status === "proposed" ? await this.repo.listSlots(plan.id, plan.round) : [];
    const hit = slots.filter((s) => windows.some((w) => s.start < w.end && w.start < s.end));
    if (hit.length) {
      const member = (await this.repo.listMembers(plan.id)).find((m) => m.userId === sender.id);
      if (!member) await this.repo.addMember(plan.id, sender.id, "optional");
      else if (member.timedOut) await this.repo.updateMember(plan.id, sender.id, { timedOut: false });
      for (const slot of hit) await this.repo.recordVote(plan.id, slot.id, sender.id, "no");
    }
    await this.say(plan.groupId, {
      kind: "constraint_noted",
      name: displayName(sender),
      optionNumbers: hit.map((s) => s.optionNumber),
    });
    if (hit.length) await this.advance(plan, false);
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
    const preferences = new Map<string, Preferences>();
    for (const m of members) {
      const prefs = await this.repo.getPreferences(m.userId);
      if (prefs) preferences.set(m.userId, prefs);
    }
    const ranked = scoreSlots({
      request: plan.request,
      timezone: plan.timezone,
      availability,
      roles,
      exclude: previous.map((s) => ({ start: new Date(s.start), end: new Date(s.end) })),
      notBefore: now,
      preferences,
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
      reactions: this.capabilitiesOf(plan.groupId).reactions,
      reason: reason === "after_no" ? "after_no" : count > 1 ? "uncertain" : "confident",
    });
    // One message per option so each can get its own reaction.
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
    // "Didn't hear from" means no vote on any option that round, not just this one.
    const roundSlotIds = new Set((await this.repo.listSlots(plan.id, slot.round)).map((s) => s.id));
    const missing = this.capabilitiesOf(plan.groupId).collectByDm
      ? members.filter((m) => m.statedAvailability === null)
      : members.filter((m) => !responses.some((r) => r.userId === m.userId && roundSlotIds.has(r.slotId)));

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
    if (this.capabilitiesOf(plan.groupId).collectByDm) {
      // Options were numbered when offered, and there are no votes to re-rank them by.
      const slots = await this.repo.listSlots(plan.id, plan.round);
      const slot = choice && slots.find((s) => s.optionNumber === Number(choice[1]));
      if (slot) await this.lockIn(plan, slot.id);
      else await this.sayDirect(sender.address, { kind: "pick_invalid", activity: plan.request.activity, optionCount: slots.length });
      return;
    }
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

    if (this.capabilitiesOf(plan.groupId).collectByDm) {
      await this.tickDmPlan(plan, now, deadline);
      return;
    }
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
    // Voting on any option this round counts as answering; skipped options are just no response.
    const pending = members.filter(
      (m) => !m.timedOut && !slots.some((s) => responses.some((r) => r.slotId === s.id && r.userId === m.userId)),
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
      await this.sayDirect(user.address, {
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

    // Essential members who answered but skipped the leading option get one nudge
    // about it per round, on the reminder schedule and counting toward the cap.
    const leading = leadingSlot(slots, responses, members);
    if (!leading) return;
    for (const m of members) {
      if (m.role !== "essential" || m.timedOut || pending.includes(m) || m.nudgedRound === plan.round) continue;
      if (responses.some((r) => r.slotId === leading.id && r.userId === m.userId)) continue;
      if (reminderDue(m, roundStartedAt, deadline, now) === null) continue;
      const user = await this.repo.getUser(m.userId);
      if (!user) continue;
      await this.sayDirect(user.address, {
        kind: "nudge",
        name: user.name,
        activity: plan.request.activity,
        optionNumber: leading.optionNumber,
        slotLabel: this.slotLabel(leading, plan),
        deadlineLabel: formatDeadline(deadline, plan.timezone),
        reactions: this.capabilitiesOf(plan.groupId).reactions,
      });
      await this.repo.updateMember(plan.id, m.userId, {
        remindersSent: m.remindersSent + 1,
        lastRemindedAt: now.toISOString(),
        nudgedRound: plan.round,
      });
    }
  }

  private async tickDmPlan(plan: Plan, now: Date, deadline: Date): Promise<void> {
    if (plan.status === "organizer_pick") {
      if (now < deadline) return;
      const organizer = await this.repo.getUser(plan.organizerId);
      await this.repo.updatePlan(plan.id, { status: "failed", deadline: null });
      await this.say(plan.groupId, {
        kind: "pick_expired",
        activity: plan.request.activity,
        organizerName: organizer ? displayName(organizer) : "The organizer",
      });
      return;
    }
    if (plan.status !== "collecting") return;

    const unanswered = (await this.repo.listMembers(plan.id)).filter((m) => m.statedAvailability === null && !m.timedOut);
    if (now >= deadline) {
      for (const m of unanswered) await this.repo.updateMember(plan.id, m.userId, { timedOut: true });
      await this.offerTimesToOrganizer(plan);
      return;
    }
    const startedAt = new Date(plan.roundStartedAt ?? plan.updatedAt);
    for (const m of unanswered) {
      if (reminderDue(m, startedAt, deadline, now) === null) continue;
      const user = await this.repo.getUser(m.userId);
      if (!user) continue;
      await this.sayDirect(user.address, {
        kind: "availability_reminder",
        name: user.name,
        activity: plan.request.activity,
        deadlineLabel: formatDeadline(deadline, plan.timezone),
      });
      await this.repo.updateMember(plan.id, m.userId, { remindersSent: m.remindersSent + 1, lastRemindedAt: now.toISOString() });
    }
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private async notifyTimedOut(plan: Plan, members: PlanMember[], slotLabel: string | null) {
    for (const m of members.filter((m) => m.timedOut)) {
      const user = await this.repo.getUser(m.userId);
      if (user) {
        await this.sayDirect(user.address, {
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
   * DMs are best-effort: a failed calendar link or reminder (e.g. a network
   * rejecting the recipient) must not break the plan. Returns null when it fails.
   */
  private async sayDirect(address: string, message: BotMessage) {
    try {
      return await this.messenger.sendDirect(address, await this.brain.compose(message));
    } catch (err) {
      console.error(`[coordinator] direct message to ${address} failed:`, err);
      return null;
    }
  }
}

/** Whether the plan is still waiting on this member. Optional members and people who can't be reached aren't waited for. */
const isAwaitedAnswer = (m: PlanMember) => m.role === "essential" && !m.timedOut && m.statedAvailability === null;

/** The person's name, or the end of their phone number on networks that use one. */
function displayName(user: User): string {
  if (user.name) return user.name;
  return /^\+?\d{4,}$/.test(localPart(user.address)) ? `…${user.address.slice(-4)}` : "someone";
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const titleCase = (name: string) => name.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

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
