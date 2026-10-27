# Testing the bot on Photon (Pro plan)

This walks through testing the planning bot on a Photon **Pro** project, from
"does the line work at all" to a full group plan. Each step tells you what to
look for in the iMessage app and in the server terminal.

**Pro-plan facts that shape the test** (from Photon's Stable/Spectrum docs):

- Pro uses a **shared pool of lines**. Each person is routed through a pool
  number, which can differ from person to person.
- A shared line **only messages people registered as Users** of your project.
  Anyone else fails with `Target not allowed for this project`.
- Pro **can't create group chats** and gets **no group-change events**
  (members added or removed, renames). Photon doesn't say whether a pool line
  receives messages in a group that a *person* creates. **Step 4 checks this.**
  If it fails, groups need the Business plan (a dedicated line).

## 0. Prerequisites

- Node 24 (`node --version`) and this repo with `npm install` done.
- Your Photon project ID and secret: [app.photon.codes](https://app.photon.codes),
  then your project, then **Settings**.
- 1–2 friends with iPhones who agree to test. You'll register their numbers.

## 1. Register everyone as Users

In the [dashboard](https://app.photon.codes), go to your project, then
**Users**, and add yourself and each tester. The Photon CLI's
`photon spectrum users add` does the same thing.

Add each person's handle exactly as iMessage sends it. If you're unsure, have
them text [debug.photon.codes](https://debug.photon.codes). It replies with the
exact phone number or email Apple is sending from. If it reports an email, they
can switch to their number in **Settings → Messages → Send & Receive → Start
new conversations from**.

## 2. Configure and start the bot

Create `.env` in the repo root:

```
MESSAGING_PROVIDER=photon
SPECTRUM_PROJECT_ID=your-project-id
SPECTRUM_PROJECT_SECRET=your-project-secret
PHOTON_INBOUND=stream
BOT_NAME=planner
DEFAULT_TIMEZONE=America/Los_Angeles
SCHEDULER_INTERVAL_MS=15000
```

Leave Supabase, Google, and Anthropic blank for the first run. The bot then
uses the in-memory store, rule-based parsing, and template messages, so there
are fewer moving parts. `stream` mode keeps a connection open to Photon, so you
don't need a tunnel or public URL.

Start it with the env file loaded:

```bash
node --env-file=.env src/index.ts
```

You should see `[server] listening on :3000 (messaging: photon)` and
`[photon] listening for iMessages on the Spectrum stream`. If you see
`Could not connect to Photon`, re-check the project ID and secret.

## 3. Check the line with a direct message

You need your project's line number. Find it under **Lines** in the dashboard,
or run `photon spectrum lines ls`. Text that number from your iPhone:

> hi

**Expected:** within a few seconds the bot replies *"Hi! I plan things for
group chats. Add me to your group…"*. That proves inbound and outbound both
work.

If nothing arrives:

- No log line at all: your handle probably isn't registered (step 1).
- A `Target not allowed` error in the terminal: the registered handle doesn't
  match the one iMessage uses. Use the debug line.

## 4. Check that a group works on Pro (the deciding test)

1. On your iPhone, create a new iMessage group with a registered friend and
   the line number.
2. Send: `@planner lunch tomorrow`

**Expected:** the bot replies "On it!…", then an intro message, then 1–3
separate bubbles like `Option 1: Mon, Oct 26, 12:00–1:30 PM`.

**If the bot never responds in the group** (and the terminal shows nothing),
the Pro shared pool isn't delivering group messages. Stop here. Groups need
the Business plan. Ask Photon support ([help@photon.codes](mailto:help@photon.codes))
to confirm. Don't continue with group testing until that's settled.

**If the terminal shows the message but sending fails**, copy the error. A
`Target not allowed` here means a group member isn't registered (step 1).

## 5. Vote and lock a time

With no calendars connected, the bot is unsure, so it sends several options.
For lunch that's 2, because only two 90-minute lunches fit between 11 and 2
(the bot never proposes times outside an activity's usual hours). Test each
voting style in this order (you plus one friend):

| Who | Action | Expected |
|---|---|---|
| You | Tapback thumbs down on the Option 2 bubble | Nothing posted. It's waiting for your friend. |
| Friend | Reply `1 maybe, 2 yes` | Still nothing. You skipped option 1, which counts as no answer (not a no), and you said no to option 2. |
| You | Reply `2` | Your option 2 vote changes to yes. Option 2 now has a yes or maybe from everyone, so the bot posts **Locked in: lunch, …** (after a party emoji) with option 2's time. |

An option with a yes or maybe from every essential member locks right away.
If every option has a no from an essential member, the bot moves to the next
round. Otherwise it waits for the deadline, then picks the best option that no
essential member said no to, counting a maybe as half a yes. Skipped options
count as no answer, and anyone who voted on at least one option gets no
reminders.

## 6. Rounds (optional)

Start a new plan in the same group: `@planner drinks friday`. Then have
everyone reply `none`.

**Expected:** "That one didn't work, so here are N more…" with new times that
don't overlap the rejected ones. Rejecting 3 rounds in a row ends with a
numbered list for the organizer, who replies with a number to lock it.

## 7. Reminders and deadlines (optional, quick version)

The deadline is the sooner of 24 hours or halfway to the earliest option. To
see reminders in minutes instead of hours, ask for something happening soon:

```
@planner coffee today
```

Then have one person not vote. With `SCHEDULER_INTERVAL_MS=15000`, they get up
to 2 reminder DMs as the deadline approaches. At the deadline the bot decides
without them and DMs them the outcome.

## 8. Add the optional services

Each one is independent. Add it to `.env` and restart:

- **Claude** (`ANTHROPIC_API_KEY`): better request parsing, friendlier wording.
- **Google Calendar** (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, plus a
  public `PUBLIC_BASE_URL`): members get a connect link by DM, and the bot
  waits up to 10 minutes for connections before proposing. The OAuth redirect
  needs a public URL, for example from a `cloudflared` tunnel.
- **Supabase** (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, after running
  `supabase/migrations/*.sql`): plans survive restarts.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Could not connect to Photon` at startup | Wrong project ID or secret |
| DM works, group is silent | Pro shared pool not delivering group messages (step 4) |
| `Target not allowed for this project` | Recipient not registered under Users, or handle mismatch (use debug.photon.codes) |
| Bot ignores `@planner …` | `BOT_NAME` doesn't match what you typed after `@` |
| Bot says "still working on …" | A plan is already open in that group; finish voting on it first |
| Times look off by hours | Set `DEFAULT_TIMEZONE` to your IANA zone |

Webhook mode (`PHOTON_INBOUND=webhook`) is for deployed servers. Set
`SPECTRUM_WEBHOOK_SECRET`, configure Photon to POST to
`${PUBLIC_BASE_URL}/webhooks/photon`, and the SDK verifies the signature.
