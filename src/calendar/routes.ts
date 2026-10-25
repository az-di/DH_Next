import { Router } from "express";
import { hasGoogle } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import { buildAuthUrl, exchangeCode } from "./google.ts";
import { verifyConnectToken } from "./links.ts";

// The small "connect your calendar" web flow. The bot texts each member a
// signed /connect link; the token rides through Google OAuth as `state`.

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1d1d1f}
  a.button{display:inline-block;background:#0a84ff;color:#fff;padding:.75rem 1.25rem;border-radius:.75rem;text-decoration:none;font-weight:600}
  .muted{color:#6e6e73;font-size:.9rem}
</style></head><body>${body}</body></html>`;

export function createCalendarRouter(repo: Repo): Router {
  const router = Router();

  router.get("/connect", async (req, res) => {
    const token = String(req.query.t ?? "");
    const userId = verifyConnectToken(token);
    if (!userId || !(await repo.getUser(userId))) {
      res.status(400).send(page("Link expired", "<h1>This link has expired</h1><p>Ask the bot for a new one.</p>"));
      return;
    }
    if (!hasGoogle()) {
      res.status(503).send(page("Unavailable", "<h1>Calendar connections are not set up yet</h1>"));
      return;
    }
    res.send(
      page(
        "Connect your calendar",
        `<h1>Connect your calendar</h1>
         <p>This lets the planner find times when you're free, so you get fewer back-and-forth questions.</p>
         <p class="muted">We only see <strong>when</strong> you're busy, never event titles, locations, or who you're meeting.
         You can disconnect any time from your Google account settings.</p>
         <p><a class="button" href="${buildAuthUrl(token)}">Connect Google Calendar</a></p>`,
      ),
    );
  });

  router.get("/oauth/google/callback", async (req, res) => {
    const userId = verifyConnectToken(String(req.query.state ?? ""));
    if (!userId) {
      res.status(400).send(page("Link expired", "<h1>This link has expired</h1>"));
      return;
    }
    if (req.query.error || !req.query.code) {
      res.send(page("Not connected", "<h1>No problem</h1><p>Your calendar wasn't connected. You can still vote in the chat.</p>"));
      return;
    }
    try {
      const tokens = await exchangeCode(String(req.query.code));
      await repo.saveCalendarConnection({ userId, provider: "google", ...tokens });
      res.send(page("Connected", "<h1>You're all set ✅</h1><p>Head back to your group chat.</p>"));
    } catch (err) {
      console.error("[calendar] oauth callback failed:", err);
      res.status(500).send(page("Something went wrong", "<h1>Something went wrong</h1><p>Please try the link again.</p>"));
    }
  });

  return router;
}
