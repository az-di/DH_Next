import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { config } from "../config.ts";
import type { InboundMessage } from "./inbound.ts";
import { isMentioned } from "./mentions.ts";
import type { Messenger, SentMessage } from "./sendblue.ts";

// Photon Spectrum (spectrum-ts, Stable docs: https://photon.codes/docs/spectrum-ts).
// Spectrum owns the transport: cloud iMessage lines over gRPC, with inbound
// messages via a long-lived stream (default, no public URL needed) or signed
// webhooks. Credentials: SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET.
//
// Plan limits worth knowing (Free/Pro = shared pool of lines):
// - The line only messages people registered under Users in the Photon
//   dashboard; others fail with "Target not allowed for this project".
// - No group creation and no group-change events. Messages in an existing
//   group may still arrive; dedicated-line (Business) plans support groups fully.

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

/** The few fields we read from a Spectrum message. Kept structural so it's testable. */
export interface SpectrumMessageLike {
  id: string;
  direction: "inbound" | "outbound";
  sender?: { id: string } | undefined;
  content: SpectrumContentLike;
}

type SpectrumContentLike =
  | { type: "text"; text: string }
  | { type: "reaction"; emoji: string; target: { id: string } }
  | { type: "reply"; content: SpectrumContentLike; target: { id: string } }
  | { type: "group"; items: { content: SpectrumContentLike }[] }
  | { type: string };

export interface SpaceInfo {
  id: string;
  isGroup: boolean;
  /** The Photon line handling this conversation. */
  phone: string | null;
}

/** Converts a Spectrum (space, message) pair into the coordinator's InboundMessage. */
export function toInbound(
  space: SpaceInfo,
  message: SpectrumMessageLike,
  participants: string[] = [],
): InboundMessage {
  let content = message.content;
  let replyToHandle: string | null = null;
  if (content.type === "reply" && "target" in content) {
    replyToHandle = content.target.id;
    content = content.content;
  }

  const reaction =
    content.type === "reaction" && "emoji" in content
      ? { kind: content.emoji, targetHandle: content.target.id, quotedText: null }
      : null;

  return {
    messageHandle: message.id,
    from: message.sender?.id ?? "",
    botNumber: space.phone,
    groupId: space.isGroup ? space.id : null,
    participants,
    text: textOf(content),
    replyToHandle,
    reaction,
    isOutbound: message.direction === "outbound",
  };
}

function textOf(content: SpectrumContentLike): string {
  if (content.type === "text" && "text" in content) return content.text.trim();
  if (content.type === "group" && "items" in content) {
    return content.items.map((item) => textOf(item.content)).filter(Boolean).join(" ");
  }
  return "";
}

export class PhotonMessenger implements Messenger {
  private app: SpectrumApp;
  /** Spaces seen inbound, so group sends don't need a lookup round-trip. */
  private spaces = new Map<string, { send: (content: string) => Promise<{ id: string } | undefined> }>();

  constructor(app: SpectrumApp) {
    this.app = app;
  }

  remember(space: { id: string; send: (content: string) => Promise<{ id: string } | undefined> }) {
    this.spaces.set(space.id, space);
  }

  async sendGroup(groupId: string, content: string): Promise<SentMessage> {
    console.log(`[photon] out group ${shortId(groupId)}: ${preview(content)}`);
    const space = this.spaces.get(groupId) ?? (await imessage(this.app).space.get(groupId));
    const sent = await space.send(content);
    return { messageHandle: sent?.id ?? null, groupId };
  }

  async sendDirect(number: string, content: string): Promise<SentMessage> {
    console.log(`[photon] out dm ${last4(number)}: ${preview(content)}`);
    const im = imessage(this.app);
    const user = await im.user(number);
    const space = await im.space.create(user);
    const sent = await space.send(content);
    return { messageHandle: sent?.id ?? null, groupId: null };
  }
}

// One log line per message in and out, so a silent bot can be told apart from
// a message that never arrived. Senders are shown by last 4 digits only.

const last4 = (handle: string) => (handle ? `…${handle.replace(/\D/g, "").slice(-4) || handle.slice(-6)}` : "?");
const shortId = (id: string) => (id.length > 12 ? `…${id.slice(-8)}` : id);
const preview = (text: string) => JSON.stringify(text.length > 60 ? `${text.slice(0, 60)}…` : text);

function logInbound(msg: InboundMessage, contentType: string | undefined) {
  const where = msg.groupId ? `group ${shortId(msg.groupId)}` : "dm";
  const direction = msg.isOutbound ? "echo of our own message" : `from ${last4(msg.from)}`;
  const what = msg.reaction
    ? `reaction ${msg.reaction.kind} on ${shortId(msg.reaction.targetHandle ?? "?")}`
    : msg.text
      ? `${preview(msg.text)}${isMentioned(msg.text) ? " (mentions bot)" : ""}`
      : `(${contentType ?? "no text"})`;
  console.log(`[photon] in ${where} ${direction}: ${what}`);
}

type InboundHandler = (msg: InboundMessage) => Promise<void>;

export interface PhotonTransport {
  messenger: PhotonMessenger;
  /** Consumes the inbound stream until stop(). Used when PHOTON_INBOUND=stream. */
  listen(onMessage: InboundHandler): Promise<void>;
  /** Express-style raw handler for PHOTON_INBOUND=webhook. */
  handleWebhook(
    req: { body: Uint8Array; headers: Record<string, string> },
    onMessage: InboundHandler,
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  stop(): Promise<void>;
}

export async function createPhotonTransport(): Promise<PhotonTransport> {
  let app: SpectrumApp;
  try {
    app = await Spectrum({
      projectId: config.photon.projectId,
      projectSecret: config.photon.projectSecret,
      providers: [imessage.config()],
      webhookSecret: config.photon.webhookSecret || undefined,
    });
  } catch (err) {
    throw new Error(
      "Could not connect to Photon. Check SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET " +
        `(dashboard → project Settings at https://app.photon.codes). Cause: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const messenger = new PhotonMessenger(app);

  // Spectrum's own types are generated and very wide; we read a handful of fields.
  const convert = async (space: any, message: any): Promise<InboundMessage | null> => {
    if (message.platform !== "imessage") return null;
    messenger.remember(space);
    const narrowed = imessage(space) as { type?: string; phone?: string };
    const info: SpaceInfo = { id: space.id, isGroup: narrowed.type === "group", phone: narrowed.phone ?? null };
    const inbound = toInbound(info, message as SpectrumMessageLike);
    // Membership is only needed when a plan starts, so skip the lookup otherwise.
    if (info.isGroup && isMentioned(inbound.text)) {
      const members: { id: string }[] = await space.getMembers().catch(() => []);
      inbound.participants = members.map((m) => m.id);
    }
    return inbound;
  };

  const dispatch = async (onMessage: InboundHandler, space: any, message: any) => {
    try {
      const inbound = await convert(space, message);
      if (!inbound) {
        console.log(`[photon] in (skipped: platform ${message?.platform}) ${message?.content?.type}`);
        return;
      }
      logInbound(inbound, message?.content?.type);
      await onMessage(inbound);
    } catch (err) {
      console.error("[photon] failed to handle message:", err);
    }
  };

  return {
    messenger,
    async listen(onMessage) {
      for await (const [space, message] of app.messages) {
        void dispatch(onMessage, space, message); // don't block the stream on one slow plan
      }
    },
    async handleWebhook(req, onMessage) {
      return app.webhook(req, (space, message) => dispatch(onMessage, space, message));
    },
    stop: () => app.stop(),
  };
}
