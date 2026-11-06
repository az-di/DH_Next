import type { Messenger, ProviderDefinition, SentMessage } from "../../types.ts";
import { mountSendblueWebhook } from "../sendblue/index.ts";

// Log-only provider for offline development. Nothing is sent. Inbound uses the
// Sendblue webhook format, so a group chat can be simulated with curl (see README).

/** Logs instead of sending, and keeps an outbox so tests can assert on what went out. */
export class ConsoleMessenger implements Messenger {
  outbox: { to: string; kind: "group" | "direct"; content: string; messageHandle: string }[] = [];
  private counter = 0;

  async sendGroup(groupId: string, content: string) {
    return this.record(groupId, "group", content);
  }

  async sendDirect(number: string, content: string) {
    return this.record(number, "direct", content);
  }

  private record(to: string, kind: "group" | "direct", content: string): SentMessage {
    const messageHandle = `local-${++this.counter}`;
    this.outbox.push({ to, kind, content, messageHandle });
    if (process.env.NODE_ENV !== "test") console.log(`[console:${kind} → ${to}] ${content}`);
    return { messageHandle, groupId: kind === "group" ? to : null };
  }
}

export const consoleProvider: ProviderDefinition = {
  name: "console",
  // Simulates iMessage, so it takes bare phone numbers. Never auto-selected over a real provider.
  network: "imessage",
  isConfigured: () => false,
  async create() {
    console.warn("[messaging] no provider credentials — messages will be logged, not sent");
    return {
      name: "console",
      network: "imessage",
      messenger: new ConsoleMessenger(),
      routes: mountSendblueWebhook,
    };
  },
};
