-- Autopilot Content Engine: dynamic templates that research, decide, draft,
-- score and stage a FRESH post for every scheduled occurrence — everything
-- but publish (a human always approves).
-- Run this in your Supabase SQL editor once (safe to re-run).

-- 0) Prerequisites from schema.sql that older databases may predate
--    (idempotent). The engine reads post_metrics for performance hints and
--    the rate limiter uses usage_events.
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  created_at timestamptz default now()
);
create index if not exists usage_events_user_action_time_idx
  on public.usage_events (user_id, action, created_at desc);
alter table public.usage_events enable row level security;

create table if not exists public.post_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  network text not null,
  external_id text,
  text text,
  published_at timestamptz,
  impressions integer not null default 0,
  engagement integer not null default 0,
  fetched_at timestamptz default now(),
  unique (user_id, network, external_id)
);
create index if not exists post_metrics_user_engagement_idx
  on public.post_metrics (user_id, engagement desc);
alter table public.post_metrics enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='usage_events' and policyname='usage_events: owner read') then
    create policy "usage_events: owner read" on public.usage_events for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='post_metrics' and policyname='post_metrics: owner read') then
    create policy "post_metrics: owner read" on public.post_metrics for select using (auth.uid() = user_id);
  end if;
end $$;

-- 1) Templates gain a strategy: what the engine should do each occurrence,
--    instead of copying the same static text into every slot.
--    { mode: 'off'|'fixed_topic'|'pillars'|'auto',
--      topic?, pillars?: string[], goal?, format?, lead_hours?, max_regens? }
alter table public.schedule_templates
  add column if not exists strategy jsonb not null default '{"mode":"off"}'::jsonb;

-- 2) One row per template occurrence: the state machine the daily tick
--    advances. planned → researched → drafted → ready_for_review →
--    approved | skipped (failed after repeated errors).
create table if not exists public.template_runs (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.schedule_templates(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  scheduled_for timestamptz not null,
  state text not null default 'planned',
  attempts integer not null default 0,
  regens integer not null default 0,
  brief jsonb,        -- KeywordBrief snapshot for the chosen angle
  angle jsonb,        -- { type, query, seedTopic, rationale, volume, difficulty, intent }
  score jsonb,        -- { total, breakdown: {...}, safetyFlags: [...] }
  draft_id uuid references public.drafts(id) on delete set null,
  log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id, scheduled_for)
);

create index if not exists template_runs_due_idx
  on public.template_runs (state, scheduled_for);
create index if not exists template_runs_user_idx
  on public.template_runs (user_id, scheduled_for desc);

drop trigger if exists trg_template_runs_updated on public.template_runs;
create trigger trg_template_runs_updated before update on public.template_runs
for each row execute function public.touch_updated_at();

alter table public.template_runs enable row level security;

-- Users may read + act on their own runs; the engine writes via the
-- service-role client (bypasses RLS), so no insert policy is required.
-- (Guarded DO blocks: CREATE POLICY has no IF NOT EXISTS in Postgres.)
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'template_runs'
      and policyname = 'template_runs: owner read'
  ) then
    create policy "template_runs: owner read" on public.template_runs
      for select using (auth.uid() = user_id);
  end if;
  -- NO owner-update policy. RLS cannot say "you may edit these columns but not
  -- those", and `draft_id` / `template_id` are ordinary columns here: a policy
  -- of `using (auth.uid() = user_id)` let a signed-in user PATCH their OWN run
  -- straight against PostgREST and repoint draft_id at another tenant's draft,
  -- which service-role reads downstream then followed - and wrote to.
  -- Every mutation goes through /api/autopilot/runs on the service-role client,
  -- which bypasses RLS, so no client needs this privilege. See the REVOKE at the
  -- foot of this file, which also cleans up deployments that ran the old version.
end $$;

-- 3) Learning loop: which primary keywords actually earned engagement.
--    Joins the keywords each draft applied (draft_keywords) with measured
--    post performance (post_metrics) by fuzzy text containment. Used to bias
--    future angle choices toward what works for THIS audience.
-- security_invoker = on makes the view run with the QUERYING user's privileges,
-- so the owner-scoped RLS on draft_keywords / post_metrics still applies. Without
-- it the view runs as its definer and returns EVERY tenant's rows to any caller
-- (Supabase's default grants make public-schema views selectable by anon too).
create or replace view public.keyword_performance
  with (security_invoker = on)
as
select
  dk.user_id,
  dk.keyword,
  count(distinct pm.id)               as measured_posts,
  coalesce(sum(pm.engagement), 0)     as total_engagement,
  coalesce(sum(pm.impressions), 0)    as total_impressions,
  max(pm.published_at)                as last_published_at
from public.draft_keywords dk
join public.post_metrics pm
  on pm.user_id = dk.user_id
 and pm.text is not null
 -- The keyword is DATA, not a pattern. It comes from Semrush rows and, on the
 -- cache-only path, straight from angle.query - so a keyword containing % or _
 -- silently matched far more posts than it should, inflating total_engagement
 -- and therefore the learn-boost that biases every future angle choice.
 -- position() does a plain substring search with no pattern semantics at all.
 and position(lower(dk.keyword) in lower(pm.text)) > 0
where dk.role = 'primary'
group by dk.user_id, dk.keyword;

-- Belt and suspenders: never expose the analytics view to the anonymous role,
-- and let only authenticated sessions read it (still RLS-filtered per the above).
revoke all on public.keyword_performance from anon;
grant select on public.keyword_performance to authenticated;

-- ---------------------------------------------------------------------------
-- Hardening: template_runs must not be writable by a browser session.
--
-- The "owner update" policy above is `using (auth.uid() = user_id)` with no
-- column restriction, and RLS cannot express "you may edit these columns but
-- not those". `draft_id` and `template_id` are ordinary columns on that row,
-- and the anon key ships in the client bundle - so a signed-in user could PATCH
-- their OWN run straight against PostgREST and repoint `draft_id` at another
-- tenant's draft. Three service-role reads follow that column (the runs API,
-- approveRun, ensureDraftImage), and the last of them WRITES the draft it
-- finds. Every route looked correctly scoped; the writable foreign key was the
-- gap.
--
-- Nothing in the app updates this table from the browser: every mutation goes
-- through /api/autopilot/runs on the service-role client, which bypasses RLS.
-- So the privilege is simply removed. The SELECT policy stays: it costs nothing
-- and keeps direct reads owner-scoped if anything ever needs them. (Nothing
-- client-side reads template_runs today - the realtime subscription in
-- LiveContentProvider is on drafts and posts only.)
--
-- Safe to re-run.
revoke update on public.template_runs from authenticated;
revoke insert, delete on public.template_runs from authenticated;

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'template_runs'
      and policyname = 'template_runs: owner update'
  ) then
    drop policy "template_runs: owner update" on public.template_runs;
  end if;
end $$;
