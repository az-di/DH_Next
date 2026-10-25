import { config } from "../config.ts";

function mentionRegex(botName: string): RegExp {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)@${escaped}\\b[,:]?`, "i");
}

/** True when the message addresses the bot, e.g. "@planner dinner next weekend". */
export function isMentioned(text: string, botName = config.botName): boolean {
  return mentionRegex(botName).test(text);
}

/** Removes the @mention so only the request text remains. */
export function stripMention(text: string, botName = config.botName): string {
  return text.replace(mentionRegex(botName), " ").replace(/\s+/g, " ").trim();
}
