import express, { type Express } from "express";
import { createCalendarRouter } from "./calendar/routes.ts";
import type { Repo } from "./db/repo.ts";
import type { InboundHandler, Provider } from "./messaging/types.ts";
import { createMockRouter, type MockDemoDeps } from "./mock/routes.ts";
import type { Coordinator } from "./plans/coordinator.ts";

export function createServer(deps: {
  repo: Repo;
  coordinator: Coordinator;
  /** Providers mount their own webhook routes, delivering to onMessage. */
  inbound?: { providers: Provider[]; onMessage: InboundHandler };
  /** Mounts the /mock group chat. Only set when MESSAGING_PROVIDER=mock. */
  mock?: Omit<MockDemoDeps, "coordinator">;
}): Express {
  const app = express();
  for (const provider of deps.inbound?.providers ?? []) {
    provider.routes?.(app, deps.inbound!.onMessage);
  }

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  if (deps.mock) app.use(createMockRouter({ ...deps.mock, coordinator: deps.coordinator }));
  app.use(createCalendarRouter(deps.repo));
  return app;
}
