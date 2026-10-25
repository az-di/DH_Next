import { hasAnthropic } from "../config.ts";
import type { Brain } from "./brain.ts";
import { ClaudeBrain } from "./claude.ts";
import { parseRequestWithRules } from "./rules.ts";
import { renderTemplate } from "./templates.ts";

/** Rules + templates only: deterministic, free, and used in tests. */
export class TemplateBrain implements Brain {
  async parseRequest(text: string, opts: { now: Date; timezone: string }) {
    return parseRequestWithRules(text, opts);
  }

  async compose(message: Parameters<Brain["compose"]>[0]) {
    return renderTemplate(message);
  }
}

export function createBrain(): Brain {
  if (hasAnthropic()) return new ClaudeBrain();
  console.warn("[llm] ANTHROPIC_API_KEY not set — using rule-based parsing and template messages");
  return new TemplateBrain();
}

export type { Brain, BotMessage, SlotView } from "./brain.ts";
export { formatOption } from "./templates.ts";
