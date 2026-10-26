import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ParsedRequest } from "../types.ts";
import { zonedTimeToUtc } from "../time.ts";
import type { BotMessage, Brain } from "./brain.ts";
import { ACTIVITY_DEFAULTS, parseRequestWithRules } from "./rules.ts";
import { renderTemplate } from "./templates.ts";

const MODEL = "claude-opus-5-5";

// Server-side refusal fallback: if the model declines for policy reasons the
// API retries on its default fallback model inside the same call.
const fallback = () => ({
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
});

const RequestSchema = z.object({
  is_planning_request: z
    .boolean()
    .describe("False if the message isn't asking to plan something (e.g. just 'hi')."),
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
});

const PARSE_SYSTEM = `You turn a casual group-chat request into a scheduling window for a planning bot.

Interpret relative dates ("next weekend", "Friday", "sometime this week") against the current local date and time you are given. Give the whole window people would consider, not a single time: for "dinner Saturday" the window is that Saturday from 00:00 to 24:00 and the preferred hours capture "dinner".

Times outside the preferred hours are never proposed. Use the activity's usual hours (dinner 17-22, lunch 11-14, coffee 8-17), unless the message asks for a time or part of day ("dinner at 4", "brunch in the afternoon"): then set the preferred hours to cover exactly that and time_requested to true. If that time runs past midnight, extend the window end to cover it.

Duration: use what the activity typically takes (dinner ~120, coffee ~60, a hike ~180) unless the message says otherwise. If no time frame is given, use the next 7 days. Never start the window in the past.`;

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

export class ClaudeBrain implements Brain {
  private client: Anthropic;

  constructor(client = new Anthropic()) {
    this.client = client;
  }

  async parseRequest(text: string, opts: { now: Date; timezone: string }): Promise<ParsedRequest | null> {
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
        system: PARSE_SYSTEM,
        output_config: { effort: "low", format: betaZodOutputFormat(RequestSchema) },
        messages: [
          {
            role: "user",
            content: `Current local time: ${nowLocal} (${opts.timezone}).\n\nMessage: ${text}`,
          },
        ],
      });

      if (response.stop_reason === "refusal" || !response.parsed_output) {
        return parseRequestWithRules(text, opts);
      }
      const out = response.parsed_output;
      if (!out.is_planning_request) return null;

      const windowStart = localToIso(out.window_start_local, opts.timezone);
      const windowEnd = localToIso(out.window_end_local, opts.timezone);
      if (!windowStart || !windowEnd || windowEnd <= windowStart) return parseRequestWithRules(text, opts);

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
    } catch (err) {
      console.error("[claude] parseRequest failed, using rules:", err);
      return parseRequestWithRules(text, opts);
    }
  }

  async compose(message: BotMessage): Promise<string> {
    const draft = renderTemplate(message);
    // Structured lists and exact reply formats must stay as written; only rephrase prose.
    if (message.kind === "organizer_pick" || message.kind === "role_question") return draft;

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
