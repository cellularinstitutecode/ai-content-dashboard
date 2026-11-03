'use client';
// "Redo old covers": every titled cover made before the cover rule of
// 3 November 2026, re-rendered under it in one press.
//
// GET /api/drafts/covers says how many there are. The button calls POST
// /api/drafts/covers until none remain (a dozen a call, each re-rendered on
// its clean photograph — no image model, no credits), then sends every post
// in Metricool that still carries an old picture through the posts route's
// sync_media, the same action the calendar's "Sync picture" uses, so the
// scheduled post shows the new cover too. A draft with a published post is
// not in the count at all: what has gone out is history. Shown only while
// there is something to redo.
import { useEffect, useState } from 'react';
import { announce } from '@/components/refreshBus';

type Listing = { count: number; covers: { id: string; title: string }[] };
type Done = { id: string; title: string; url: string; postIds: string[] };
type Failed = { id: string; title: string; message: string };

export default function RedoCovers({ onDone, fetchErr }: { onDone?: () => void; fetchErr: (r: Response, fallback?: string) => Promise<string> }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<Done[]>([]);
  const [failed, setFailed] = useState<Failed[]>([]);
  const [synced, setSynced] = useState<{ ok: number; failed: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function count() {
    try {
      const r = await fetch('/api/drafts/covers');
      if (r.ok) setListing((await r.json()) as Listing);
    } catch { /* the card simply stays hidden */ }
  }
  useEffect(() => { void count(); }, []);

  async function redo() {
    setBusy(true); setErr(null); setDone([]); setFailed([]); setSynced(null);
    const allDone: Done[] = [];
    const allFailed: Failed[] = [];
    try {
      // Covers, a dozen a call, until none remain.
      for (let round = 0; round < 40; round++) {
        setProgress('Redoing covers… ' + allDone.length + ' done' + (allFailed.length ? ', ' + allFailed.length + ' could not be' : ''));
        const r = await fetch('/api/drafts/covers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
        if (!r.ok) throw new Error(await fetchErr(r));
        const j = (await r.json()) as { done: Done[]; failed: Failed[]; remaining: number };
        allDone.push(...j.done); allFailed.push(...j.failed);
        setDone([...allDone]); setFailed([...allFailed]);
        if (!j.remaining || (!j.done.length && !j.failed.length)) break;
      }
      // The posts in Metricool that still carry an old picture.
      const postIds = allDone.flatMap((d) => d.postIds);
      let ok = 0; const bad: string[] = [];
      for (let i = 0; i < postIds.length; i++) {
        setProgress('Updating the posts in Metricool… ' + (i + 1) + ' of ' + postIds.length);
        try {
          const r = await fetch('/api/posts', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: postIds[i], action: 'sync_media' }) });
          if (r.ok) ok++; else bad.push(await fetchErr(r, 'Metricool did not take the new picture.'));
        } catch (e) { bad.push(e instanceof Error ? e.message : 'no answer'); }
      }
      setSynced({ ok, failed: bad });
      setProgress(null);
      announce('drafts', 'images', 'posts');
      onDone?.();
      await count();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The covers could not be redone.');
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  const n = listing?.count ?? 0;
  if (!listing || (!n && !done.length && !failed.length)) return null;
  return (
    <div className="mb-4 rounded-2xl bg-accent/5 px-4 py-3 ring-1 ring-accent/20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-[13px] text-ink">
          <strong>{n ? n + (n === 1 ? ' cover not yet posted was' : ' covers not yet posted were') + ' made before the new cover rule.' : 'Every cover still to go out is on the new rule.'}</strong>
          {n > 0 && <span className="text-ink-muted"> Redo them now: no wash, the title above the people or at the bottom, never on a face. No credits are spent, the scheduled posts in Metricool get the new picture, and anything already posted is left as it is.</span>}
        </div>
        {n > 0 && (
          <button type="button" disabled={busy} onClick={() => void redo()} className="shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-white shadow-soft transition hover:opacity-90 disabled:opacity-50">
            {busy ? 'Redoing…' : 'Redo ' + n + (n === 1 ? ' cover' : ' covers')}
          </button>
        )}
      </div>
      {progress && <div className="mt-2 text-[12px] text-ink-muted">{progress}</div>}
      {err && <div role="alert" className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-[12px] text-red-700 ring-1 ring-red-100">{err}</div>}
      {(done.length > 0 || failed.length > 0) && !busy && (
        <div role="status" className={'mt-2 rounded-xl px-3 py-2 text-[12px] ' + (failed.length ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-100' : 'bg-green-50 text-green-900 ring-1 ring-green-100')}>
          <strong>{failed.length ? 'Partly done.' : '✓ Done.'}</strong>{' '}
          {done.length} {done.length === 1 ? 'cover' : 'covers'} redone
          {synced ? ', ' + synced.ok + (synced.ok === 1 ? ' post' : ' posts') + ' updated in Metricool' + (synced.failed.length ? ' (' + synced.failed.length + ' not: ' + synced.failed[0] + ')' : '') : ''}
          {failed.length ? '. Not redone: ' + failed.map((f) => (f.title || f.id) + ' (' + f.message + ')').join('; ') : '.'}
        </div>
      )}
    </div>
  );
}
