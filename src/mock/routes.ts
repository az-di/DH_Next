import { readFileSync } from "node:fs";
import { Router, type Request, type Response } from "express";
import { config } from "../config.ts";
import type { MemoryRepo } from "../db/memory.ts";
import type { MockChat } from "../messaging/mock.ts";
import type { Coordinator } from "../plans/coordinator.ts";
import { formatSlot } from "../time.ts";
import { OPEN_STATUSES, type Plan } from "../types.ts";
import type { MockClock } from "./clock.ts";
import { MOCK_BOT, MOCK_GROUP_ID, MOCK_GROUP_NAME, type MockUser } from "./fixtures.ts";

// The /mock group chat (MESSAGING_PROVIDER=mock). Messages typed on the page
// are posted to this server's own /webhooks/sendblue, exactly like the README's
// curl example, so parsing, dedupe, and the coordinator all run for real.

const HOUR = 3_600_000;
/** Fast-forward moves in steps and ticks after each, so reminders fire before the deadline does. */
const STEP_MS = 15 * 60_000;
const TAPBACKS: Record<string, string> = { "👍": "like", "👎": "dislike", "❓": "question" };

export interface MockDemoDeps {
  repo: MemoryRepo;
  chat: MockChat;
  clock: MockClock;
  users: MockUser[];
  timezone: string;
  coordinator: Coordinator;
}

