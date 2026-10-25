-- Round bookkeeping for the plan state machine:
-- * organizer_pick: all 3 rounds failed; organizer chooses from best partial options.
-- * round_started_at: when the current round's proposal went out (reminder timing).

alter table plans drop constraint plans_status_check;
alter table plans add constraint plans_status_check
  check (status in ('collecting', 'proposed', 'organizer_pick', 'locked', 'failed'));

alter table plans add column round_started_at timestamptz;

drop index plans_one_open_per_group;
create unique index plans_one_open_per_group
  on plans (group_id) where status in ('collecting', 'proposed', 'organizer_pick');

drop index plans_deadline_idx;
create index plans_deadline_idx on plans (deadline) where status in ('collecting', 'proposed');
