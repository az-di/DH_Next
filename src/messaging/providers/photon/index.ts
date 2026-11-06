import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import express from "express";
import { config, env } from "../../../config.ts";
import { imessageAddress } from "../../address.ts";
import { isMentioned } from "../../mentions.ts";
import type { InboundHandler, InboundMessage, Messenger, Provider, ProviderDefinition, SentMessage } from "../../types.ts";

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

const photonConfig = {
  // Names match what spectrum-ts reads from the environment.
  projectId: env("SPECTRUM_PROJECT_ID"),
  projectSecret: env("SPECTRUM_PROJECT_SECRET"),
  webhookSecret: env("SPECTRUM_WEBHOOK_SECRET"),
  /** "stream" (long-lived connection, no public URL) or "webhook". */
  inbound: env("PHOTON_INBOUND", "stream") as "stream" | "webhook",
};

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
    from: imessageAddress.wrap(message.sender?.id ?? ""),
    botAddress: space.phone ? imessageAddress.wrap(space.phone) : null,
    groupId: space.isGroup ? imessageAddress.wrap(space.id) : null,
    participants: participants.map(imessageAddress.wrap),
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
    const id = imessageAddress.unwrap(groupId);
    const space = this.spaces.get(id) ?? (await imessage(this.app).space.get(id));
    const sent = await space.send(content);
    return { messageHandle: sent?.id ?? null, groupId };
  }

  async sendDirect(address: string, content: string): Promise<SentMessage> {
    console.log(`[photon] out dm ${last4(address)}: ${preview(content)}`);
    const im = imessage(this.app);
    const user = await im.user(imessageAddress.unwrap(address));
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

async function connect(): Promise<Provider> {
  let app: SpectrumApp;
  try {
    app = await Spectrum({
      projectId: photonConfig.projectId,
      projectSecret: photonConfig.projectSecret,
      providers: [imessage.config()],
      webhookSecret: photonConfig.webhookSecret || undefined,
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
      inbound.participants = members.map((m) => imessageAddress.wrap(m.id));
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
    name: "photon",
    network: "imessage",
    capabilities: { reactions: true },
    messenger,
    routes(server, onMessage) {
      if (photonConfig.inbound !== "webhook") return;
      // Photon signs the exact request bytes, so this route needs the raw body.
      server.post("/webhooks/photon", express.raw({ type: "*/*" }), async (req, res) => {
        const result = await app.webhook(
          { body: req.body, headers: req.headers as Record<string, string> },
          (space, message) => dispatch(onMessage, space, message),
        );
        res.status(result.status).set(result.headers).send(Buffer.from(result.body));
      });
      console.log(`[photon] webhook: ${config.publicBaseUrl}/webhooks/photon`);
    },
    // Stream mode: no public URL needed, the SDK holds a connection open.
    async start(onMessage) {
      if (photonConfig.inbound !== "stream") return;
      console.log("[photon] listening for iMessages on the Spectrum stream");
      for await (const [space, message] of app.messages) {
        void dispatch(onMessage, space, message); // don't block the stream on one slow plan
      }
    },
    stop: () => app.stop(),
  };
}

export const photonProvider: ProviderDefinition = {
  name: "photon",
  network: "imessage",
  isConfigured: () => Boolean(photonConfig.projectId && photonConfig.projectSecret),
  create: connect,
};
