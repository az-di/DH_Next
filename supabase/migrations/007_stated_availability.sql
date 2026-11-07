-- Times a member said work for a plan, on networks where the bot asks by DM.
-- [{ start, end }] in UTC. Null means they haven't answered; [] means nothing works.

alter table plan_members add column stated_availability jsonb;
