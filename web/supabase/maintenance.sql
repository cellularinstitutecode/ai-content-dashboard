-- web/supabase/maintenance.sql
-- Reclaiming space, and keeping it reclaimed.
--
-- Paste into the Supabase SQL editor and run section by section, in order.
-- Every destructive statement has a read-only "how much" query directly above
-- it: run the count first, read the number, then run the delete. Nothing here
-- touches drafts, posts, runs, transcripts, the register, the Semrush cache or
-- any image a draft still points at. See the plan this came from for why each
-- table is safe: usage_events is read for one hour, semrush_usage for one
-- calendar month, and nothing reads either any further back.
--
-- The image bucket is NOT pruned from here. That is /api/maintenance/prune,
-- which knows which objects the drafts reference; SQL does not.

-- ===========================================================================
-- 0. Where the space is. Read-only. Run this first, and again at the end.
-- ===========================================================================

select pg_size_pretty(pg_database_size(current_database())) as database_total;

select c.relname as table,
       pg_size_pretty(pg_total_relation_size(c.oid))                       as total,
       pg_size_pretty(pg_relation_size(c.oid))                             as rows_only,
       pg_size_pretty(pg_indexes_size(c.oid))                              as indexes,
       pg_size_pretty(coalesce(pg_total_relation_size(c.reltoastrelid), 0)) as big_columns,
       s.n_live_tup                                                        as live_rows,
       s.n_dead_tup                                                        as dead_rows,
       s.last_autovacuum
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s on s.relid = c.oid
where n.nspname = 'public' and c.relkind = 'r'
order by pg_total_relation_size(c.oid) desc
limit 20;

select bucket_id,
       count(*)                                         as objects,
       pg_size_pretty(sum((metadata->>'size')::bigint)) as total
from storage.objects
group by bucket_id
order by sum((metadata->>'size')::bigint) desc;

-- ===========================================================================
-- A1. usage_events older than a day.
--     Every rate-limit window is one hour (lib/rate-limit.ts); a day is 24×
--     the longest anything reads. No post, draft or run references this table.
-- ===========================================================================

-- Dry run: how many rows would go.
select count(*) as stale_usage_events
from public.usage_events
where created_at < now() - interval '1 day';

-- The delete.
delete from public.usage_events
where created_at < now() - interval '1 day';

-- ===========================================================================
-- A3. semrush_usage older than last month.
--     lib/semrush.ts sums only the current calendar month's live spend to work
--     out the units left. Keeping last month too is twice what it can ask for.
--     (This also keeps the month's live rows under PostgREST's 1,000-row cap,
--     past which that read fails closed and the budget check stops answering.)
-- ===========================================================================

-- Dry run.
select count(*) as stale_semrush_usage
from public.semrush_usage
where created_at < date_trunc('month', now() at time zone 'utc') - interval '1 month';

-- The delete.
delete from public.semrush_usage
where created_at < date_trunc('month', now() at time zone 'utc') - interval '1 month';

-- ===========================================================================
-- A4. Give the dead rows back.
--     Postgres does not overwrite a row on UPDATE; it writes a new version and
--     leaves the old one until vacuum reclaims it. drafts.pack and
--     template_runs are rewritten many times per row, and nothing here ever
--     tuned autovacuum, so the "dead_rows" column in section 0 may be large.
--
--     Plain VACUUM is online and safe: readers and writers carry on. Run it
--     AFTER A1 and A3, so the rows they deleted are reclaimed in the same pass.
--     Run each VACUUM line on its own — it cannot run inside a transaction.
-- ===========================================================================

vacuum (analyze) public.usage_events;
vacuum (analyze) public.semrush_usage;
vacuum (analyze) public.drafts;
vacuum (analyze) public.template_runs;
vacuum (analyze) public.video_runs;

-- ⚠️  VACUUM FULL — read before running.
--
-- Plain VACUUM marks dead space reusable but does not shrink the file. If
-- section 0 shows a table where dead_rows rivals live_rows, VACUUM FULL will
-- actually return that space to the disk — at a price: it takes an EXCLUSIVE
-- lock (the table is unreadable and unwritable until it finishes) and it needs
-- free disk equal to the size of the table it is rewriting, because it writes
-- a fresh copy before dropping the old one. On a database at its limit that
-- can fail partway. So: only ONE named table at a time, only after A1–A3 and
-- the image sweep have freed headroom, only when nobody is using the app.
-- Uncomment the line you mean.
--
-- vacuum full public.template_runs;
-- vacuum full public.drafts;

-- ===========================================================================
-- B6. Keep it from building back up.
--     Default autovacuum waits until 20% of a table is dead. On a JSON column
--     rewritten eighteen times per run that is a standing 20% overhead. 5% on
--     the tables that churn; a setting, not a data change.
-- ===========================================================================

alter table public.drafts        set (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
alter table public.template_runs set (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
alter table public.video_runs    set (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);
alter table public.usage_events  set (autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.05);

-- ===========================================================================
-- C1. Put back transcripts that the public-copy bookkeeping erased.
--     Until the fix in lib/transcript-cache.ts, recording a video's
--     world-readable copy replaced its banked transcript with ''. The app now
--     recovers such a transcript from the video's draft on the next Prepare,
--     one video at a time. This does the same for every affected row at once.
--     Read-only check first; the update is commented out.
-- ===========================================================================

select vt.video_id, vt.chars, length(vt.text) as text_now, vt.public_copy_id
from public.video_transcripts vt
where vt.text = '';

-- update public.video_transcripts vt
-- set text = d.transcript, chars = length(d.transcript), updated_at = now()
-- from (
--   select distinct on (pack->>'videoId') pack->>'videoId' as video_id, pack->>'transcript' as transcript
--   from public.drafts
--   where pack->>'kind' = 'video' and length(coalesce(pack->>'transcript', '')) >= 40
--   order by pack->>'videoId', updated_at desc
-- ) d
-- where d.video_id = vt.video_id and vt.text = '';

-- ===========================================================================
-- Done. Re-run section 0 and compare.
-- ===========================================================================
