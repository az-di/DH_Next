-- Targeted nudge: a member who voted this round but skipped the leading
-- option gets one DM about it. Recording the round keeps it to once per round.

alter table plan_members add column nudged_round int;
