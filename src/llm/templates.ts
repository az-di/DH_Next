import type { BotMessage } from "./brain.ts";

// Deterministic copy for every bot message. Used directly when Claude isn't
// configured, and as the fallback when a Claude call fails.

const list = (names: string[], joiner = "and") =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${joiner} ${names.at(-1)}`;
const orList = (names: string[]) => list(names, "or");

export function renderTemplate(m: BotMessage): string {
  switch (m.kind) {
    case "ack": {
      let text = `On it! Looking for ${m.activity} times ${m.windowLabel}.`;
      if (m.optionalNames?.length) text += ` ${list(m.optionalNames)} ${m.optionalNames.length === 1 ? "is" : "are"} optional.`;
      if (m.unconnectedNames.length) {
        text += ` ${list(m.unconnectedNames)}, I sent you a link to connect your calendar, which makes this faster.`;
      }
      return text;
    }
    case "connect_calendar":
      return `Hi${m.name ? ` ${m.name}` : ""}! Your group is planning ${m.activity}. Connect your calendar so I can skip times you're busy (I only see free/busy, never event details): ${m.url}`;
    case "proposal": {
      // Later rounds say the last one didn't work, however many options there are.
      const retry = m.reason === "after_no";
      const intro =
        m.options.length === 1
          ? retry
            ? `That didn't work for everyone, so how about this for ${m.activity} instead? 👍 yes, 👎 no, ❓ maybe.`
            : `How about this for ${m.activity}? 👍 yes, 👎 no, ❓ maybe.`
          : retry
            ? `That didn't work for everyone, so here are ${m.options.length} more for ${m.activity}. Tap 👍/👎/❓ on each, or reply with the numbers that work.`
            : `A few options for ${m.activity}. Tap 👍/👎/❓ on each, or reply with the numbers that work (e.g. "1 3").`;
      return `${intro} Please answer by ${m.deadlineLabel}.`;
    }
    case "reminder":
      return `Hey${m.name ? ` ${m.name}` : ""}, quick reminder to vote on ${m.activity} times in the group chat. Closes ${m.deadlineLabel}.`;
    case "nudge":
      return `Hey${m.name ? ` ${m.name}` : ""}, Option ${m.optionNumber} (${m.slotLabel}) is looking likely for ${m.activity}. Can you make it? Tap 👍/👎/❓ on it in the group chat by ${m.deadlineLabel}.`;
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
    case "roles_set": {
      const parts = (["optional", "essential"] as const).flatMap((role) => {
        const names = m.changes.filter((c) => c.role === role).map((c) => c.name);
        if (!names.length) return [];
        return [`${list(names)} ${names.length === 1 ? "is" : "are"} ${role === "optional" ? "optional" : "required"}`];
      });
      return `Got it: ${parts.join(", ")}.`;
    }
    case "role_question": {
      const parts: string[] = [];
      if (m.unknown.length) {
        parts.push(
          `I don't know who ${orList(m.unknown)} is yet. If that's you, reply "@planner I'm ${m.unknown.length === 1 ? m.unknown[0] : "<your name>"}".`,
        );
      }
      for (const a of m.ambiguous) {
        parts.push(`Which ${a.name} do you mean: ${orList(a.options)}? Reply "@planner" and their full name.`);
      }
      return parts.join(" ");
    }
    case "name_saved":
      return m.role && m.activity
        ? `Thanks, ${m.name}! You're ${m.role === "optional" ? "optional" : "required"} for ${m.activity}.`
        : `Nice to meet you, ${m.name}!`;
    case "preferences_saved":
      return `Saved for ${m.name}: ${m.summary}.`;
    case "constraint_noted":
      return m.optionNumbers.length
        ? `Got it, ${m.name}: marked you as a no for ${m.optionNumbers.length === 1 ? "option" : "options"} ${list(m.optionNumbers.map(String))}.`
        : `Noted, ${m.name}. None of the current options are then.`;
    case "nothing_scheduled":
      return `There's nothing scheduled right now. Start a plan with "@planner dinner next weekend".`;
    case "organizer_only":
      return `Only ${m.organizerName}, who started this plan, can change who's required.`;
  }
}

export function formatOption(optionNumber: number, label: string): string {
  return `Option ${optionNumber}: ${label}`;
}
