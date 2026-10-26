-- Role changes by name ("Sam is optional") that are waiting on a name the bot
-- couldn't match yet: [{ name, role, candidates: [user ids] }].

alter table plans add column pending_roles jsonb not null default '[]';
