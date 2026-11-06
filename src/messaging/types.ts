import type { Express } from "express";

// The contract between the planning core and messaging providers. The coordinator
// only knows these types, so it never depends on a specific chat network.

export interface InboundReaction {
  /** like | dislike | question | love | laugh | emphasize, or a raw emoji */
  kind: string;
  /** Handle of the message that was reacted to, when the payload carries it. */
  targetHandle: string | null;
  /** Quoted text from "Liked “…”" style fallbacks, used to find the target. */
  quotedText: string | null;
}

/** One incoming chat event, normalized by a provider. */
export interface InboundMessage {
  messageHandle: string;
  from: string;
  /** The bot's own id on this network, so it isn't added to plans as a member. */
  botNumber: string | null;
  groupId: string | null;
  participants: string[];
  text: string;
  replyToHandle: string | null;
  reaction: InboundReaction | null;
  isOutbound: boolean;
}

export type InboundHandler = (msg: InboundMessage) => Promise<void>;

export interface SentMessage {
  messageHandle: string | null;
  groupId: string | null;
}

/** Outbound messaging used by the coordinator. */
export interface Messenger {
  sendGroup(groupId: string, content: string): Promise<SentMessage>;
  sendDirect(number: string, content: string): Promise<SentMessage>;
}

/** A connected chat network, ready to send and receive. */
export interface Provider {
  name: string;
  network: string;
  messenger: Messenger;
  /** Mounts webhook routes. Runs before the global JSON parser, so each route picks its own body parser. */
  routes?(app: Express, onMessage: InboundHandler): void;
  /** Begins receiving. May run for the life of the process; a rejection is fatal. */
  start?(onMessage: InboundHandler): Promise<void>;
  stop?(): Promise<void>;
}

/** What each provider folder exports. Add one to PROVIDERS in registry.ts to enable it. */
export interface ProviderDefinition {
  /** Used in MESSAGING_PROVIDERS. */
  name: string;
  /**
   * The chat network this provider connects to. Ids on non-iMessage networks
   * start with `<network>:`, and only one provider per network can run at a time.
   */
  network: string;
  /** Whether its credentials are present, for auto-selection. */
  isConfigured(): boolean;
  /** Connects. Throw an error that says which setting to check. */
  create(): Promise<Provider>;
}
