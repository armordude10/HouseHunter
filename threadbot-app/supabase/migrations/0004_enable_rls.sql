-- Close the public/anon exposure on the data tables (Supabase Security Advisor:
-- rls_enabled_in_public, CRITICAL).
--
-- Both tables are written/read only via the service_role key (the Node backend in
-- src/core/supabaseStore.ts + retriever.ts, and the scripts/ tooling) — service_role
-- bypasses RLS. The mobile/anon client never queries these tables directly (it only
-- touches app_state + app_config). So enabling RLS with NO policies is the correct
-- fix: it denies all anon/authenticated access while leaving the backend untouched.
--
-- The resulting "RLS enabled, no policy" advisor notice is INFO-level and intended:
-- it is the recommended posture for service-role-only tables.
alter table public.design_specs enable row level security;
alter table public.catalog_products enable row level security;
