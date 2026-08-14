-- Semrush Domain Intelligence: daily metric snapshots that power the trend
-- charts in the Semrush Intelligence panel (organic traffic / keywords /
-- authority / backlinks over time) WITHOUT paying for Semrush historical-data
-- API units (50 u/line). The server upserts at most one row per domain per
-- day whenever the domain bundle is loaded; charts build up automatically.
-- Run this in your Supabase SQL editor once (safe to re-run).

create table if not exists public.semrush_domain_snapshots (
  id bigserial primary key,
  domain text not null,
  captured_on date not null default current_date,
  authority_score integer,
  semrush_rank bigint,
  organic_traffic bigint,
  organic_keywords bigint,
  organic_cost numeric,
  paid_keywords bigint,
  paid_traffic bigint,
  backlinks_total bigint,
  ref_domains bigint,
  created_at timestamptz not null default now(),
  unique (domain, captured_on)
);

create index if not exists semrush_domain_snapshots_domain_idx
  on public.semrush_domain_snapshots (domain, captured_on desc);

-- Server-only table: RLS on, no public policies (service role bypasses RLS).
alter table public.semrush_domain_snapshots enable row level security;
