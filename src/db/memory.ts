import { randomUUID } from "node:crypto";
import type { Repo } from "./repo.ts";
import { OPEN_STATUSES } from "../types.ts";
import type {
  CalendarConnection,
  CandidateSlot,
  MemberRole,
  Plan,
  PlanMember,
  Response,
  User,
  Vote,
} from "../types.ts";

const now = () => new Date().toISOString();

/** In-memory Repo. Used by tests and when Supabase isn't configured. */
export class MemoryRepo implements Repo {
  users = new Map<string, User>();
  connections = new Map<string, CalendarConnection>(); // by userId
  plans = new Map<string, Plan>();
  members: PlanMember[] = [];
  slots: CandidateSlot[] = [];
  responses: Response[] = [];
  proposalMessages = new Map<string, { planId: string; slotId: string }>();

  async upsertUserByPhone(phone: string, patch: Partial<Pick<User, "name" | "timezone">> = {}) {
    const existing = [...this.users.values()].find((u) => u.phone === phone);
    if (existing) {
      Object.assign(existing, stripUndefined(patch));
      return existing;
    }
    const user: User = {
      id: randomUUID(),
      phone,
      name: patch.name ?? null,
      timezone: patch.timezone ?? null,
      createdAt: now(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async getUser(id: string) {
    return this.users.get(id) ?? null;
  }

  async saveCalendarConnection(conn: Omit<CalendarConnection, "id" | "createdAt">) {
    const saved: CalendarConnection = {
      id: this.connections.get(conn.userId)?.id ?? randomUUID(),
      createdAt: now(),
      ...conn,
    };
    this.connections.set(conn.userId, saved);
    return saved;
  }

  async getCalendarConnection(userId: string) {
    return this.connections.get(userId) ?? null;
  }

  async createPlan(plan: Omit<Plan, "id" | "createdAt" | "updatedAt">) {
    const created: Plan = { ...plan, id: randomUUID(), createdAt: now(), updatedAt: now() };
    this.plans.set(created.id, created);
    return created;
  }

  async updatePlan(id: string, patch: Partial<Plan>) {
    const plan = this.plans.get(id);
    if (!plan) throw new Error(`plan ${id} not found`);
    Object.assign(plan, stripUndefined(patch), { updatedAt: now() });
    return plan;
  }

  async getPlan(id: string) {
    return this.plans.get(id) ?? null;
  }

  async getOpenPlanForGroup(groupId: string) {
    return (
      [...this.plans.values()].find(
        (p) => p.groupId === groupId && OPEN_STATUSES.includes(p.status),
      ) ?? null
    );
  }

  async listOpenPlans() {
    return [...this.plans.values()].filter(
      (p) => OPEN_STATUSES.includes(p.status),
    );
  }

  async addMember(planId: string, userId: string, role: MemberRole = "essential") {
    const existing = this.members.find((m) => m.planId === planId && m.userId === userId);
    if (existing) return existing;
    const member: PlanMember = {
      planId,
      userId,
      role,
      remindersSent: 0,
      lastRemindedAt: null,
      timedOut: false,
      nudgedRound: null,
    };
    this.members.push(member);
    return member;
  }

  async updateMember(planId: string, userId: string, patch: Partial<PlanMember>) {
    const member = this.members.find((m) => m.planId === planId && m.userId === userId);
    if (!member) throw new Error(`member ${userId} not in plan ${planId}`);
    Object.assign(member, stripUndefined(patch));
    return member;
  }

  async listMembers(planId: string) {
    return this.members.filter((m) => m.planId === planId);
  }

  async addSlots(slots: Omit<CandidateSlot, "id">[]) {
    const created = slots.map((s) => ({ ...s, id: randomUUID() }));
    this.slots.push(...created);
    return created;
  }

  async listSlots(planId: string, round?: number) {
    return this.slots
      .filter((s) => s.planId === planId && (round === undefined || s.round === round))
      .sort((a, b) => a.round - b.round || a.optionNumber - b.optionNumber);
  }

  async recordVote(planId: string, slotId: string, userId: string, vote: Vote) {
    const existing = this.responses.find((r) => r.slotId === slotId && r.userId === userId);
    if (existing) {
      existing.vote = vote;
      existing.createdAt = now();
      return existing;
    }
    const response: Response = { id: randomUUID(), planId, slotId, userId, vote, createdAt: now() };
    this.responses.push(response);
    return response;
  }

  async listResponses(planId: string) {
    return this.responses.filter((r) => r.planId === planId);
  }

  async linkProposalMessage(messageId: string, planId: string, slotId: string) {
    this.proposalMessages.set(messageId, { planId, slotId });
  }

  async getProposalMessage(messageId: string) {
    return this.proposalMessages.get(messageId) ?? null;
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
