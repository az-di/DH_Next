-- Manual scheduling preferences, set in chat or on the connect page.
-- Preferred times/days only affect scoring; `never` is a hard filter.
-- Nothing here comes from calendar contents.

create table user_preferences (
  user_id          uuid primary key references users(id) on delete cascade,
  preferred_times  text[] not null default '{}'
                   check (preferred_times <@ array['morning', 'afternoon', 'evening', 'night']),
  preferred_days   int[]  not null default '{}',   -- 0 = Sunday
  never            jsonb  not null default '[]',   -- [{ days: int[], from: hours, to: hours }], local time
  updated_at       timestamptz not null default now()
);
