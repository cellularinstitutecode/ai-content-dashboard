-- Video Autopilot: a new link in Rodrigo's "Distribución RRSS CHI" sheet
-- becomes a transcript, a keyword brief, a REF citation and publish-ready copy
-- without anyone pressing anything.
--
-- Run this in your Supabase SQL editor once (safe to re-run).
--
-- One row here per row of the sheet. It is what makes the sweep idempotent:
-- without it, every tick would re-transcribe every video in the sheet, spend
-- the money again, and write over copy a person had since corrected by hand.

create table if not exists public.video_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- Which row of which document. row_key is derived from the row's CONTENT
  -- (file name + link), never its row NUMBER: somebody inserting a row at the
  -- top of a tab shifts every number below it, and keying on the number would
  -- re-process the entire sheet the next morning.
  spreadsheet_id text not null,
  tab text not null,
  row_key text not null,
  -- The row number as last seen, for writing back. Refreshed every sweep.
  row_number integer,

  video_title text,
  video_link text,

  -- discovered → preparing → prepared | needs_transcript | failed | skipped
  state text not null default 'discovered',
  attempts integer not null default 0,

  transcript_source text,     -- 'youtube' | 'drive' | 'pasted'
  transcript_chars integer,
  keywords text,              -- the flattened brief, as written to the sheet
  ref text,                   -- the citation, as written to the sheet
  draft_id uuid references public.drafts(id) on delete set null,
  -- What the sweep wrote back, and what it deliberately did not (because a
  -- person had already written something there).
  wrote jsonb not null default '{}'::jsonb,
  -- One entry per network handed to Metricool: whether a draft was created,
  -- its Metricool post id, or why it was not sent (a compliance refusal reads
  -- very differently from an outage, and both need to be visible afterwards).
  metricool jsonb not null default '[]'::jsonb,
  last_error text,
  log jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (spreadsheet_id, tab, row_key)
);

create index if not exists video_runs_state_idx on public.video_runs (state, updated_at desc);
create index if not exists video_runs_user_idx on public.video_runs (user_id, created_at desc);

drop trigger if exists trg_video_runs_updated on public.video_runs;
create trigger trg_video_runs_updated before update on public.video_runs
for each row execute function public.touch_updated_at();

alter table public.video_runs enable row level security;

-- Read-only for the owner; every write goes through the service-role client in
-- /api/videos/watch, which bypasses RLS. This is the same shape template_runs
-- settled on, and for the same reason: `draft_id` is an ordinary column, so an
-- owner-update policy would let a signed-in user repoint it at another
-- tenant's draft — a row that service-role code downstream then follows.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'video_runs'
      and policyname = 'video_runs: owner read'
  ) then
    create policy "video_runs: owner read" on public.video_runs
      for select using (auth.uid() = user_id);
  end if;
end $$;

revoke insert, update, delete on public.video_runs from authenticated;

-- Added after the first version of this file: the Metricool hand-off record.
alter table public.video_runs
  add column if not exists metricool jsonb not null default '[]'::jsonb;

-- ---------------------------------------------------------------------------
-- Transcripts, cached by VIDEO rather than by sheet row.
--
-- A 149 MB reel takes most of a 60-second function just to come down from
-- Drive, before ffmpeg or the transcriber have done anything — so the whole
-- chain (download → extract → transcribe → keyword brief → write the copy)
-- does not reliably fit inside one invocation on this plan, and a run that
-- overran threw away the download AND the transcription spend, leaving the
-- next attempt to start from nothing. Pressing Prepare again just bought the
-- same timeout a second time.
--
-- Keeping the transcript makes the work RESUMABLE: the expensive half happens
-- once, and every later attempt on that video skips straight past it and
-- finishes in seconds. Keyed on the video's own id, not the row, so the
-- Prepare button and the automatic sweep share one copy.
--
-- No RLS policies on purpose: nothing but the service role should read this,
-- and enabling RLS with no policy is how that is said in Postgres.
create table if not exists public.video_transcripts (
  -- The Drive file id, or the YouTube video id.
  video_id text primary key,
  source text not null default 'drive',   -- 'drive' | 'youtube' | 'pasted'
  language text,
  title text,
  text text not null,
  chars integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.video_transcripts enable row level security;

-- ---------------------------------------------------------------------------
-- The public copy of a video, remembered so it is made once and can be removed.
--
-- Metricool cannot fetch an ordinary Drive link, so a video attached to a post is copied
-- into the app's own folder and that copy is opened to ANYONE WITH THE LINK. It was made
-- once per hand-off run — so re-preparing a row made another one — and nothing in the app
-- could delete any of them. A folder quietly filling with world-readable copies of a
-- clinic's footage, with no way to tell which row each came from.
--
-- Keyed on the SOURCE video, so a second run finds the copy the first one made.
alter table public.video_transcripts
  add column if not exists public_copy_id text;
alter table public.video_transcripts
  add column if not exists public_copy_url text;

-- ---------------------------------------------------------------------------
-- WHY a row stopped, in a form something other than a human can read.
--
-- `last_error` holds the failure's own sentence, written for whoever pressed
-- the button. Nothing could act on it, so the sweep answered "is this row
-- worth another go?" with one flat number for every kind of failure: three
-- attempts and the row was retired, permanently and silently, with no code
-- anywhere able to un-retire it.
--
-- That treated a row that merely ran out of time exactly like one whose copy
-- named a person who is not in the video. A retry fixes the first and cannot
-- fix the second, and it pays for a whole download and transcription to find
-- that out again. lib/failure-kind.ts makes the split; this column is what it
-- reads.
alter table public.video_runs
  add column if not exists last_error_code text;

-- How many times a retired row has been given another go.
--
-- The counterpart to last_error_code above: a failure that looked temporary is
-- brought back after a cooldown (lib/revive-decision.ts), and this is what
-- stops that cooldown becoming an unlimited retry. Each revival costs a whole
-- download and transcription, so the ceiling is the point.
alter table public.video_runs
  add column if not exists revivals integer not null default 0;
