-- Library photos: what the team's Drive photo folder holds, read once.
--
-- The dashboard used to pay for an AI picture on every post while the clinic's
-- own photographs sat in Drive unread. lib/library-index.ts reads each
-- photograph once with the vision model (what it shows, what the cover rules
-- would refuse it for), measures its colour against the house palette, and
-- keeps the answer here so a post can be given a REAL photograph of the
-- clinic when one fits — and so the same photograph is not used on every post
-- (used_count / last_used_at).
--
-- Written and read by the service-role client only: RLS is on with no
-- policies. Every read is wrapped so an older database degrades to "no
-- library index", which reads as "generate as before".
create table if not exists public.library_photos (
  file_id text primary key,
  name text not null default '',
  caption text not null default '',
  subjects text[] not null default '{}',
  blockers text[] not null default '{}',
  -- lib/palette.ts PaletteStats, when the photo was measured.
  stats jsonb,
  -- The copy in the app's own public bucket, once imported (Metricool cannot
  -- fetch a Drive link). Null until a post first uses the photo.
  url text,
  consent_cleared boolean not null default false,
  used_count integer not null default 0,
  last_used_at timestamptz,
  captioned_at timestamptz not null default now()
);

create index if not exists library_photos_last_used_idx on public.library_photos (last_used_at);

alter table public.library_photos enable row level security;
