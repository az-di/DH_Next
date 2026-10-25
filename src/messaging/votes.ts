import type { Vote } from "../types.ts";
import type { InboundMessage } from "./inbound.ts";

/**
 * A single vote extracted from a message. `optionNumber` is null when the
 * reply doesn't name an option ("yes", 👍 on the only proposal); the
 * coordinator resolves it against the current round. `allOptions` marks
 * blanket answers like "none work".
 */
export interface ParsedVote {
  vote: Vote;
  optionNumber: number | null;
  allOptions?: boolean;
  /** For tapbacks: the bot message that was reacted to. */
  targetHandle?: string | null;
  quotedText?: string | null;
}

const REACTION_VOTES: Record<string, Vote> = {
  like: "yes",
  love: "yes",
  "👍": "yes",
  "❤️": "yes",
  dislike: "no",
  "👎": "no",
  question: "maybe",
  "❓": "maybe",
  "?": "maybe",
};

const YES = /^(y|yes|yep|yeah|yup|sure|ok|okay|works|works for me|down|i'm down|im down|👍|✅)$/i;
const NO = /^(n|no|nope|nah|can't|cant|can't make it|cant make it|doesn't work|doesnt work|👎|❌)$/i;
const MAYBE = /^(maybe|possibly|not sure|unsure|idk|\?|❓|🤷|🤷‍♂️|🤷‍♀️)$/i;
const NONE = /^(none|neither|none work|none of them|neither works|no to all)$/i;

function wordVote(word: string): Vote | null {
  if (YES.test(word)) return "yes";
  if (NO.test(word)) return "no";
  if (MAYBE.test(word)) return "maybe";
  return null;
}

/**
 * Parses tapbacks and short text replies into votes. Returns [] for anything
 * that isn't clearly a vote, so ordinary chat in the group is ignored.
 *
 * Supported text forms: "yes" / "no" / "maybe", "1", "1 3", "1 and 2",
 * "2 no", "no 2", "maybe 3", "1 yes 2 maybe", "none".
 */
export function parseVotes(msg: Pick<InboundMessage, "text" | "reaction">): ParsedVote[] {
  if (msg.reaction) {
    const vote = REACTION_VOTES[msg.reaction.kind];
    if (!vote) return []; // laugh / emphasize don't count
    const optionNumber = msg.reaction.quotedText ? optionFromQuote(msg.reaction.quotedText) : null;
    return [
      {
        vote,
        optionNumber,
        targetHandle: msg.reaction.targetHandle,
        quotedText: msg.reaction.quotedText,
      },
    ];
  }

  const text = msg.text.trim().replace(/[.!]+$/, "");
  if (!text || text.length > 60) return [];

  if (NONE.test(text)) return [{ vote: "no", optionNumber: null, allOptions: true }];

  const whole = wordVote(text);
  if (whole) return [{ vote: whole, optionNumber: null }];

  // Tokenize "1 yes, 2 maybe" / "1 and 3" / "no 2".
  const tokens = text
    .toLowerCase()
    .replace(/[,;&+]/g, " ")
    .replace(/\band\b|\bor\b|\boption\b|#/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  const votes: ParsedVote[] = [];
  let pendingVote: Vote | null = null; // "no 2" form: vote word before the number
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/^\d{1,2}$/.test(tok)) {
      const n = Number(tok);
      const next = tokens[i + 1] ? wordVote(tokens[i + 1]) : null;
      if (next) {
        votes.push({ vote: next, optionNumber: n });
        i++;
      } else {
        votes.push({ vote: pendingVote ?? "yes", optionNumber: n });
      }
      continue;
    }
    const v = wordVote(tok);
    if (v) {
      pendingVote = v;
      continue;
    }
    return []; // unrecognized word: this is normal chat, not a vote
  }
  return votes;
}

function optionFromQuote(quoted: string): number | null {
  const m = /option\s*(\d+)|^(\d+)[.):]/i.exec(quoted.trim());
  return m ? Number(m[1] ?? m[2]) : null;
}
