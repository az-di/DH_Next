import { config } from "../config.ts";
import type { BotMessage } from "./brain.ts";

// Deterministic copy for every bot message. Used directly when Claude isn't
// configured, and as the fallback when a Claude call fails.

const list = (names: string[], joiner = "and") =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${joiner} ${names.at(-1)}`;
const orList = (names: string[]) => list(names, "or");
const mention = () => `@${config.botName}`;

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
    case "dm_failed":
      return `I couldn't DM ${list(m.names)} a calendar link, so I'll plan without ${m.names.length === 1 ? "that calendar" : "those calendars"}. Everyone can still vote here.`;
    case "proposal": {
      // Later rounds say the last one didn't work, however many options there are.
      const retry = m.reason === "after_no";
      const reactions = m.reactions ?? true;
      const how =
        m.options.length === 1
          ? reactions
            ? "👍 yes, 👎 no, ❓ maybe."
            : "Reply yes, no, or maybe."
          : reactions
            ? `React with 👍/👎/❓ on each, or reply with the numbers that work${retry ? "" : ` (e.g. "1 3")`}.`
            : `Reply with the numbers that work${retry ? "" : ` (e.g. "1 3")`}.`;
      const intro =
        m.options.length === 1
          ? retry
            ? `That didn't work for everyone, so how about this for ${m.activity} instead? ${how}`
            : `How about this for ${m.activity}? ${how}`
          : retry
            ? `That didn't work for everyone, so here are ${m.options.length} more for ${m.activity}. ${how}`
            : `A few options for ${m.activity}. ${how}`;
      return `${intro} Please answer by ${m.deadlineLabel}.`;
    }
    case "reminder":
      return `Hey${m.name ? ` ${m.name}` : ""}, quick reminder to vote on ${m.activity} times in the group chat. Closes ${m.deadlineLabel}.`;
    case "nudge":
      return `Hey${m.name ? ` ${m.name}` : ""}, Option ${m.optionNumber} (${m.slotLabel}) is looking likely for ${m.activity}. Can you make it? ${(m.reactions ?? true) ? "React with 👍/👎/❓ on it" : `Reply with "${m.optionNumber}" if so`} in the group chat by ${m.deadlineLabel}.`;
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
      return `I didn't quite get that. Try something like "${mention()} dinner sometime next weekend".`;
    case "dm_help":
      return `Hi! I plan things for group chats. Add me to your group and say something like "${mention()} dinner sometime next weekend".`;
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
          `I don't know who ${orList(m.unknown)} is yet. If that's you, reply "${mention()} I'm ${m.unknown.length === 1 ? m.unknown[0] : "<your name>"}".`,
        );
      }
      for (const a of m.ambiguous) {
        parts.push(`Which ${a.name} do you mean: ${orList(a.options)}? Reply "${mention()}" and their full name.`);
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
      return `There's nothing scheduled right now. Start a plan with "${mention()} dinner next weekend".`;
    case "availability_asked": {
      let text = `On it! I'm DMing everyone to ask what times work for ${m.activity} ${m.windowLabel}. Please answer there by ${m.deadlineLabel}.`;
      if (m.optionalNames.length) text += ` ${list(m.optionalNames)} ${m.optionalNames.length === 1 ? "is" : "are"} optional.`;
      return text;
    }
    case "availability_ask": {
      const who = m.organizerName ? `${m.organizerName} is planning ${m.activity}` : `You're planning ${m.activity}`;
      return `Hi${m.name ? ` ${m.name}` : ""}! ${who} ${m.windowLabel}. What times work for you? Just reply here, like "Saturday after 6, not Sunday" or "anytime". Please answer by ${m.deadlineLabel}.`;
    }
    case "availability_saved": {
      const saved = m.windowLabels.length
        ? `Got it for ${m.activity}: ${m.windowLabels.join("; ")}.`
        : `Got it, nothing works for you for ${m.activity}.`;
      const waiting = m.waitingOn > 0 ? ` Still waiting on ${m.waitingOn} ${m.waitingOn === 1 ? "person" : "people"}.` : "";
      return `${saved}${waiting} Reply again to change your answer.`;
    }
    case "availability_unclear":
      return `I couldn't work out times for ${m.activity} from that. It's ${m.windowLabel}, so try something like "Saturday after 6" or "anytime". If nothing works, say "none".`;
    case "availability_reminder":
      return `Hey${m.name ? ` ${m.name}` : ""}, what times work for ${m.activity}? Just reply here by ${m.deadlineLabel}.`;
    case "availability_which":
      return `You're in a few plans right now: ${list(m.activities)}. Which is this for? Reply again and mention it, like "${m.activities[0]}: Saturday after 6".`;
    case "availability_closed":
      return `Thanks, but answers for ${m.activity} have closed and the organizer is choosing a time now.`;
    case "dm_unreachable":
      return `I couldn't DM ${list(m.names)}, so I'll plan without them. Check your DM settings for this server if you'd like to be included.`;
    case "too_many_people":
      return `This channel has ${m.count} people, and I can only DM up to ${m.max}. Try a smaller channel or thread.`;
    case "availability_options": {
      const lines = m.options.map((o) => {
        const note = o.cantNames.length ? ` (${list(o.cantNames)} can't)` : m.answered > 0 ? " (works for everyone who answered)" : "";
        return `${o.optionNumber}. ${o.label}${note}`;
      });
      const heard = `${m.answered} of ${m.total} answered${m.noAnswerNames.length ? `, no reply from ${list(m.noAnswerNames)}` : ""}`;
      const ask = m.organizerName ? `${m.organizerName}, reply here with a number to pick one` : "Reply with a number to pick one";
      return `Here's what looks best for ${m.activity} (${heard}). ${ask}:\n${lines.join("\n")}`;
    }
    case "organizer_picking":
      return `I've heard from ${m.answered} of ${m.total} about ${m.activity}, and ${m.organizerName} is picking the time now.`;
    case "pick_invalid":
      return `For ${m.activity}, reply with a number from 1 to ${m.optionCount} to pick a time.`;
    case "pick_expired":
      return `${m.organizerName} didn't pick a time for ${m.activity}, so I've closed this plan. Mention me to start again.`;
    case "organizer_only":
      return `Only ${m.organizerName}, who started this plan, can change who's required.`;
  }
}

export function formatOption(optionNumber: number, label: string): string {
  return `Option ${optionNumber}: ${label}`;
}
