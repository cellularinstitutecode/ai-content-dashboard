-- Run in the Supabase SQL editor once. Idempotent.
--
-- ---------------------------------------------------------------------------
-- A Metricool upload in progress, so it can continue on the next request.
--
-- Row 200 is a 2785 MB reel. The direct upload into Metricool
-- (lib/metricool-upload.ts) moves a file in 25 MB slices, and a file that
-- size does not fit inside one 300-second function: two passes over the
-- network — one to hash the slices, one to put them — is more than a single
-- request has, and the first version simply refused anything past 2 GB.
--
-- Metricool's transaction is a MULTIPART upload, and a multipart upload is
-- resumable by construction: every slice is its own PUT with its own ETag,
-- and the completion is just the list of ETags. So what a request could not
-- finish is written here — the declared slices with their hashes, the signed
-- addresses Metricool handed back, and every ETag so far — and the next pass
-- (the 15-minute video sweep, or a person pressing the button again) picks
-- up at the first slice without one. The hashes are the expensive part and
-- they never have to be recomputed, even when the signed addresses expire
-- and the transaction has to be reopened.
--
-- Keyed on the SOURCE video, like the copy cache. Read and written with the
-- service role only; nothing in the browser sees it.
create table if not exists public.metricool_uploads (
  video_id text primary key,
  blog_id text,
  size_bytes bigint not null,
  content_type text not null default 'video/mp4',
  -- The slices as declared to Metricool: [{size,startByte,endByte,hash}, …].
  declared jsonb not null,
  -- Metricool's reply to the open: upload type, key, upload id, signed parts.
  transaction jsonb not null,
  -- partNumber -> ETag, for every slice already in S3.
  etags jsonb not null default '{}'::jsonb,
  -- 'uploading' | 'done' | 'failed'
  status text not null default 'uploading',
  -- When the signed addresses stop working; after this the open is redone.
  expires_at timestamptz,
  file_url text,
  copy_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.metricool_uploads enable row level security;
