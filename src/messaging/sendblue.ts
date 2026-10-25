import { config } from "../config.ts";

// Sendblue REST client. Docs: https://docs.sendblue.com
// Auth is two headers (sb-api-key-id / sb-api-secret-key) against api.sendblue.com.

const BASE_URL = "https://api.sendblue.com/api";

export interface SentMessage {
  messageHandle: string | null;
  groupId: string | null;
}

/** Outbound messaging used by the coordinator. Swappable for tests and the Mac-relay backup. */
export interface Messenger {
  sendGroup(groupId: string, content: string): Promise<SentMessage>;
  sendDirect(number: string, content: string): Promise<SentMessage>;
}

export class SendblueMessenger implements Messenger {
  async sendGroup(groupId: string, content: string) {
    return this.post("/send-group-message", {
      group_id: groupId,
      content,
      from_number: config.sendblue.fromNumber,
    });
  }

  async sendDirect(number: string, content: string) {
    return this.post("/send-message", {
      number,
      content,
      from_number: config.sendblue.fromNumber,
    });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<SentMessage> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": config.sendblue.apiKey,
        "sb-api-secret-key": config.sendblue.apiSecret,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || data.status === "ERROR") {
      throw new Error(`sendblue ${path} failed (${res.status}): ${data.error_message ?? JSON.stringify(data)}`);
    }
    return { messageHandle: data.message_handle ?? null, groupId: data.group_id || null };
  }
}

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
    if (process.env.NODE_ENV !== "test") console.log(`[sendblue:${kind} → ${to}] ${content}`);
    return { messageHandle, groupId: kind === "group" ? to : null };
  }
}
