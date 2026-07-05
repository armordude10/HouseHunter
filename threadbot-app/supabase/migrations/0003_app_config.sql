-- Remote app config (publicly readable) so the mobile app can fetch its backend URL
-- and have it changed without a reinstall.
create table if not exists app_config (
  key text primary key,
  value text not null default ''
);

alter table app_config enable row level security;
create policy app_config_public_read on app_config for select using (true);

insert into app_config (key, value) values ('backend_url', '')
  on conflict (key) do nothing;
