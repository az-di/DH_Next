import express, { type Express } from "express";
import { config } from "../../../config.ts";
import { imessageAddress } from "../../address.ts";
import type { InboundHandler, Messenger, ProviderDefinition, SentMessage } from "../../types.ts";
import { sendblueConfig } from "./config.ts";
import { parseInbound } from "./parse.ts";

// Sendblue REST client. Docs: https://docs.sendblue.com
// Auth is two headers (sb-api-key-id / sb-api-secret-key) against api.sendblue.com.

const BASE_URL = "https://api.sendblue.com/api";

export class SendblueMessenger implements Messenger {
  async sendGroup(groupId: string, content: string) {
    return this.post("/send-group-message", {
      group_id: imessageAddress.unwrap(groupId),
      content,
      from_number: sendblueConfig.fromNumber,
    });
  }

  async sendDirect(address: string, content: string) {
    return this.post("/send-message", {
      number: imessageAddress.unwrap(address),
      content,
      from_number: sendblueConfig.fromNumber,
    });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<SentMessage> {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sb-api-key-id": sendblueConfig.apiKey,
        "sb-api-secret-key": sendblueConfig.apiSecret,
      },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || data.status === "ERROR") {
      throw new Error(`sendblue ${path} failed (${res.status}): ${data.error_message ?? JSON.stringify(data)}`);
    }
    return { messageHandle: data.message_handle ?? null, groupId: data.group_id ? imessageAddress.wrap(data.group_id) : null };
  }
}

/** Sendblue's receive webhook. Also the offline console provider's inbound path. */
export function mountSendblueWebhook(app: Express, onMessage: InboundHandler) {
  const secret = sendblueConfig.webhookSecret;
  if (!secret) console.warn("[sendblue] SENDBLUE_WEBHOOK_SECRET is blank — /webhooks/sendblue accepts any caller");
  // Sendblue retries until it gets a response, so acknowledge immediately and
  // process in the background.
  app.post("/webhooks/sendblue", express.json({ limit: "1mb" }), (req, res) => {
    const given = req.query.secret ?? req.get("x-webhook-secret");
    if (secret && given !== secret) {
      res.status(401).json({ error: "bad secret" });
      return;
    }
    res.status(200).json({ ok: true });
    onMessage(parseInbound(req.body ?? {})).catch((err) => {
      console.error("[webhook] failed to handle message:", err);
    });
  });
}

export const sendblueProvider: ProviderDefinition = {
  name: "sendblue",
  network: "imessage",
  isConfigured: () => Boolean(sendblueConfig.apiKey && sendblueConfig.apiSecret),
  async create() {
    return {
      name: "sendblue",
      network: "imessage",
      capabilities: { reactions: true, collectByDm: false },
      messenger: new SendblueMessenger(),
      routes(app, onMessage) {
        mountSendblueWebhook(app, onMessage);
        console.log(`[sendblue] webhook: ${config.publicBaseUrl}/webhooks/sendblue`);
      },
    };
  },
};
