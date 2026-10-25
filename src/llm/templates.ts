import type { BotMessage } from "./brain.ts";

// Deterministic copy for every bot message. Used directly when Claude isn't
// configured, and as the fallback when a Claude call fails.

const list = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export function renderTemplate(m: BotMessage): string {
  switch (m.kind) {
    case "ack":
      return m.unconnectedNames.length
        ? `On it! Looking for ${m.activity} times ${m.windowLabel}. ${list(m.unconnectedNames)}, I sent you a link to connect your calendar, which makes this faster.`
        : `On it! Looking for ${m.activity} times ${m.windowLabel}.`;
    case "connect_calendar":
      return `Hi${m.name ? ` ${m.name}` : ""}! Your group is planning ${m.activity}. Connect your calendar so I can skip times you're busy (I only see free/busy, never event details): ${m.url}`;
    case "proposal": {
      const intro =
        m.options.length === 1
          ? `How about this for ${m.activity}? 👍 yes, 👎 no, ❓ maybe.`
          : m.reason === "after_no"
            ? `That one didn't work, so here are ${m.options.length} more for ${m.activity}. Tap 👍/👎/❓ on each, or reply with the numbers that work.`
            : `A few options for ${m.activity}. Tap 👍/👎/❓ on each, or reply with the numbers that work (e.g. "1 3").`;
      return `${intro} Please answer by ${m.deadlineLabel}.`;
    }
    case "reminder":
      return `Hey${m.name ? ` ${m.name}` : ""}, quick reminder to vote on ${m.activity} times in the group chat. Closes ${m.deadlineLabel}.`;
    case "locked": {
      let text = `🎉 Locked in: ${m.activity}, ${m.slotLabel}.`;
      if (m.maybeNames.length) text += ` ${list(m.maybeNames)} said maybe.`;
      if (m.missingNames.length) text += ` Didn't hear from ${list(m.missingNames)}.`;
      return text;
    }
    case "timed_out":
      return m.slotLabel
        ? `Your group went ahead and picked ${m.slotLabel} for ${m.activity}. Hope you can make it!`
        : `Your group is still finding a time for ${m.activity}. I'll keep you posted.`;
    case "organizer_pick": {
      const lines = m.options.map(
        (o) => `${o.optionNumber}. ${o.label} (${o.yes} yes${o.maybe ? `, ${o.maybe} maybe` : ""})`,
      );
      return `I couldn't find a time that works for everyone for ${m.activity}. Here are the closest options. Reply with a number to pick one:\n${lines.join("\n")}`;
    }
    case "failed":
      return `I couldn't find a time for ${m.activity}. Mention me again with a different window and I'll try again.`;
    case "parse_failed":
      return `I didn't quite get that. Try something like "@planner dinner sometime next weekend".`;
    case "dm_help":
      return `Hi! I plan things for group chats. Add me to your group and say something like "@planner dinner sometime next weekend".`;
    case "already_open":
      return `I'm still working on ${m.activity}. Let's finish that one first!`;
  }
}

export function formatOption(optionNumber: number, label: string): string {
  return `Option ${optionNumber}: ${label}`;
}
