import express, { type Express } from "express";
import { createCalendarRouter } from "./calendar/routes.ts";
import { config } from "./config.ts";
import type { Repo } from "./db/repo.ts";
import { parseInbound } from "./messaging/inbound.ts";
import type { Coordinator } from "./plans/coordinator.ts";

const RECENT_LIMIT = 1000;

export function createServer(deps: { repo: Repo; coordinator: Coordinator }): Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Sendblue retries until it gets a response, so acknowledge immediately and
  // process in the background. Duplicate deliveries are dropped by handle.
  const recent = new Set<string>();
  app.post("/webhooks/sendblue", (req, res) => {
    const secret = config.sendblue.webhookSecret;
    const given = req.query.secret ?? req.get("x-webhook-secret");
    if (secret && given !== secret) {
      res.status(401).json({ error: "bad secret" });
      return;
    }
    res.status(200).json({ ok: true });

    const msg = parseInbound(req.body ?? {});
    if (msg.messageHandle) {
      if (recent.has(msg.messageHandle)) return;
      recent.add(msg.messageHandle);
      if (recent.size > RECENT_LIMIT) recent.delete(recent.values().next().value!);
    }
    deps.coordinator.handleInbound(msg).catch((err) => {
      console.error("[webhook] failed to handle message:", err);
    });
  });

  app.use(createCalendarRouter(deps.repo));
  return app;
}
