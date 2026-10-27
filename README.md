# DH_Next: group-chat planning agent

Add the bot's number to an iMessage group chat, @mention it with a rough request
("dinner sometime next weekend"), and it finds a time that works for everyone.
It reads free/busy from connected calendars, proposes one time when it's
confident (2–3 when it isn't), collects thumbs-up / thumbs-down / question-mark votes, and posts the locked-in
time back to the group.

## How a plan flows

```
@planner dinner next weekend
        │
        ▼
 collecting ── DM "connect your calendar" links, wait ≤10 min
        │
        ▼
 proposed (round 1) ── 1 option if confident, 2–3 if not; one bubble per option
        │  votes: tapbacks (thumbs up = yes / thumbs down = no / question mark = maybe) or replies ("2", "1 and 3", "none")
        │  reminders: ≤2 per person at 50% / 85% to people who haven't voted;
        │    a voter who skipped the leading option gets one nudge about it instead
        │  deadline: 24h or halfway to the earliest slot, whichever is sooner
        ├── yes/maybe from every essential member ▶ locked ✓ (posted to the group)
        ├── deadline, viable slot ────────────────▶ locked (best = yes + ½·maybe)
        └── every slot has an essential "no" ─────▶ round 2 (≥2 new options, rejected times excluded)
                                                    … round 3 …
                                                    ▼
                                             organizer_pick ── organizer replies with a number ──▶ locked
```

Quorum defaults to everyone. The organizer can mark people optional or required
by name, when starting the plan or any time after: `@planner dinner next weekend,
Sam is optional`, `@planner Sam and Priya are required`, `@planner make Theo optional`.
Phone numbers still work (`optional: +15551234567`). An optional member's "no"
lowers a slot's score but doesn't block it.

Neither Photon nor Sendblue gives the bot contact names, so people tell it theirs:
`@planner I'm Sam`. If a name is unknown or matches more than one person, the bot
asks once. An unknown name is applied as soon as that person introduces themselves,
and the organizer answers "Which Sam?" with the full name (`@planner Sam Patel`).

## Stack

| Layer | Choice |
|---|---|
| Messaging | Photon Spectrum (`spectrum-ts`, cloud iMessage) by default; Sendblue as an alternative |
| Backend | Node 24 + TypeScript (run directly via Node type stripping), Express |
| Database | Supabase Postgres (`supabase/migrations`), in-memory fallback for dev/tests |
| Calendar | Google OAuth, `calendar.freebusy` scope only |
| Slot finding | Deterministic code, no LLM |
| LLM | Claude (`claude-opus-5-5`) parses requests and writes friendly copy; rules/templates as fallback |
| Scheduler | In-process interval for grace periods, reminders, and deadlines |

## Layout

```
src/
  index.ts               entry: wires repo, messenger, brain, coordinator, scheduler
  server.ts              Express: /webhooks/sendblue, /health, calendar routes
  config.ts              env config; every integration is optional
  types.ts               domain types (mirror the SQL schema)
  time.ts                Intl-based timezone helpers
  db/                    Repo interface, Supabase + in-memory implementations
  messaging/             Photon + Sendblue adapters, inbound parsing, @mentions, vote parsing
  calendar/              signed connect links, Google OAuth + free/busy, slot scoring
  llm/                   Brain interface, Claude implementation, rules + templates
  plans/                 pure round rules, coordinator, per-group lock
  mock/                  /mock demo chat: fake group, seeded calendars, fast-forward clock
supabase/migrations      Postgres schema
test/                    node:test suites (no network, fake clock)
```

## Running locally

```bash
npm install
cp .env.example .env   # fill in what you have; blanks fall back to local stubs
npm run dev
```

`npm run dev` and `npm run mock` load `.env` if it exists, and variables already
set in your shell take precedence over it. `npm start` reads only the process
environment, so on a host set variables in its dashboard (or your
infrastructure config) instead of shipping a `.env`. Tests never load `.env`.

To run on Photon, follow [docs/testing-photon.md](docs/testing-photon.md).

With no keys at all, the bot runs fully offline. It uses an in-memory DB,
logs messages instead of sending them, parses requests with rules, and treats
everyone as having no calendar connected. To simulate a group chat:

```bash
curl -X POST localhost:3000/webhooks/sendblue -H 'content-type: application/json' -d '{"content":"@planner dinner next weekend","from_number":"+15550000001","to_number":"+15550000000","group_id":"g1","participants":["+15550000001","+15550000002"],"message_handle":"m1"}'
```

Tests: `npm test`. Type check: `npm run typecheck`.

## Mock group chat (local dev and demo backup)

An iMessage-style group chat in the browser, for when you don't want (or can't
get) real iMessage. It runs the real bot end to end, and only the phone is fake.

