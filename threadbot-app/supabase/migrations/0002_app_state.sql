-- Per-account key/value state. The mobile app mirrors its localStorage (closet,
-- designs, profile, prompts, branding, conversations, settings, favorites) into
-- this table so it is saved per account and recalled on any device.

create table if not exists app_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table app_state enable row level security;

-- Each user can only see and change their own rows (enforced via their auth JWT).
create policy app_state_select on app_state
  for select using (auth.uid() = user_id);
create policy app_state_insert on app_state
  for insert with check (auth.uid() = user_id);
create policy app_state_update on app_state
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy app_state_delete on app_state
  for delete using (auth.uid() = user_id);
