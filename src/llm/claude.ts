import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { normalizeBlock } from "../plans/preferences.ts";
import type { RoleStatement } from "../plans/roles.ts";
import type { ParsedRequest, PreferenceUpdate, WeeklyBlock } from "../types.ts";
import { zonedTimeToUtc } from "../time.ts";
import type { BotMessage, Brain, Interpretation } from "./brain.ts";
import { interpretWithRules } from "./interpret.ts";
import { ACTIVITY_DEFAULTS } from "./rules.ts";
import { renderTemplate } from "./templates.ts";

const MODEL = "claude-opus-5-5";

// Server-side refusal fallback: if the model declines for policy reasons the
// API retries on its default fallback model inside the same call.
const fallback = () => ({
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
});

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const Day = z.enum(DAYS);

// One structured call per @mention: what kind of message it is, plus the
// fields for that kind. Fields for other kinds come back null/empty.
const InterpretSchema = z.object({
  kind: z.enum(["new_request", "role_change", "preference", "one_off_constraint", "other"]),
  request: z
    .object({
      activity: z.string().describe("Short lowercase noun phrase, e.g. 'dinner', 'board games', 'a hike'."),
      window_start_local: z.string().describe("Earliest acceptable start, local wall time 'YYYY-MM-DDTHH:mm'."),
      window_end_local: z.string().describe("Latest acceptable end, local wall time 'YYYY-MM-DDTHH:mm'."),
      duration_minutes: z.number().int(),
      preferred_start_hour: z
        .number()
        .int()
        .nullable()
        .describe("Earliest local start hour (0-23): the time the message asks for, else when the activity usually starts. Null if neither."),
      preferred_end_hour: z
        .number()
        .int()
        .nullable()
        .describe("Local hour it must end by: asked-for start + duration (may pass 24 after midnight), else when the activity usually ends. Null if neither."),
      time_requested: z.boolean().describe("True only if the message names a specific time or part of day."),
    })
    .nullable()
    .describe("new_request only."),
  roles: z
    .array(
      z.object({
        names: z
          .array(z.string())
          .describe("Each person exactly as written, e.g. 'Sam' or 'Sam P'. Use 'me' when the sender means themselves."),
        role: z.enum(["optional", "required"]),
      }),
    )
    .describe("role_change, or role statements inside a new_request. Empty otherwise."),
  preference: z
    .object({
      preferred_times: z.array(z.enum(["morning", "afternoon", "evening", "night"])),
      preferred_days: z.array(Day),
      never: z
        .array(
          z.object({
            days: z.array(Day).describe("Empty means every day."),
            from_hour: z.number().describe("Local hour (0-24) the window that never works starts."),
            to_hour: z.number().describe("Local hour (0-24) it ends; 24 is midnight."),
          }),
        )
        .describe("Times that never work for them."),
      clear_existing: z.boolean().describe("True if they ask to forget or reset their saved preferences."),
    })
    .nullable()
    .describe("preference only."),
  constraint_windows: z
    .array(
      z.object({
        start_local: z.string().describe("Local wall time 'YYYY-MM-DDTHH:mm'."),
        end_local: z.string().describe("Local wall time 'YYYY-MM-DDTHH:mm'; use T24:00 for midnight."),
      }),
    )
    .describe("one_off_constraint only: the specific times that don't work. Empty otherwise."),
});