```bash
npm run mock          # same as npm run dev with MESSAGING_PROVIDER=mock
open http://localhost:3000/mock
```

- **Group**: "Weekend Crew" with Maya, Jordan, Priya, Sam, and Theo
  (`+15550000001`–`5`). Pick who you're typing as from the avatar left of the
  text field. The bot is `+15550000000`.
- **Real inbound path**: each message is POSTed to this server's own
  `/webhooks/sendblue`, the same as the curl example above, so parsing,
  dedupe, @mentions, and vote handling all run for real. Tapbacks are sent
  as Sendblue-style structured reactions.
- **Tapbacks and replies**: double-click, right-click, or long-press a bubble
  for thumbs up / thumbs down / question mark. Drag a bubble to the right (or choose **Reply**) to reply
  to it. A reply of "no" to an option bubble counts as a vote on that option.
- **Seeded calendars**: everyone has weekly free/busy (work hours, a class, a
  Saturday commitment). For `@planner dinner next weekend` you get Saturday
  6:00 PM and Sunday 7:00 PM, the times everyone is free. Turn both down and
  round 2 offers Saturday 8:00 PM. Turn that down too and no dinner-time slot
  is left, so the organizer picks from the closest options.
- **Fast-forward**: **+1 hour**, **+12 hours**, and **To deadline** move the
  scheduler's clock in 15-minute steps, so reminders (50% / 85%), deadlines,
  and new rounds fire in order. Reminder and timeout DMs appear in the side panel.
- **Reset** clears the group's plans, votes, messages, and the demo clock.

Mock mode always uses its own in-memory store (Supabase is ignored), so demo
data never reaches production. Claude is used if `ANTHROPIC_API_KEY` is set,
otherwise templates. The page follows the system light/dark setting.

Suggested demo script:

1. As Maya, send `@planner dinner next weekend`. The bot offers Sat 6:00 PM
   and Sun 7:00 PM.
2. As Sam, reply `none`. An essential "no" on every option starts round 2
   right away, which offers Sat 8:00–10:00 PM. It never re-offers a rejected
   time and never goes outside dinner hours.
3. As Maya, Jordan, Priya, and Sam, thumbs-up the round-2 option. Theo stays quiet.
4. Hit **+12 hours** to show Theo's reminder DM, then **To deadline** to lock
   in Saturday 8 PM without him. Theo gets a heads-up DM.

## Going live

1. **Supabase**: run `supabase/migrations/*.sql` in order, then set `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`.
2. **Photon**: set `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET`. Inbound uses the Spectrum stream by default (no public URL needed). Set `PHOTON_INBOUND=webhook` + `SPECTRUM_WEBHOOK_SECRET` to receive at `${PUBLIC_BASE_URL}/webhooks/photon` instead. On Free/Pro, register every participant under **Users** in the dashboard. Step by step: [docs/testing-photon.md](docs/testing-photon.md).
   *Alternative, Sendblue* (group messaging needs Sapphire or above): set the API key/secret and `SENDBLUE_FROM_NUMBER`, and point the receive webhook at `${PUBLIC_BASE_URL}/webhooks/sendblue?secret=${SENDBLUE_WEBHOOK_SECRET}`.
3. **Google**: create an OAuth client, add redirect URI `${PUBLIC_BASE_URL}/oauth/google/callback`, and add testers. An unverified app is fine for ≤100 users.
4. **Claude**: set `ANTHROPIC_API_KEY`. Calls use structured outputs, low effort, and server-side refusal fallback. Any failure falls back to rules/templates.
5. Set a strong `LINK_SECRET`.

## Privacy

- Only free/busy blocks are read, never event titles or details (the OAuth scope can't see them).
- The bot acts only on messages that @mention it or vote on its open proposal.
- Preferences will be learned from how people respond, not from calendar contents.

## Open risks / next steps

- **Photon Pro uses a shared pool of lines.** Pro can't create groups, gets no group-change events, and only messages
  registered users. Photon doesn't document whether a pool line receives messages in a group a person creates, so
  [docs/testing-photon.md](docs/testing-photon.md) checks that first. Business (dedicated line) supports groups fully.
- **Tapbacks (Sendblue only)**: Photon delivers native reactions, but Sendblue doesn't document inbound reaction fields. We accept likely
  structured fields plus iMessage's `Liked "…"` text form, and numbered replies always
  work. Confirm with a real webhook capture.
- **Scale**: the per-group lock, webhook dedupe, and scheduler are in-process. Running
  more than one instance needs a Postgres advisory lock and a single scheduler/queue.
- Roadmap: iMessage app extension, native app with actionable notifications, SMS
  fallback, places/activities, Outlook/iCloud calendars, preference learning.