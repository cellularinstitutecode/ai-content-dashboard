-- AI Content Dashboard schema
-- Run this in your Supabase SQL editor once after creating the project.

create extension if not exists pgcrypto;

-- Drafts: generated post packs awaiting scheduling.
create table if not exists public.drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  topic text not null,
  audience text,
  tone text,
  goal text,
  cta text,
  channels text[] default '{}',
  pack jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Posts: each row = one Metricool scheduled publication.
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  draft_id uuid references public.drafts(id) on delete set null,
  providers text[] not null,
  text text not null,
  publication_date timestamptz not null,
  metricool_post_id text,
  status text not null default 'scheduled',
  created_at timestamptz default now()
);

-- Clips: each row = one OpusClip project the user kicked off.
create table if not exists public.clips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  opus_project_id text,
  source_url text not null,
  status text not null default 'processing',
  result jsonb,
  created_at timestamptz default now()
);

-- Row-Level Security: each user only sees their own rows.
alter table public.drafts enable row level security;
alter table public.posts enable row level security;
alter table public.clips enable row level security;

create policy if not exists "drafts: owner read" on public.drafts for select using (auth.uid() = user_id);
create policy if not exists "drafts: owner write" on public.drafts for insert with check (auth.uid() = user_id);
create policy if not exists "drafts: owner update" on public.drafts for update using (auth.uid() = user_id);
create policy if not exists "drafts: owner delete" on public.drafts for delete using (auth.uid() = user_id);

create policy if not exists "posts: owner read" on public.posts for select using (auth.uid() = user_id);
create policy if not exists "posts: owner write" on public.posts for insert with check (auth.uid() = user_id);

create policy if not exists "clips: owner read" on public.clips for select using (auth.uid() = user_id);
create policy if not exists "clips: owner write" on public.clips for insert with check (auth.uid() = user_id);
create policy if not exists "clips: owner update" on public.clips for update using (auth.uid() = user_id);

-- Updated_at trigger for drafts
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end; $$ language plpgsql;

drop trigger if exists trg_drafts_updated on public.drafts;
create trigger trg_drafts_updated before update on public.drafts
for each row execute function public.touch_updated_at();
