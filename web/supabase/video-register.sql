-- web/supabase/video-register.sql
-- The video register: one row per thing that happened to a video, ever.
--
-- Paste this into the Supabase SQL editor. It is safe to re-run.
--
-- WHY THIS EXISTS
--
-- Nothing in this app has ever recorded a video ARRIVING. The Video Library is
-- a live window onto the Google Sheet — it reads /api/sources, not the database
-- — so a row appearing there is not an event anything witnesses. And
-- `video_runs`, the only database record of the pipeline, is
-- `unique (spreadsheet_id, tab, row_key)` and upserted IN PLACE by five
-- different callers, so a row that went discovered → preparing → failed →
-- discovered → prepared reads afterwards as simply "prepared". Prior errors are
-- deliberately nulled on retry; prior keywords, refs and drafts are overwritten.
--
-- This table is the opposite: append-only, never updated, never deleted. It
-- follows `usage_events` in schema.sql, which is the cleanest in-repo precedent
-- for an append-only log.
--
-- NOTHING BREAKS IF YOU HAVE NOT RUN THIS YET. lib/video-register.ts notices a
-- missing table once, remembers, and turns every write into a no-op. The app
-- behaves exactly as it did before; the register is simply empty until this is
-- pasted in.

create table if not exists public.video_register (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Stable identity across everything that can happen to one video:
  -- "<spreadsheet_id>|<tab>|<row_key>", or "drive|<file id>" for a video that
  -- never came from a sheet row. row_key is content-derived, so inserting a row
  -- above this one does not change its key — the same property video_runs
  -- depends on.
  video_key text not null,
  title text,
  link text,

  -- first_seen | prepared | failed | copy_made | copy_failed | queued | retried | skipped
  event text not null,
  -- WHICH MECHANISM: sweep | button | batch | assistant | revive | picker | unknown.
  -- user_id is the tenant, not the actor — on a single-clinic deployment every
  -- path writes the same id, so without this column the nightly pass, the
  -- Prepare button and the assistant's retry are indistinguishable afterwards.
  actor text not null default 'unknown',

  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- "What arrived recently" — the panel at the top of the Video Library.
create index if not exists video_register_time_idx
  on public.video_register (created_at desc);

-- "Everything that ever happened to THIS video" — the per-row history.
create index if not exists video_register_video_idx
  on public.video_register (video_key, created_at desc);

-- A video is seen for the first time exactly once, however many times the sweep
-- runs. The insert uses ON CONFLICT DO NOTHING against this, so re-running the
-- sweep is free rather than duplicating every row every night.
create unique index if not exists video_register_first_seen_idx
  on public.video_register (video_key)
  where event = 'first_seen';

alter table public.video_register enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where policyname = 'video_register: owner read') then
    create policy "video_register: owner read" on public.video_register
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- No insert/update/delete policies, deliberately. Writes happen through the
-- service-role client, which bypasses RLS — the same arrangement usage_events
-- uses. And a register that the browser can edit is not a register: revoking
-- these makes "append-only" a property of the database rather than a promise
-- made by the application code.
revoke insert, update, delete on public.video_register from authenticated;
