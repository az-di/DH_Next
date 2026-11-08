-- Lets the bot tell which plan a DM is about when someone is in several.

-- The chat's display name, so people can tell two same-named plans apart.
alter table plans add column group_name text;

-- The bot's DMs about each plan, so a reply to one identifies its plan.
create table plan_dm_messages (
  message_id  text primary key,
  plan_id     uuid not null references plans(id) on delete cascade
);
