import type { ParsedRequest } from "../types.ts";

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
  | { kind: "ack"; activity: string; windowLabel: string; unconnectedNames: string[] }
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
  | { kind: "locked"; activity: string; slotLabel: string; maybeNames: string[]; missingNames: string[] }
  | { kind: "timed_out"; name: string | null; activity: string; slotLabel: string | null }
  | { kind: "organizer_pick"; activity: string; options: (SlotView & { yes: number; maybe: number })[] }
  | { kind: "failed"; activity: string }
  | { kind: "parse_failed" }
  | { kind: "dm_help" }
  | { kind: "already_open"; activity: string };

export interface Brain {
  parseRequest(text: string, opts: { now: Date; timezone: string }): Promise<ParsedRequest | null>;
  compose(message: BotMessage): Promise<string>;
}
