import { readFileSync } from "node:fs";
import { Router, type Response } from "express";
import { createConnectToken } from "../calendar/links.ts";
import { config } from "../config.ts";
import { describePreferences } from "../plans/preferences.ts";
import type { MemoryRepo } from "../db/memory.ts";
import type { InboundMessage } from "../messaging/types.ts";
import type { Coordinator } from "../plans/coordinator.ts";
import { formatSlot } from "../time.ts";
import { OPEN_STATUSES, type Plan } from "../types.ts";
import type { MockChat } from "./chat.ts";
import type { MockClock } from "./clock.ts";
import { MOCK_BOT, MOCK_GROUP_ID, MOCK_GROUP_NAME, type MockUser } from "./fixtures.ts";

// The /mock group chat (MESSAGING_PROVIDERS=mock). Messages typed on the page
// go straight to the real coordinator as normalized inbound messages.

const HOUR = 3_600_000;
/** Fast-forward moves in steps and ticks after each, so reminders fire before the deadline does. */
const STEP_MS = 15 * 60_000;
const TAPBACKS = new Set(["👍", "👎", "❓"]);

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

  // Handled in the background, as with a real provider, so the page stays responsive.
  const deliver = (message: Pick<InboundMessage, "messageHandle" | "from" | "text" | "replyToHandle" | "reaction">) => {
    coordinator
      .handleInbound({
        ...message,
        botAddress: MOCK_BOT,
        groupId: MOCK_GROUP_ID,
        participants: [...users.map((u) => u.phone), MOCK_BOT],
        isOutbound: false,
      })
      .catch((err) => console.error("[mock] failed to handle message:", err));
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
      optionalPhones: members.filter((m) => m.role === "optional").map((m) => repo.users.get(m.userId)?.address),
      options: slots.map((s) => ({
        optionNumber: s.optionNumber,
        label: label(s),
        votes: responses
          .filter((r) => r.slotId === s.id)
          .map((r) => ({ name: repo.users.get(r.userId)?.name ?? "?", vote: r.vote })),
      })),
    };
  };

  // One preferences link per user, so the snapshot (and the page) stays stable between pushes.
  const prefsLinks = new Map<string, string>();
  const memberInfo = async ({ phone, name }: MockUser) => {
    const user = await repo.upsertUserByAddress(phone);
    if (!prefsLinks.has(user.id)) prefsLinks.set(user.id, `/preferences?t=${encodeURIComponent(createConnectToken(user.id))}`);
    const prefs = await repo.getPreferences(user.id);
    return { phone, name, prefsUrl: prefsLinks.get(user.id)!, preferences: prefs ? describePreferences(prefs) : null };
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
      users: await Promise.all(users.map(memberInfo)),
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
    deliver({ messageHandle: message.handle, from, text: content, replyToHandle: target, reaction: null });
    res.json({ ok: true, handle: message.handle });
  });

  router.post("/mock/api/react", async (req, res) => {
    const { from, target, emoji } = req.body ?? {};
    if (!isMember(from) || !TAPBACKS.has(emoji) || !chat.react(String(target), from, emoji)) {
      res.status(400).json({ error: "need a mock user, a message, and one of 👍 👎 ❓" });
      return;
    }
    deliver({
      messageHandle: chat.nextHandle("tapback"),
      from,
      text: "",
      replyToHandle: null,
      reaction: { kind: emoji, targetHandle: String(target), quotedText: null },
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

  // "Reset chat" keeps people's preferences, like real users between plans;
  // { everything: true } also clears them and restores the seeded names, so a demo starts clean.
  router.post("/mock/api/reset", async (req, res) => {
    clearGroup(repo, MOCK_GROUP_ID);
    chat.clear();
    clock.reset();
    if (req.body?.everything === true) {
      for (const { phone, name } of users) {
        const user = await repo.upsertUserByAddress(phone, { name });
        repo.preferences.delete(user.id);
      }
    }
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
