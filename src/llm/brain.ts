import type { RoleStatement } from "../plans/roles.ts";
import type { MemberRole, ParsedRequest, PreferenceUpdate } from "../types.ts";

// The coordinator's interface to language: turning a request into structure,
// and structure into friendly text. Claude implements it; templates + rules
// are the always-available fallback.
//
// Option bubbles ("Option 1: Sat Nov 7, 7:00–9:00 PM") are NOT written by the
// LLM. They're formatted deterministically so votes can be parsed back.

export interface SlotView {
  optionNumber: number;
  label: string; // pre-formatted local time range
}

export type BotMessage =
  | { kind: "ack"; activity: string; windowLabel: string; unconnectedNames: string[]; optionalNames?: string[] }
  | { kind: "connect_calendar"; name: string | null; url: string; activity: string }
  | {
      kind: "proposal";
      activity: string;
      round: number;
      options: SlotView[];
      deadlineLabel: string;
      /** Why there are several options, e.g. "a few calendars aren't connected". */
      reason: "confident" | "uncertain" | "after_no";
    }
  | { kind: "reminder"; name: string | null; activity: string; deadlineLabel: string; remaining: number }
  | {
      kind: "nudge";
      name: string | null;
      activity: string;
      optionNumber: number;
      slotLabel: string;
      deadlineLabel: string;
    }
  | { kind: "locked"; activity: string; slotLabel: string; maybeNames: string[]; missingNames: string[] }
  | { kind: "timed_out"; name: string | null; activity: string; slotLabel: string | null }
  | { kind: "organizer_pick"; activity: string; options: (SlotView & { yes: number; maybe: number })[] }
  | { kind: "failed"; activity: string }
  | { kind: "parse_failed" }
  | { kind: "dm_help" }
  | { kind: "already_open"; activity: string }
  | { kind: "roles_set"; changes: { name: string; role: MemberRole }[] }
  /** One question covering every name the bot couldn't match. */
  | { kind: "role_question"; unknown: string[]; ambiguous: { name: string; options: string[] }[] }
  | { kind: "name_saved"; name: string; role: MemberRole | null; activity: string | null }
  | { kind: "organizer_only"; organizerName: string }
  /** `summary` is describeUpdate() of what was saved, e.g. "never mornings, prefers evenings". */
  | { kind: "preferences_saved"; name: string; summary: string }
  /** A one-off "I can't do Saturday": the options it turned into a "no" (maybe none). */
  | { kind: "constraint_noted"; name: string; optionNumbers: number[] }
  | { kind: "nothing_scheduled" };

/** What an @mention is, with the fields for that kind. */
export type Interpretation =
  /** "dinner next weekend", possibly with "Sam is optional" inline. */
  | { kind: "request"; request: ParsedRequest; roles: RoleStatement[] }
  /** "Sam is optional" on its own. */
  | { kind: "roles"; roles: RoleStatement[] }
  /** "I don't do mornings": the sender's standing schedule. */
  | { kind: "preference"; update: PreferenceUpdate }
  /** "I can't do this Saturday": windows (UTC ISO) that don't work, for the open plan only. */
  | { kind: "constraint"; windows: { start: string; end: string }[] }
  | { kind: "other" };

export interface Brain {
  /** One parse per @mention (the mention itself already stripped). */
  interpret(text: string, opts: { now: Date; timezone: string }): Promise<Interpretation>;
  compose(message: BotMessage): Promise<string>;
}
