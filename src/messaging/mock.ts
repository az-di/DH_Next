import type { Messenger, SentMessage } from "./sendblue.ts";

// Mock iMessage for local development and demos (MESSAGING_PROVIDER=mock).
// Nothing leaves the process: bot messages land in an in-memory group thread
// that the /mock page renders live.

export interface MockChatMessage {
  handle: string;
  /** Sender phone; the bot's own number for bot messages. */
  from: string;
  text: string;
  sentAt: string; // ISO, on the mock clock
  replyTo: string | null;
  /** Tapbacks, keyed by reacting phone. iMessage keeps one per person. */
  reactions: Record<string, string>;
}

export interface MockDirectMessage {
  handle: string;
  to: string;
  text: string;
  sentAt: string;
}

/** The single mock group thread plus the bot's DMs. */
export class MockChat {
  messages: MockChatMessage[] = [];
  directs: MockDirectMessage[] = [];
  readonly botNumber: string;
  private now: () => Date;
  private listeners = new Set<() => void>();
  // Never reset, so handles stay unique for the webhook deduper across resets.
  private counter = 0;

  constructor(botNumber: string, now: () => Date = () => new Date()) {
    this.botNumber = botNumber;
    this.now = now;
  }

  post(from: string, text: string, replyTo: string | null = null): MockChatMessage {
    const message: MockChatMessage = {
      handle: this.nextHandle(from === this.botNumber ? "bot" : "user"),
      from,
      text,
      sentAt: this.now().toISOString(),
      replyTo,
      reactions: {},
    };
    this.messages.push(message);
    this.changed();
    return message;
  }

  /** Records a tapback. Returns false when the target isn't in the thread. */
  react(targetHandle: string, from: string, emoji: string): boolean {
    const target = this.messages.find((m) => m.handle === targetHandle);
    if (!target) return false;
    target.reactions[from] = emoji;
    this.changed();
    return true;
  }

  direct(to: string, text: string): MockDirectMessage {
    const message = { handle: this.nextHandle("dm"), to, text, sentAt: this.now().toISOString() };
    this.directs.push(message);
    this.changed();
    return message;
  }

  /** Allocates a handle for an inbound event that isn't stored as a message (a tapback). */
  nextHandle(prefix: string): string {
    return `mock-${prefix}-${++this.counter}`;
  }

  clear() {
    this.messages = [];
    this.directs = [];
    this.changed();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }
}

export class MockMessenger implements Messenger {
  private chat: MockChat;

  constructor(chat: MockChat) {
    this.chat = chat;
  }

  async sendGroup(groupId: string, content: string): Promise<SentMessage> {
    const sent = this.chat.post(this.chat.botNumber, content);
    return { messageHandle: sent.handle, groupId };
  }

  async sendDirect(number: string, content: string): Promise<SentMessage> {
    const sent = this.chat.direct(number, content);
    return { messageHandle: sent.handle, groupId: null };
  }
}