const INTERPRET_SYSTEM = `You read a message someone sent to a group-chat planning bot (the @mention is already removed) and say what kind of message it is, filling in only the fields for that kind.

Kinds:
- new_request: asks to plan something ("dinner next weekend", "drinks friday at 9"). Fill request, plus roles if it also says who's optional or required ("dinner friday, Sam is optional").
- role_change: only says whether specific people need to be there. Optional: "Sam is optional", "we don't need Priya", "I might not make it, don't wait for me" (the sender: "me"). Required: "Sam has to be there", "make sure Jordan can come". Only people named in the message or the sender; never invent names; ignore things that aren't people ("RSVP is optional").
- preference: the sender's own recurring schedule. "never" holds times that don't work at all ("I don't do mornings" = every day 5-12, "not before 10" = every day 0-10, "nothing after 9pm" = every day 21-24, "no Sunday nights" = Sunday 21-24). preferred_times/preferred_days are soft likes ("I prefer evenings", "weekends only"; "only" is a strong like, not a never). Parts of day: morning 5-12, afternoon 12-17, evening 17-21, night 21-24.
- one_off_constraint: the sender can't make specific dates or times ("I can't do this Saturday", "tomorrow morning is bad", "I'm out Friday night"). Give the concrete local windows.
- other: anything else, including a bare name or a greeting.

For requests: interpret relative dates against the current local date and time you are given. Give the whole window people would consider, not a single time: for "dinner Saturday" the window is that Saturday from 00:00 to 24:00 and the preferred hours capture "dinner". Times outside the preferred hours are never proposed. Use the activity's usual hours (dinner 17-22, lunch 11-14, coffee 8-17), unless the message asks for a time or part of day ("dinner at 4", "brunch in the afternoon"): then set the preferred hours to cover exactly that and time_requested to true. If that time runs past midnight, extend the window end to cover it. Duration: what the activity typically takes (dinner ~120, coffee ~60, a hike ~180) unless the message says otherwise. If no time frame is given, use the next 7 days. Never start the window in the past.`;

const COMPOSE_SYSTEM = `You write short messages for a friendly planning bot in an iMessage group chat.

Rules:
- One or two short sentences, casual and warm, at most one emoji.
- Keep every fact from the draft exactly: names, times, dates, deadlines, URLs, and voting instructions (👍 yes, 👎 no, ❓ maybe; reply with numbers).
- Don't add facts, options, or times that aren't in the draft.
- If the draft says the last options didn't work, keep that acknowledgement (a short clause is enough).
- Output only the message text.`;

/** Wall-clock "YYYY-MM-DDTHH:mm" in `timezone` → UTC ISO string. */
function localToIso(local: string, timezone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  return zonedTimeToUtc(y, mo, d, h, timezone, mi).toISOString();
}

type Interpreted = z.infer<typeof InterpretSchema>;

function toRequest(out: NonNullable<Interpreted["request"]>, opts: { now: Date; timezone: string }): ParsedRequest | null {
  const windowStart = localToIso(out.window_start_local, opts.timezone);
  const windowEnd = localToIso(out.window_end_local, opts.timezone);
  if (!windowStart || !windowEnd || windowEnd <= windowStart) return null;
  const defaults = ACTIVITY_DEFAULTS[out.activity];
  return {
    activity: out.activity,
    windowStart: new Date(Math.max(Date.parse(windowStart), opts.now.getTime())).toISOString(),
    windowEnd,
    durationMinutes: clamp(out.duration_minutes || defaults?.durationMinutes || 90, 15, 12 * 60),
    preferredStartHour: out.preferred_start_hour,
    preferredEndHour: out.preferred_end_hour,
    ...(out.time_requested && { timeRequested: true }),
  };
}

function toRoles(out: Interpreted["roles"]): RoleStatement[] {
  return out
    .map((s) => ({
      names: s.names.map((n) => n.trim()).filter((n) => n.length > 0 && n.length <= 40),
      role: s.role === "optional" ? ("optional" as const) : ("essential" as const),
    }))
    .filter((s) => s.names.length > 0);
}

function toPreferenceUpdate(out: NonNullable<Interpreted["preference"]>): PreferenceUpdate | null {
  const dayIndex = (days: readonly (typeof DAYS)[number][]) => days.map((d) => DAYS.indexOf(d));
  const never = out.never
    .map((b) => normalizeBlock({ days: b.days.length ? dayIndex(b.days) : [0, 1, 2, 3, 4, 5, 6], from: b.from_hour, to: b.to_hour }))
    .filter((b): b is WeeklyBlock => b !== null);
  const update: PreferenceUpdate = {};
  if (out.clear_existing) update.clear = true;
  if (never.length) update.never = never;
  if (out.preferred_times.length) update.preferredTimes = [...new Set(out.preferred_times)];
  if (out.preferred_days.length) update.preferredDays = [...new Set(dayIndex(out.preferred_days))].sort();
  return Object.keys(update).length ? update : null;
}

