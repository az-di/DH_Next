import type {
  CalendarConnection,
  CandidateSlot,
  MemberRole,
  Plan,
  PlanMember,
  Preferences,
  Response,
  User,
  Vote,
} from "../types.ts";

/**
 * Storage contract shared by the Supabase store (production) and the in-memory
 * store (tests and local dev without credentials). Keep it small: the
 * coordinator owns the logic, the repo only reads and writes rows.
 */
export interface Repo {
  // users
  upsertUserByPhone(phone: string, patch?: Partial<Pick<User, "name" | "timezone">>): Promise<User>;
  getUser(id: string): Promise<User | null>;

  // calendar connections
  saveCalendarConnection(
    conn: Omit<CalendarConnection, "id" | "createdAt">,
  ): Promise<CalendarConnection>;
  getCalendarConnection(userId: string): Promise<CalendarConnection | null>;

  // manual preferences
  getPreferences(userId: string): Promise<Preferences | null>;
  savePreferences(userId: string, prefs: Preferences): Promise<Preferences>;

  // plans
  createPlan(plan: Omit<Plan, "id" | "createdAt" | "updatedAt">): Promise<Plan>;
  updatePlan(id: string, patch: Partial<Plan>): Promise<Plan>;
  getPlan(id: string): Promise<Plan | null>;
  getOpenPlanForGroup(groupId: string): Promise<Plan | null>;
  listOpenPlans(): Promise<Plan[]>;

  // members
  addMember(planId: string, userId: string, role?: MemberRole): Promise<PlanMember>;
  updateMember(planId: string, userId: string, patch: Partial<PlanMember>): Promise<PlanMember>;
  listMembers(planId: string): Promise<PlanMember[]>;

  // slots
  addSlots(slots: Omit<CandidateSlot, "id">[]): Promise<CandidateSlot[]>;
  listSlots(planId: string, round?: number): Promise<CandidateSlot[]>;

  // responses
  recordVote(planId: string, slotId: string, userId: string, vote: Vote): Promise<Response>;
  listResponses(planId: string): Promise<Response[]>;

  // proposal message → slot (for tapbacks)
  linkProposalMessage(messageId: string, planId: string, slotId: string): Promise<void>;
  getProposalMessage(messageId: string): Promise<{ planId: string; slotId: string } | null>;
}
