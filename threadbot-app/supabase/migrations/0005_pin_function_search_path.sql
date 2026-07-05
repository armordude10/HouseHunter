-- Hardening (Supabase Security Advisor: function_search_path_mutable, WARN).
-- Pin the function's search_path so it can't be resolved against an attacker-
-- controlled schema. Body is identical to 0001_init.sql's definition.
create or replace function public.match_catalog_products(
  query_embedding vector(1536),
  match_count int default 8
)
returns table (
  id text,
  name text,
  keywords text[],
  default_color text,
  is_default boolean,
  technique text,
  primary_placement text,
  providers jsonb,
  similarity float
)
language sql stable
set search_path = public
as $$
  select
    c.id, c.name, c.keywords, c.default_color, c.is_default,
    c.technique, c.primary_placement, c.providers,
    1 - (c.embedding <=> query_embedding) as similarity
  from catalog_products c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
