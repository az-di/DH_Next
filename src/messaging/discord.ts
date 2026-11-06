import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { config } from "../config.ts";
import type { InboundMessage } from "./inbound.ts";
import { isMentioned } from "./mentions.ts";
import type { Messenger, SentMessage } from "./sendblue.ts";

// Discord adapter (discord.js gateway bot). A text channel (or thread) plays the
// role of an iMessage group chat; a Discord user id plays the role of a phone
// number. Ids are namespaced so they can't collide with iMessage ids and so the
// router can tell which transport owns a send:
//   discord:channel:<id>   discord:user:<id>
//
// Developer Portal → Bot, enable these privileged intents:
//   - Message Content (read "@planner dinner next weekend")
//   - Server Members  (list who is in the channel when a plan starts)

export const CHANNEL_PREFIX = "discord:channel:";
export const USER_PREFIX = "discord:user:";
const MAX_LEN = 2000;

export const isDiscordId = (id: string) => id.startsWith(CHANNEL_PREFIX) || id.startsWith(USER_PREFIX);

export interface DiscordMessageLike {
  id: string;
  channelId: string;
  content: string;
  author: { id: string; bot?: boolean };
  /** Message id this one replies to, if any. */
  replyToId?: string | null;
  inGuild: boolean;
}

/** Rewrites Discord's `<@123>` bot mention to the `@planner` form the coordinator understands. */
export function normalizeMention(text: string, botUserId: string, botName = config.botName): string {
  return text.replace(new RegExp(`<@!?${botUserId}>`, "g"), `@${botName}`).replace(/\s+/g, " ").trim();
}

export function toInbound(
  message: DiscordMessageLike,
  botUserId: string,
  participants: string[] = [],
): InboundMessage {
  return {
    messageHandle: message.id,
    from: USER_PREFIX + message.author.id,
    botNumber: null,
    groupId: message.inGuild ? CHANNEL_PREFIX + message.channelId : null,
    participants,
    text: normalizeMention(message.content, botUserId),
    replyToHandle: message.replyToId ?? null,
    reaction: null,
    isOutbound: message.author.id === botUserId,
  };
}

/** A group message that addresses the bot may start a plan, so it needs the channel's member list. */
export function needsMembers(msg: Pick<InboundMessage, "groupId" | "text">): boolean {
  return msg.groupId !== null && isMentioned(msg.text);
}

export function reactionToInbound(
  reaction: { emoji: string; messageId: string; channelId: string; inGuild: boolean },
  userId: string,
  botUserId: string,
): InboundMessage {
  return {
    // Reactions have no id of their own; make one unique per (message, user, emoji) for dedupe.
    messageHandle: `reaction:${reaction.messageId}:${userId}:${reaction.emoji}`,
    from: USER_PREFIX + userId,
    botNumber: null,
    groupId: reaction.inGuild ? CHANNEL_PREFIX + reaction.channelId : null,
    participants: [],
    text: "",
    replyToHandle: reaction.messageId,
    reaction: { kind: reaction.emoji, targetHandle: reaction.messageId, quotedText: null },
    isOutbound: userId === botUserId,
  };
}

/** Splits on newlines where possible so long replies stay under Discord's 2000-char cap. */
export function chunk(text: string, max = MAX_LEN): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  parts.push(rest);
  return parts;
}

interface Sendable {
  send(options: { content: string; allowedMentions: { parse: never[] } }): Promise<{ id: string }>;
}

export class DiscordMessenger implements Messenger {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  async sendGroup(groupId: string, content: string): Promise<SentMessage> {
    const channel = await this.client.channels.fetch(groupId.slice(CHANNEL_PREFIX.length));
    if (!channel || !channel.isSendable()) throw new Error(`discord: cannot send to ${groupId}`);
    return { messageHandle: await this.sendAll(channel, content), groupId };
  }

  async sendDirect(userId: string, content: string): Promise<SentMessage> {
    const user = await this.client.users.fetch(userId.slice(USER_PREFIX.length));
    // Fails if the user disabled DMs from server members; the coordinator logs and moves on.
    return { messageHandle: await this.sendAll(user, content), groupId: null };
  }

  /** Returns the id of the first chunk, which is the one tapbacks/votes attach to. */
  private async sendAll(target: Sendable, content: string): Promise<string> {
    let first = "";
    for (const part of chunk(content)) {
      // allowedMentions: nobody gets pinged by names echoed in the bot's copy.
      const sent = await target.send({ content: part, allowedMentions: { parse: [] } });
      first ||= sent.id;
    }
    return first;
  }
}

type InboundHandler = (msg: InboundMessage) => Promise<void>;

export interface DiscordTransport {
  messenger: DiscordMessenger;
  listen(onMessage: InboundHandler): void;
  stop(): Promise<void>;
}

export async function createDiscordTransport(): Promise<DiscordTransport> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Reactions on messages sent before this process started arrive as partials.
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });

  try {
    await client.login(config.discord.botToken);
  } catch (err) {
    throw new Error(
      `Could not log in to Discord. Check DISCORD_BOT_TOKEN and the privileged intents (Message Content, Server Members) in the Developer Portal. Cause: ${(err as Error).message}`,
      { cause: err },
    );
  }
  const botId = client.user!.id;

  const run = async (onMessage: InboundHandler, build: () => Promise<InboundMessage | null>) => {
    try {
      const inbound = await build();
      if (inbound) await onMessage(inbound);
    } catch (err) {
      console.error("[discord] failed to handle event:", err);
    }
  };

  return {
    messenger: new DiscordMessenger(client),
    listen(onMessage) {
      console.log(`[discord] connected as ${client.user!.tag}`);

      client.on(Events.MessageCreate, (message) => {
        if (message.author.bot) return;
        void run(onMessage, async () => {
          const inGuild = message.inGuild();
          const inbound = toInbound(
            {
              id: message.id,
              channelId: message.channelId,
              content: message.content,
              author: message.author,
              replyToId: message.reference?.messageId ?? null,
              inGuild,
            },
            botId,
          );
          // Membership is only needed when a plan starts, so skip the fetch otherwise.
          if (message.inGuild() && needsMembers(inbound)) {
            const members = await message.guild.members.fetch();
            const visible = members.filter(
              (m) => !m.user.bot && message.channel.permissionsFor(m)?.has("ViewChannel"),
            );
            inbound.participants = [...visible.keys()].map((id) => USER_PREFIX + id);
          }
          return inbound;
        });
      });

      client.on(Events.MessageReactionAdd, (reaction, user) => {
        if (user.bot) return;
        void run(onMessage, async () => {
          const full = reaction.partial ? await reaction.fetch() : reaction;
          const emoji = full.emoji.name;
          if (!emoji) return null;
          return reactionToInbound(
            {
              emoji,
              messageId: full.message.id,
              channelId: full.message.channelId,
              inGuild: Boolean(full.message.guildId),
            },
            user.id,
            botId,
          );
        });
      });
    },
    stop: () => client.destroy(),
  };
}
