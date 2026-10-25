import express, { type Express } from "express";
import { createCalendarRouter } from "./calendar/routes.ts";
import { config } from "./config.ts";
import type { Repo } from "./db/repo.ts";
import { createDeduper } from "./messaging/dedupe.ts";
import { parseInbound, type InboundMessage } from "./messaging/inbound.ts";
import type { PhotonTransport } from "./messaging/photon.ts";
import type { Coordinator } from "./plans/coordinator.ts";

export function createServer(deps: {
  repo: Repo;
  coordinator: Coordinator;
  photon?: PhotonTransport;
}): Express {
  const app = express();
  const firstTime = createDeduper();
  const handle = (msg: InboundMessage) => {
    if (!firstTime(msg.messageHandle)) return Promise.resolve();
    return deps.coordinator.handleInbound(msg);
  };

  // Photon signs the exact request bytes, so this route needs the raw body and
  // must be registered before the global JSON parser.
  if (deps.photon && config.photon.inbound === "webhook") {
    const photon = deps.photon;
    app.post("/webhooks/photon", express.raw({ type: "*/*" }), async (req, res) => {
      const result = await photon.handleWebhook(
        { body: req.body, headers: req.headers as Record<string, string> },
        handle,
      );
      res.status(result.status).set(result.headers).send(Buffer.from(result.body));
    });
  }

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Sendblue retries until it gets a response, so acknowledge immediately and
  // process in the background.
  app.post("/webhooks/sendblue", (req, res) => {
    const secret = config.sendblue.webhookSecret;
    const given = req.query.secret ?? req.get("x-webhook-secret");
    if (secret && given !== secret) {
      res.status(401).json({ error: "bad secret" });
      return;
    }
    res.status(200).json({ ok: true });
    handle(parseInbound(req.body ?? {})).catch((err) => {
      console.error("[webhook] failed to handle message:", err);
    });
  });

  app.use(createCalendarRouter(deps.repo));
  return app;
}
