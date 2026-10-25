-- Initial schema for the group-chat planning agent.
-- Plans are keyed by Sendblue group id; users are keyed by phone number.
-- Privacy: we store OAuth tokens for free/busy lookups only. No event titles,
-- descriptions, or attendees are ever stored.

create extension if not exists "pgcrypto";

create table users (
  id          uuid primary key default gen_random_uuid(),
  phone       text not null unique,          -- E.164
  name        text,
  timezone    text,
  created_at  timestamptz not null default now()
);

create table calendar_connections (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references users(id) on delete cascade,
  provider                 text not null check (provider in ('google')),
  refresh_token            text not null,
  access_token             text,
  access_token_expires_at  timestamptz,
  created_at               timestamptz not null default now(),
  unique (user_id, provider)
);

create table plans (
  id               uuid primary key default gen_random_uuid(),
  group_id         text not null,
  organizer_id     uuid not null references users(id),
  status           text not null check (status in ('collecting', 'proposed', 'locked', 'failed')),
  round            int  not null default 1 check (round between 1 and 3),
  request          jsonb not null,              -- ParsedRequest
  raw_request      text not null,
  timezone         text not null,
  deadline         timestamptz,
  locked_slot_id   uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- At most one open plan per group chat.
create unique index plans_one_open_per_group
  on plans (group_id) where status in ('collecting', 'proposed');

create table plan_members (
  plan_id          uuid not null references plans(id) on delete cascade,
  user_id          uuid not null references users(id) on delete cascade,
  role             text not null default 'essential' check (role in ('essential', 'optional')),
  reminders_sent   int  not null default 0,
  last_reminded_at timestamptz,
  timed_out        boolean not null default false,
  primary key (plan_id, user_id)
);

create table candidate_slots (
  id             uuid primary key default gen_random_uuid(),
  plan_id        uuid not null references plans(id) on delete cascade,
  round          int  not null,
  option_number  int  not null,
  start_at       timestamptz not null,
  end_at         timestamptz not null,
  score          double precision not null default 0,
  unique (plan_id, round, option_number)
);

alter table plans
  add constraint plans_locked_slot_fk foreign key (locked_slot_id) references candidate_slots(id);

create table responses (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references plans(id) on delete cascade,
  slot_id     uuid not null references candidate_slots(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  vote        text not null check (vote in ('yes', 'no', 'maybe')),
  created_at  timestamptz not null default now(),
  unique (slot_id, user_id)                      -- latest vote wins (upsert)
);

-- Maps a bot message id to the slot it proposed, so tapbacks on that message
-- can be resolved to a vote on the right option.
create table proposal_messages (
  message_id  text primary key,
  plan_id     uuid not null references plans(id) on delete cascade,
  slot_id     uuid not null references candidate_slots(id) on delete cascade
);

create index plans_deadline_idx on plans (deadline) where status = 'proposed';
create index responses_plan_idx on responses (plan_id);
