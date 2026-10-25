// Shared domain types. Field names mirror the Postgres columns in
// supabase/migrations/001_init.sql (snake_case there, camelCase here).

export type PlanStatus = "collecting" | "proposed" | "locked" | "failed";

export type Vote = "yes" | "no" | "maybe";

export type MemberRole = "essential" | "optional";

export interface User {
  id: string;
  phone: string; // E.164, the primary key we get from Sendblue
  name: string | null;
  timezone: string | null;
  createdAt: string;
}

export interface CalendarConnection {
  id: string;
  userId: string;
  provider: "google";
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  createdAt: string;
}

/** What the LLM (or the rule-based fallback) extracts from "dinner sometime next weekend". */
export interface ParsedRequest {
  activity: string;
  windowStart: string; // ISO
  windowEnd: string; // ISO
  durationMinutes: number;
  /** Preferred local hours, e.g. dinner → 17–22. Used for scoring, not filtering. */
  preferredStartHour: number | null;
  preferredEndHour: number | null;
}

export interface Plan {
  id: string;
  groupId: string; // Sendblue group id
  organizerId: string;
  status: PlanStatus;
  round: number; // 1..MAX_ROUNDS
  request: ParsedRequest;
  rawRequest: string;
  timezone: string;
  deadline: string | null; // response deadline for the current round
  lockedSlotId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanMember {
  planId: string;
  userId: string;
  role: MemberRole;
  remindersSent: number;
  lastRemindedAt: string | null;
  /** Set when the deadline passes without a reply; they are notified of the outcome and no longer block quorum. */
  timedOut: boolean;
}

export interface CandidateSlot {
  id: string;
  planId: string;
  round: number;
  optionNumber: number; // 1-based, what people reply with
  start: string;
  end: string;
  score: number;
}

export interface Response {
  id: string;
  planId: string;
  slotId: string;
  userId: string;
  vote: Vote;
  createdAt: string;
}

/** A busy interval for one person. We never store or read event titles. */
export interface BusyBlock {
  start: Date;
  end: Date;
}
