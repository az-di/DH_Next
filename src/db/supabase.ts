import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Repo } from "./repo.ts";
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

// Row <-> domain mappers. Postgres columns are snake_case.

type Row = Record<string, any>;

const toUser = (r: Row): User => ({
  id: r.id,
  phone: r.phone,
  name: r.name,
  timezone: r.timezone,
  createdAt: r.created_at,
});

const toConnection = (r: Row): CalendarConnection => ({
  id: r.id,
  userId: r.user_id,
  provider: r.provider,
  refreshToken: r.refresh_token,
  accessToken: r.access_token,
  accessTokenExpiresAt: r.access_token_expires_at,
  createdAt: r.created_at,
});

const toPlan = (r: Row): Plan => ({
  id: r.id,
  groupId: r.group_id,
  organizerId: r.organizer_id,
  status: r.status,
  round: r.round,
  request: r.request,
  rawRequest: r.raw_request,
  timezone: r.timezone,
  deadline: r.deadline,
  lockedSlotId: r.locked_slot_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const fromPlan = (p: Partial<Plan>): Row =>
  dropUndefined({
    group_id: p.groupId,
    organizer_id: p.organizerId,
    status: p.status,
    round: p.round,
    request: p.request,
    raw_request: p.rawRequest,
    timezone: p.timezone,
    deadline: p.deadline,
    locked_slot_id: p.lockedSlotId,
  });

const toMember = (r: Row): PlanMember => ({
  planId: r.plan_id,
  userId: r.user_id,
  role: r.role,
  remindersSent: r.reminders_sent,
  lastRemindedAt: r.last_reminded_at,
  timedOut: r.timed_out,
});

const toSlot = (r: Row): CandidateSlot => ({
  id: r.id,
  planId: r.plan_id,
  round: r.round,
  optionNumber: r.option_number,
  start: r.start_at,
  end: r.end_at,
  score: r.score,
});

const toResponse = (r: Row): Response => ({
  id: r.id,
  planId: r.plan_id,
  slotId: r.slot_id,
  userId: r.user_id,
  vote: r.vote,
  createdAt: r.created_at,
});

function dropUndefined(row: Row): Row {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
}

/** Unwraps a Supabase result, throwing on error. Returns `any` because rows are mapped right after. */
function must(result: { data: unknown; error: { message: string } | null }): any {
  if (result.error) throw new Error(`supabase: ${result.error.message}`);
  return result.data;
}

export class SupabaseRepo implements Repo {
  private db: SupabaseClient;

  constructor(url: string, serviceRoleKey: string) {
    this.db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  }

  async upsertUserByPhone(phone: string, patch: Partial<Pick<User, "name" | "timezone">> = {}) {
    const row = dropUndefined({ phone, name: patch.name, timezone: patch.timezone });
    const data = must(
      await this.db.from("users").upsert(row, { onConflict: "phone" }).select().single(),
    );
    return toUser(data);
  }

  async getUser(id: string) {
    const data = must(await this.db.from("users").select().eq("id", id).maybeSingle());
    return data ? toUser(data) : null;
  }

  async saveCalendarConnection(conn: Omit<CalendarConnection, "id" | "createdAt">) {
    const data = must(
      await this.db
        .from("calendar_connections")
        .upsert(
          {
            user_id: conn.userId,
            provider: conn.provider,
            refresh_token: conn.refreshToken,
            access_token: conn.accessToken,
            access_token_expires_at: conn.accessTokenExpiresAt,
          },
          { onConflict: "user_id,provider" },
        )
        .select()
        .single(),
    );
    return toConnection(data);
  }

  async getCalendarConnection(userId: string) {
    const data = must(
      await this.db.from("calendar_connections").select().eq("user_id", userId).maybeSingle(),
    );
    return data ? toConnection(data) : null;
  }

  async createPlan(plan: Omit<Plan, "id" | "createdAt" | "updatedAt">) {
    const data = must(await this.db.from("plans").insert(fromPlan(plan)).select().single());
    return toPlan(data);
  }

  async updatePlan(id: string, patch: Partial<Plan>) {
    const data = must(
      await this.db
        .from("plans")
        .update({ ...fromPlan(patch), updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single(),
    );
    return toPlan(data);
  }

  async getPlan(id: string) {
    const data = must(await this.db.from("plans").select().eq("id", id).maybeSingle());
    return data ? toPlan(data) : null;
  }

  async getOpenPlanForGroup(groupId: string) {
    const data = must(
      await this.db
        .from("plans")
        .select()
        .eq("group_id", groupId)
        .in("status", ["collecting", "proposed"])
        .maybeSingle(),
    );
    return data ? toPlan(data) : null;
  }

  async listOpenPlans() {
    const data = must(
      await this.db.from("plans").select().in("status", ["collecting", "proposed"]),
    );
    return (data as Row[]).map(toPlan);
  }

  async addMember(planId: string, userId: string, role: MemberRole = "essential") {
    const data = must(
      await this.db
        .from("plan_members")
        .upsert({ plan_id: planId, user_id: userId, role }, { onConflict: "plan_id,user_id", ignoreDuplicates: false })
        .select()
        .single(),
    );
    return toMember(data);
  }

  async updateMember(planId: string, userId: string, patch: Partial<PlanMember>) {
    const row = dropUndefined({
      role: patch.role,
      reminders_sent: patch.remindersSent,
      last_reminded_at: patch.lastRemindedAt,
      timed_out: patch.timedOut,
    });
    const data = must(
      await this.db
        .from("plan_members")
        .update(row)
        .eq("plan_id", planId)
        .eq("user_id", userId)
        .select()
        .single(),
    );
    return toMember(data);
  }

  async listMembers(planId: string) {
    const data = must(await this.db.from("plan_members").select().eq("plan_id", planId));
    return (data as Row[]).map(toMember);
  }

  async addSlots(slots: Omit<CandidateSlot, "id">[]) {
    if (slots.length === 0) return [];
    const rows = slots.map((s) => ({
      plan_id: s.planId,
      round: s.round,
      option_number: s.optionNumber,
      start_at: s.start,
      end_at: s.end,
      score: s.score,
    }));
    const data = must(await this.db.from("candidate_slots").insert(rows).select());
    return (data as Row[]).map(toSlot);
  }

  async listSlots(planId: string, round?: number) {
    let query = this.db.from("candidate_slots").select().eq("plan_id", planId);
    if (round !== undefined) query = query.eq("round", round);
    const data = must(await query.order("round").order("option_number"));
    return (data as Row[]).map(toSlot);
  }

  async recordVote(planId: string, slotId: string, userId: string, vote: Vote) {
    const data = must(
      await this.db
        .from("responses")
        .upsert(
          { plan_id: planId, slot_id: slotId, user_id: userId, vote, created_at: new Date().toISOString() },
          { onConflict: "slot_id,user_id" },
        )
        .select()
        .single(),
    );
    return toResponse(data);
  }

  async listResponses(planId: string) {
    const data = must(await this.db.from("responses").select().eq("plan_id", planId));
    return (data as Row[]).map(toResponse);
  }

  async linkProposalMessage(messageId: string, planId: string, slotId: string) {
    must(
      await this.db
        .from("proposal_messages")
        .upsert({ message_id: messageId, plan_id: planId, slot_id: slotId }),
    );
  }

  async getProposalMessage(messageId: string) {
    const data = must(
      await this.db.from("proposal_messages").select().eq("message_id", messageId).maybeSingle(),
    );
    return data ? { planId: (data as Row).plan_id, slotId: (data as Row).slot_id } : null;
  }
}