export function createMockRouter(deps: MockDemoDeps): Router {
  const { repo, chat, clock, users, timezone, coordinator } = deps;
  const page = readFileSync(new URL("./page.html", import.meta.url), "utf8");
  const router = Router();
  const isMember = (phone: unknown) => users.some((u) => u.phone === phone);

  const deliver = async (req: Request, body: Record<string, unknown>) => {
    const url = new URL("/webhooks/sendblue", `http://127.0.0.1:${req.socket.localPort}`);
    if (config.sendblue.webhookSecret) url.searchParams.set("secret", config.sendblue.webhookSecret);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to_number: MOCK_BOT,
        group_id: MOCK_GROUP_ID,
        participants: [...users.map((u) => u.phone), MOCK_BOT],
        ...body,
      }),
    });
    if (!res.ok) throw new Error(`webhook returned ${res.status}`);
  };

  const planSummary = async (plan: Plan) => {
    const [slots, responses, members] = await Promise.all([
      repo.listSlots(plan.id, plan.round),
      repo.listResponses(plan.id),
      repo.listMembers(plan.id),
    ]);
    const label = (s: { start: string; end: string }) => formatSlot(new Date(s.start), new Date(s.end), plan.timezone);
    const locked = plan.lockedSlotId ? (await repo.listSlots(plan.id)).find((s) => s.id === plan.lockedSlotId) : null;
    return {
      status: plan.status,
      round: plan.round,
      activity: plan.request.activity,
      deadline: plan.deadline,
      lockedLabel: locked ? label(locked) : null,
      optionalPhones: members.filter((m) => m.role === "optional").map((m) => repo.users.get(m.userId)?.phone),
      options: slots.map((s) => ({
        optionNumber: s.optionNumber,
        label: label(s),
        votes: responses
          .filter((r) => r.slotId === s.id)
          .map((r) => ({ name: repo.users.get(r.userId)?.name ?? "?", vote: r.vote })),
      })),
    };
  };

  const snapshot = async () => {
    const plans = [...repo.plans.values()].filter((p) => p.groupId === MOCK_GROUP_ID);
    const plan = plans.find((p) => OPEN_STATUSES.includes(p.status)) ?? plans.at(-1);
    return {
      groupName: MOCK_GROUP_NAME,
      botName: config.botName,
      botNumber: MOCK_BOT,
      timezone,
      now: clock.now().toISOString(),
      users: users.map(({ phone, name }) => ({ phone, name })),
      messages: chat.messages,
      directs: chat.directs,
      plan: plan ? await planSummary(plan) : null,
    };
  };

  // Live updates over server-sent events. The periodic push also covers state
  // that changes without a new message (a recorded vote, the clock).
  const clients = new Set<Response>();
  let queued = false;
  const broadcast = () => {
    if (queued || clients.size === 0) return;
    queued = true;
    setImmediate(async () => {
      queued = false;
      try {
        const data = `data: ${JSON.stringify(await snapshot())}\n\n`;
        for (const res of clients) res.write(data);
      } catch (err) {
        console.error("[mock] failed to push state:", err);
      }
    });
  };
  chat.onChange(broadcast);
  setInterval(broadcast, 2000).unref();

  router.get("/mock", (_req, res) => {
    res.type("html").send(page);
  });

  router.get("/mock/api/state", async (_req, res) => {
    res.json(await snapshot());
  });

  router.get("/mock/events", (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    broadcast();
  });

  router.post("/mock/api/send", async (req, res) => {
    const { from, text, replyTo } = req.body ?? {};
    const content = String(text ?? "").trim();
    if (!isMember(from) || !content) {
      res.status(400).json({ error: "need a mock user and some text" });
      return;
    }
    const target = chat.messages.some((m) => m.handle === replyTo) ? (replyTo as string) : null;
    const message = chat.post(from, content, target);
    await deliver(req, {
      content,
      from_number: from,
      message_handle: message.handle,
      ...(target && { reply_to: { message_handle: target } }),
    });
    res.json({ ok: true, handle: message.handle });
  });

  router.post("/mock/api/react", async (req, res) => {
    const { from, target, emoji } = req.body ?? {};
    const kind = TAPBACKS[emoji];
    if (!isMember(from) || !kind || !chat.react(String(target), from, emoji)) {
      res.status(400).json({ error: "need a mock user, a message, and one of 👍 👎 ❓" });
      return;
    }
    await deliver(req, {
      content: "",
      from_number: from,
      message_handle: chat.nextHandle("tapback"),
      reaction: kind,
      associated_message_handle: target,
    });
    res.json({ ok: true });
  });

  router.post("/mock/api/fast-forward", async (req, res) => {
    const { hours, to } = req.body ?? {};
    let ms: number;
    if (to === "deadline") {
      const plan = await repo.getOpenPlanForGroup(MOCK_GROUP_ID);
      if (!plan?.deadline) {
        res.status(409).json({ error: "No open plan with a deadline" });
        return;
      }
      ms = Math.max(0, Date.parse(plan.deadline) - clock.now().getTime()) + 1000;
    } else if (Number(hours) > 0 && Number(hours) <= 24 * 14) {
      ms = Number(hours) * HOUR;
    } else {
      res.status(400).json({ error: "pass { hours } or { to: \"deadline\" }" });
      return;
    }
    for (let left = ms; left > 0; left -= STEP_MS) {
      clock.advance(Math.min(STEP_MS, left));
      await coordinator.tick();
    }
    broadcast();
    res.json(await snapshot());
  });

  router.post("/mock/api/reset", async (_req, res) => {
    clearGroup(repo, MOCK_GROUP_ID);
    chat.clear();
    clock.reset();
    res.json(await snapshot());
  });

  return router;
}

/** Deletes every plan in a group and the rows hanging off it. Users are kept. */
export function clearGroup(repo: MemoryRepo, groupId: string) {
  const planIds = new Set([...repo.plans.values()].filter((p) => p.groupId === groupId).map((p) => p.id));
  for (const id of planIds) repo.plans.delete(id);
  repo.members = repo.members.filter((m) => !planIds.has(m.planId));
  repo.slots = repo.slots.filter((s) => !planIds.has(s.planId));
  repo.responses = repo.responses.filter((r) => !planIds.has(r.planId));
  for (const [handle, link] of repo.proposalMessages) {
    if (planIds.has(link.planId)) repo.proposalMessages.delete(handle);
  }
}
