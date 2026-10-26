import express, { Router } from "express";
import { hasGoogle } from "../config.ts";
import type { Repo } from "../db/repo.ts";
import {
  describeBlock,
  EMPTY_PREFERENCES,
  hourLabel,
  mergePreferences,
  normalizeBlock,
  TIME_OF_DAY,
} from "../plans/preferences.ts";
import type { Preferences, TimeOfDay, User, WeeklyBlock } from "../types.ts";
import { buildAuthUrl, exchangeCode } from "./google.ts";
import { verifyConnectToken } from "./links.ts";

// The small "connect your calendar" web flow. The bot texts each member a
// signed /connect link; the token rides through Google OAuth as `state`.
// The same form (name + preferences) is also served on its own at
// /preferences, for editing without connecting a calendar.

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1d1d1f}
  a.button{display:inline-block;background:#0a84ff;color:#fff;padding:.75rem 1.25rem;border-radius:.75rem;text-decoration:none;font-weight:600}
  .muted{color:#6e6e73;font-size:.9rem}
  label.field,legend{display:block;font-weight:600;margin:1.25rem 0 .35rem}
  input[type=text]{width:100%;box-sizing:border-box;font:inherit;padding:.6rem .75rem;border:1px solid #d2d2d7;border-radius:.6rem}
  select{font:inherit;padding:.3rem .5rem;border:1px solid #d2d2d7;border-radius:.5rem}
  fieldset{border:0;padding:0;margin:0}
  .chips{display:flex;flex-wrap:wrap;gap:.4rem .9rem}
  .chips label{font-weight:400;white-space:nowrap}
  .row{margin:.4rem 0}
  .saved{background:#e8f8ec;color:#1b6b34;padding:.5rem .75rem;border-radius:.6rem}
  button.button{border:0;font:inherit;cursor:pointer;margin-top:1.5rem}
</style></head><body>${body}</body></html>`;

const expired = () => page("Link expired", "<h1>This link has expired</h1><p>Ask the bot for a new one.</p>");

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** What people type in "What should we call you?": trimmed, single-spaced, at most 40 characters. */
export function cleanName(raw: unknown): string | null {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  return /^[\p{L}][\p{L}' .-]*$/u.test(name) ? name : null;
}

const TIMES = Object.keys(TIME_OF_DAY) as TimeOfDay[];
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const NOT_BEFORE_HOURS = [7, 8, 9, 10, 11, 12];
const NOT_AFTER_HOURS = [17, 18, 19, 20, 21, 22, 23];

/** Splits saved "never" blocks into what the form's simple controls can show, plus the rest. */
function neverControls(never: WeeklyBlock[]) {
  const controls = { times: new Set<TimeOfDay>(), days: new Set<number>(), notBefore: null as number | null, notAfter: null as number | null };
  const other: WeeklyBlock[] = [];
  for (const b of never) {
    const everyDay = b.days.join() === ALL_DAYS.join();
    const bucket = TIMES.find((t) => TIME_OF_DAY[t].from === b.from && TIME_OF_DAY[t].to === b.to && t !== "night");
    if (everyDay && bucket) controls.times.add(bucket);
    else if (b.from <= 0 && b.to >= 24) b.days.forEach((d) => controls.days.add(d));
    else if (everyDay && b.from <= 0 && controls.notBefore === null) controls.notBefore = b.to;
    else if (everyDay && b.to >= 24 && controls.notAfter === null) controls.notAfter = b.from;
    else other.push(b);
  }
  return { ...controls, other };
}

const checkbox = (name: string, value: string | number, label: string, checked: boolean) =>
  `<label><input type="checkbox" name="${name}" value="${value}"${checked ? " checked" : ""}> ${label}</label>`;

function hourSelect(name: string, hours: number[], selected: number | null) {
  const options = selected !== null && !hours.includes(selected) ? [...hours, selected].sort((a, b) => a - b) : hours;
  return `<select name="${name}"><option value="">—</option>${options
    .map((h) => `<option value="${h}"${h === selected ? " selected" : ""}>${hourLabel(h)}</option>`)
    .join("")}</select>`;
}

/** Name and preferences, prefilled with what's saved (including anything set in chat). */
function profileFields(user: User, prefs: Preferences): string {
  const never = neverControls(prefs.never);
  return `
    <label class="field" for="name">What should we call you? <span class="muted">(optional)</span></label>
    <input type="text" id="name" name="name" maxlength="40" autocomplete="given-name" value="${escapeHtml(user.name ?? "")}">

    <fieldset><legend>Times you prefer <span class="muted">(optional)</span></legend>
      <div class="chips">${TIMES.map((t) => checkbox("times", t, `${t[0].toUpperCase()}${t.slice(1)}s`, prefs.preferredTimes.includes(t))).join("")}</div>
    </fieldset>
    <fieldset><legend>Days you prefer <span class="muted">(optional)</span></legend>
      <div class="chips">${DAY_LABELS.map((d, i) => checkbox("days", i, d, prefs.preferredDays.includes(i))).join("")}</div>
    </fieldset>

    <fieldset><legend>Times that never work <span class="muted">(optional)</span></legend>
      <p class="muted">The planner won't propose these at all.</p>
      <div class="chips">${TIMES.filter((t) => t !== "night")
        .map((t) => checkbox("never_times", t, `${t[0].toUpperCase()}${t.slice(1)}s`, never.times.has(t)))
        .join("")}</div>
      <div class="chips row">${DAY_LABELS.map((d, i) => checkbox("never_days", i, `${d} (all day)`, never.days.has(i))).join("")}</div>
      <div class="row">Nothing before ${hourSelect("not_before", NOT_BEFORE_HOURS, never.notBefore)}
        · nothing after ${hourSelect("not_after", NOT_AFTER_HOURS, never.notAfter)}</div>
      ${never.other
        .map((b) => `<div class="row">${checkbox("keep_never", escapeHtml(JSON.stringify(b)), describeBlock(b), true)}</div>`)
        .join("")}
    </fieldset>`;
}

const list = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** The form's fields back into Preferences. The form shows everything saved, so this replaces it. */
export function readPreferences(body: Record<string, unknown>): Preferences {
  const hour = (v: unknown) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
  const never: WeeklyBlock[] = list(body.never_times)
    .filter((t): t is TimeOfDay => TIMES.includes(t as TimeOfDay))
    .map((t) => ({ days: ALL_DAYS, ...TIME_OF_DAY[t] }));
  const neverDays = list(body.never_days).map(Number);
  if (neverDays.length) never.push({ days: neverDays, from: 0, to: 24 });
  const notBefore = hour(body.not_before);
  if (notBefore !== null) never.push({ days: ALL_DAYS, from: 0, to: notBefore });
  const notAfter = hour(body.not_after);
  if (notAfter !== null) never.push({ days: ALL_DAYS, from: notAfter, to: 24 });
  for (const raw of list(body.keep_never)) {
    try {
      const b = normalizeBlock(JSON.parse(raw));
      if (b) never.push(b);
    } catch {
      // A tampered value is just dropped.
    }
  }
  return mergePreferences(null, {
    preferredTimes: list(body.times).filter((t): t is TimeOfDay => TIMES.includes(t as TimeOfDay)),
    preferredDays: list(body.days).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    never,
  });
}

export function createCalendarRouter(repo: Repo): Router {
  const router = Router();
  const form = express.urlencoded({ extended: false });

  const userFor = async (token: string) => {
    const userId = verifyConnectToken(token);
    return userId ? await repo.getUser(userId) : null;
  };

  /** Saves the name (same field as "@planner I'm Sam") and preferences from a submitted form. */
  const saveProfile = async (user: User, body: Record<string, unknown>) => {
    const name = cleanName(body.name);
    if (name && name !== user.name) await repo.upsertUserByPhone(user.phone, { name });
    await repo.savePreferences(user.id, readPreferences(body));
  };

  router.get("/connect", async (req, res) => {
    const token = String(req.query.t ?? "");
    const user = await userFor(token);
    if (!user) {
      res.status(400).send(expired());
      return;
    }
    if (!hasGoogle()) {
      res.status(503).send(page("Unavailable", "<h1>Calendar connections are not set up yet</h1>"));
      return;
    }
    const prefs = (await repo.getPreferences(user.id)) ?? EMPTY_PREFERENCES;
    res.send(
      page(
        "Connect your calendar",
        `<h1>Connect your calendar</h1>
         <p>This lets the planner find times when you're free, so you get fewer back-and-forth questions.</p>
         <p class="muted">We only see <strong>when</strong> you're busy, never event titles, locations, or who you're meeting.
         You can disconnect any time from your Google account settings.</p>
         <form method="post" action="/connect">
           <input type="hidden" name="t" value="${escapeHtml(token)}">
           ${profileFields(user, prefs)}
           <button class="button" type="submit">Connect Google Calendar</button>
         </form>`,
      ),
    );
  });

  // Saves the profile, then continues to Google.
  router.post("/connect", form, async (req, res) => {
    const token = String(req.body?.t ?? "");
    const user = await userFor(token);
    if (!user) {
      res.status(400).send(expired());
      return;
    }
    await saveProfile(user, req.body ?? {});
    if (!hasGoogle()) {
      res.status(503).send(page("Unavailable", "<h1>Calendar connections are not set up yet</h1>"));
      return;
    }
    res.redirect(303, buildAuthUrl(token));
  });

  router.get("/preferences", async (req, res) => {
    const token = String(req.query.t ?? "");
    const user = await userFor(token);
    if (!user) {
      res.status(400).send(expired());
      return;
    }
    const prefs = (await repo.getPreferences(user.id)) ?? EMPTY_PREFERENCES;
    res.send(
      page(
        "Your preferences",
        `<h1>When works for you?</h1>
         ${req.query.saved ? `<p class="saved">Saved ✓</p>` : ""}
         <p class="muted">The planner uses this when it picks times. You can also tell it in the group chat,
         like "@planner I don't do mornings".</p>
         <form method="post" action="/preferences">
           <input type="hidden" name="t" value="${escapeHtml(token)}">
           ${profileFields(user, prefs)}
           <button class="button" type="submit">Save</button>
         </form>`,
      ),
    );
  });

  router.post("/preferences", form, async (req, res) => {
    const token = String(req.body?.t ?? "");
    const user = await userFor(token);
    if (!user) {
      res.status(400).send(expired());
      return;
    }
    await saveProfile(user, req.body ?? {});
    res.redirect(303, `/preferences?t=${encodeURIComponent(token)}&saved=1`);
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
