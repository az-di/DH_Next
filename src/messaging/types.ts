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
  /** Sender's address (see address.ts). Every address here carries its network prefix. */
  from: string;
  /** The bot's own address on this network, so it isn't added to plans as a member. */
  botAddress: string | null;
  groupId: string | null;
  /** The group's display name, like "#friends", when the network has one. Tells same-named plans apart in DMs. */
  groupName?: string | null;
  participants: string[];
  /** Display names by address, when the network provides them. Used until someone introduces themselves. */
  names?: Record<string, string>;
  text: string;
  /** The message this one replies to. In a DM, a reply to the bot says exactly which plan it's about. */
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
  sendDirect(address: string, content: string): Promise<SentMessage>;
}

/** What a network can do, where the bot has to behave differently because of it. */
export interface Capabilities {
  /** Whether emoji reactions reach the bot as votes. Without them, the bot only asks for replies. */
  reactions: boolean;
  /**
   * Plan by DM: ask each member privately what times work, then the organizer
   * picks. Without it, the bot proposes times in the group and people vote there.
   */
  collectByDm: boolean;
}

/** A connected chat network, ready to send and receive. */
export interface Provider {
  name: string;
  network: string;
  capabilities: Capabilities;
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
   * The chat network this provider connects to. Every address it produces starts
   * with `<network>:`, and only one provider per network can run at a time.
   */
  network: string;
  /** Whether its credentials are present, for auto-selection. */
  isConfigured(): boolean;
  /** Connects. Throw an error that says which setting to check. */
  create(): Promise<Provider>;
}