/** Claude's answer as an Interpretation, or null when it's unusable (then the rules' reading stands). */
function toInterpretation(out: Interpreted, opts: { now: Date; timezone: string }): Interpretation | null {
  switch (out.kind) {
    case "new_request": {
      const request = out.request && toRequest(out.request, opts);
      return request ? { kind: "request", request, roles: toRoles(out.roles) } : null;
    }
    case "role_change": {
      const roles = toRoles(out.roles);
      return roles.length ? { kind: "roles", roles } : null;
    }
    case "preference": {
      const update = out.preference && toPreferenceUpdate(out.preference);
      return update ? { kind: "preference", update } : null;
    }
    case "one_off_constraint": {
      const windows = out.constraint_windows.flatMap((w) => {
        const start = localToIso(w.start_local, opts.timezone);
        const end = localToIso(w.end_local, opts.timezone);
        return start && end && start < end ? [{ start, end }] : [];
      });
      return windows.length ? { kind: "constraint", windows } : null;
    }
    case "other":
      return { kind: "other" };
  }
}

export class ClaudeBrain implements Brain {
  private client: Anthropic;

  constructor(client = new Anthropic()) {
    this.client = client;
  }

  /** Rules first; Claude only when they aren't confident; the rules' reading on any failure. */
  async interpret(text: string, opts: { now: Date; timezone: string }): Promise<Interpretation> {
    const rules = interpretWithRules(text, opts);
    if (rules.confident) return rules.result;

    const nowLocal = new Intl.DateTimeFormat("en-US", {
      timeZone: opts.timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(opts.now);
    try {
      const response = await this.client.beta.messages.parse({
        model: MODEL,
        max_tokens: 4000,
        ...fallback(),
        system: INTERPRET_SYSTEM,
        output_config: { effort: "low", format: betaZodOutputFormat(InterpretSchema) },
        messages: [
          {
            role: "user",
            content: `Current local time: ${nowLocal} (${opts.timezone}).\n\nMessage: ${text}`,
          },
        ],
      });
      if (response.stop_reason === "refusal" || !response.parsed_output) return rules.result;
      return toInterpretation(response.parsed_output, opts) ?? rules.result;
    } catch (err) {
      console.error("[claude] interpret failed, using rules:", err);
      return rules.result;
    }
  }

  async compose(message: BotMessage): Promise<string> {
    const draft = renderTemplate(message);
    // Structured lists and exact reply formats must stay as written; only rephrase prose.
    // The preferences confirmation states exactly what was saved, so it isn't reworded either.
    if (message.kind === "organizer_pick" || message.kind === "role_question" || message.kind === "preferences_saved") {
      return draft;
    }

    try {
      const response = await this.client.beta.messages.create({
        model: MODEL,
        max_tokens: 2000,
        ...fallback(),
        system: COMPOSE_SYSTEM,
        output_config: { effort: "low" },
        messages: [{ role: "user", content: `Rewrite this draft:\n\n${draft}` }],
      });
      if (response.stop_reason === "refusal") return draft;
      const text = response.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("")
        .trim();
      return text && keepsFacts(draft, text) ? text : draft;
    } catch (err) {
      console.error("[claude] compose failed, using template:", err);
      return draft;
    }
  }
}

/** Guard against a rewrite dropping a URL or an "Option N"/time token from the draft. */
function keepsFacts(draft: string, rewrite: string): boolean {
  const mustKeep = draft.match(/https?:\/\/\S+|\d{1,2}:\d{2}/g) ?? [];
  return mustKeep.every((token) => rewrite.includes(token.replace(/[.,!?)]+$/, "")));
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
