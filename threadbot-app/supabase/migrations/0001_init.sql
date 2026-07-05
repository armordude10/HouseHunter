-- threadbot-rebuild initial schema: design specs + pgvector catalog retrieval.

create extension if not exists vector;

-- Locked DesignSpecs (the exact-match contract). Full spec kept as jsonb; order_hash
-- duplicated out for cheap lookups/audits.
create table if not exists design_specs (
  id uuid primary key,
  order_hash text not null,
  spec jsonb not null,
  created_at timestamptz not null default now()
);

-- Neutral catalog cache with embeddings for semantic product selection.
create table if not exists catalog_products (
  id text primary key,
  name text not null,
  keywords text[] not null default '{}',
  default_color text not null,
  is_default boolean not null default false,
  technique text not null,
  primary_placement text not null,
  providers jsonb not null default '{}'::jsonb,
  search_text text not null,
  embedding vector(1536),
  updated_at timestamptz not null default now()
);

create index if not exists catalog_products_embedding_idx
  on catalog_products using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Top-K semantic match used by SupabaseVectorRetriever.
create or replace function match_catalog_products(
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
