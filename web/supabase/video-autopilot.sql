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
