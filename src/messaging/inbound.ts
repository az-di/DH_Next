// Normalizes a Sendblue receive-webhook body into the shape the coordinator uses.
// Documented fields: content, message_handle, from_number, group_id,
// participants, is_outbound, reply_to.message_handle, thread_originator.

export interface InboundReaction {
  /** like | dislike | question | love | laugh | emphasize, or a raw emoji */
  kind: string;
  /** Handle of the message that was reacted to, when the payload carries it. */
  targetHandle: string | null;
  /** Quoted text from "Liked “…”" style fallbacks, used to find the target. */
  quotedText: string | null;
}

export interface InboundMessage {
  messageHandle: string;
  from: string;
  /** The Sendblue line that received this message (the bot itself). */
  botNumber: string | null;
  groupId: string | null;
  participants: string[];
  text: string;
  replyToHandle: string | null;
  reaction: InboundReaction | null;
  isOutbound: boolean;
}

// iMessage relays tapbacks to non-reaction-aware clients as text like
// `Liked “Option 1: Sat 7pm”`. Map those verbs to reaction kinds.
const TEXT_TAPBACKS: Record<string, string> = {
  liked: "like",
  disliked: "dislike",
  questioned: "question",
  loved: "love",
  laughed: "laugh",
  "laughed at": "laugh",
  emphasized: "emphasize",
};

const TEXT_TAPBACK_RE = /^(liked|disliked|questioned|loved|laughed at|laughed|emphasized)\s+[“"](.*)[”"]\s*$/is;

export function parseInbound(body: Record<string, any>): InboundMessage {
  const text = String(body.content ?? "").trim();
  const replyToHandle = body.reply_to?.message_handle ?? body.thread_originator?.message_handle ?? null;

  return {
    messageHandle: String(body.message_handle ?? ""),
    from: String(body.from_number ?? body.number ?? ""),
    botNumber: body.sendblue_number ?? body.to_number ?? null,
    groupId: body.group_id ? String(body.group_id) : null,
    participants: Array.isArray(body.participants) ? body.participants.map(String) : [],
    text,
    replyToHandle,
    reaction: extractReaction(body, text, replyToHandle),
    isOutbound: Boolean(body.is_outbound),
  };
}

function extractReaction(
  body: Record<string, any>,
  text: string,
  replyToHandle: string | null,
): InboundReaction | null {
  // Structured form. Sendblue doesn't document inbound reaction fields yet, so
  // accept the common candidates and fall back to text parsing below.
  const structured = body.reaction ?? body.reaction_type ?? body.tapback ?? null;
  if (structured) {
    const kind = typeof structured === "string" ? structured : structured.type ?? structured.reaction;
    const target =
      body.reaction_target?.message_handle ??
      body.associated_message_handle ??
      structured.message_handle ??
      replyToHandle;
    if (kind) return { kind: String(kind).toLowerCase(), targetHandle: target ?? null, quotedText: null };
  }

  const match = TEXT_TAPBACK_RE.exec(text);
  if (match) {
    return {
      kind: TEXT_TAPBACKS[match[1].toLowerCase()],
      targetHandle: replyToHandle,
      quotedText: match[2].trim(),
    };
  }
  return null;
}
