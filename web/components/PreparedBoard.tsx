'use client';

// components/PreparedBoard.tsx
// "Prepared videos" — every video that has drafts, one line each, and a way
// to approve several at once.
//
// THE PROBLEM. A video becomes up to three Metricool posts, and the dashboard
// approved them one POST at a time, each with its own dialog; the Prepare
// panel above shows one result at a time. Somebody who prepared ten videos and
// got the go-ahead had thirty clicks in front of them and no single view of
// what they had clicked.
//
// This reads the publishing list, groups it by video (lib/video-board.ts),
// shows each video with its row, its copy and its drafts, ticks the ones that
// can be approved, and sends the whole selection through the SAME approve
// route as the per-post button — one call per post, every gate in place, one
// confirmation for the lot. Nothing new can publish; the route that could
// always publish is simply pressed several times on the person's behalf.
import { useCallback, useEffect, useRef, useState } from 'react';
import { friendlyError, friendlyErrorFromResponse } from '@/lib/friendly-error';
import { mapLimit } from '@/lib/map-limit';
import { isAwaitingApproval, postStatusMeta, APPROVED_STATUS } from '@/lib/post-mode';
import { sheetRowLabel, sheetRowTitle, sheetRowUrl } from '@/lib/sheet-link';
import { approvableGroups, approvalSummary, groupPostsByVideo, postsToApprove, type BoardPost, type VideoGroup } from '@/lib/video-board';
import { fmtScheduleDateTime } from '@/lib/schedule-clock';

type Post = BoardPost & { id: string; status?: string | null; providers?: string[] | null; publication_date?: string | null; text?: string | null };

const btn: React.CSSProperties = { background: '#0071e3', color: '#fff', border: 'none', borderRadius: 999, padding: '7px 13px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const ghost: React.CSSProperties = { ...btn, background: 'transparent', color: '#0071e3', border: '1px solid rgba(0,113,227,0.35)' };
const CONCURRENCY = 4;

const isApproved = (status: unknown) => String(status || '').toLowerCase() === APPROVED_STATUS;

export default function PreparedBoard({ videoLinks, recentKeys }: {
  /** `tab:row` → the row's video link, so each line can open the video itself. */
  videoLinks: Record<string, string>;
  /** `tab:row` keys of the rows worked on in this visit — shown first. */
  recentKeys: readonly string[];
}) {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'publish' | 'attach' | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const started = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/posts');
      if (!r.ok) { setError(await friendlyErrorFromResponse(r, 'We could not load the publishing queue.')); return; }
      const j = await r.json().catch(() => ({}));
      setPosts(Array.isArray(j?.posts) ? (j.posts as Post[]) : []);
      setError(null);
    } catch (e) {
      setError(friendlyError(e, 'We could not reach the server to load the publishing queue.'));
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  const groups = groupPostsByVideo(posts || [], isAwaitingApproval, isApproved);
  const recent = new Set(recentKeys);
  const rowKeyOf = (g: VideoGroup<Post>) => (g.source ? g.source.tab + ':' + g.source.row : '');
  // This visit's rows first, then everything else still waiting, then the rest.
  const ordered = [...groups].sort((a, b) => {
    const ra = recent.has(rowKeyOf(a)) ? 0 : a.awaiting.length ? 1 : 2;
    const rb = recent.has(rowKeyOf(b)) ? 0 : b.awaiting.length ? 1 : 2;
    return ra - rb || a.firstAt - b.firstAt;
  });
  const approvable = approvableGroups(ordered);
  // Everything approvable is ticked until the person changes the selection.
  const effective = touched ? selected : new Set(approvable.map((g) => g.key));
  const chosen = postsToApprove(ordered, effective);
  const chosenVideos = approvable.filter((g) => effective.has(g.key)).length;
  const shown = open ? ordered : ordered.slice(0, 8);

  if (posts === null && !error) return null;
  if (!ordered.length && !error) return null;

  async function act(now: boolean) {
    if (busy || !chosen.length) return;
    if (typeof window !== 'undefined' && !window.confirm(approvalSummary(chosenVideos, chosen.length, now))) return;
    setBusy(now ? 'publish' : 'approve');
    setSummary(null);
    const failures: string[] = [];
    let ok = 0;
    await mapLimit(chosen, CONCURRENCY, async (p) => {
      try {
        const r = await fetch('/api/posts', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: p.id, action: now ? 'publish_now' : 'approve' }),
        });
        if (r.ok) { ok++; return; }
        failures.push((p.providers || []).join('/') + ': ' + await friendlyErrorFromResponse(r, 'could not be approved'));
      } catch (e) {
        failures.push((p.providers || []).join('/') + ': ' + friendlyError(e, 'could not be approved'));
      }
    });
    setSummary((now ? 'Published now: ' : 'Approved: ') + ok + ' of ' + chosen.length + ' post' + (chosen.length === 1 ? '' : 's') + (failures.length ? ' · not done: ' + failures.join('; ') : '') + '.');
    setBusy(null);
    setTouched(false);
    await load();
  }

  async function attach(g: VideoGroup<Post>) {
    if (busy) return;
    setBusy('attach');
    const pending = g.posts.filter((p) => p.videoPending === true);
    let ok = 0;
    let last = '';
    for (const p of pending) {
      try {
        const r = await fetch('/api/posts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: p.id, action: 'attach_video' }) });
        if (r.ok) ok++; else last = await friendlyErrorFromResponse(r, 'We could not attach the video.');
      } catch (e) { last = friendlyError(e, 'We could not attach the video.'); }
    }
    setNote((n) => ({ ...n, [g.key]: ok === pending.length ? 'Video attached to ' + ok + ' draft' + (ok === 1 ? '' : 's') + '.' : 'Attached to ' + ok + ' of ' + pending.length + ' — ' + last }));
    setBusy(null);
    await load();
  }

  return (
    <section aria-label="Prepared videos" style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Prepared videos {ordered.length ? '(' + ordered.length + ')' : ''}</h2>
          <div style={{ fontSize: 12, opacity: .6, marginTop: 2 }}>Every video with drafts in the queue, this visit’s rows first. Tick the ones to release; each post still passes the same checks as a single Approve. Nothing goes out otherwise.</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={{ ...btn, opacity: chosen.length && !busy ? 1 : .5 }} disabled={!chosen.length || Boolean(busy)} onClick={() => void act(false)}>
            {busy === 'approve' ? 'Approving…' : 'Approve ' + chosenVideos + ' video' + (chosenVideos === 1 ? '' : 's')}
          </button>
          <button type="button" style={{ ...ghost, opacity: chosen.length && !busy ? 1 : .5 }} disabled={!chosen.length || Boolean(busy)} onClick={() => void act(true)}>
            {busy === 'publish' ? 'Publishing…' : 'Publish ' + chosenVideos + ' now'}
          </button>
          <button type="button" style={ghost} disabled={Boolean(busy)} onClick={() => void load()}>Refresh</button>
        </div>
      </div>

      {error && <p style={{ fontSize: 12, color: '#a1252b', marginTop: 8 }}>{error}</p>}
      {summary && <p style={{ fontSize: 12, fontWeight: 600, marginTop: 8 }}>{summary}</p>}

      <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 8 }}>
        {shown.map((g) => {
          const canPick = g.awaiting.length > 0 && !g.pendingVideo;
          const picked = canPick && effective.has(g.key);
          const rowUrl = sheetRowUrl(g.source);
          const link = g.source ? videoLinks[rowKeyOf(g)] || '' : '';
          return (
            <li key={g.key} style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid rgba(0,0,0,0.08)', background: recent.has(rowKeyOf(g)) ? '#f4f8ff' : '#fafafa' }}>
              <input
                type="checkbox"
                aria-label={'Select ' + g.title}
                checked={picked}
                disabled={!canPick || Boolean(busy)}
                onChange={(e) => {
                  setTouched(true);
                  setSelected(() => {
                    const next = new Set(effective);
                    if (e.target.checked) next.add(g.key); else next.delete(g.key);
                    return next;
                  });
                }}
                style={{ marginTop: 3 }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 12 }}>
                  {rowUrl && (
                    <a href={rowUrl} target="_blank" rel="noopener noreferrer" title={sheetRowTitle(g.source)} style={{ padding: '0 6px', borderRadius: 999, fontSize: 11, fontWeight: 600, border: '1px solid rgba(0,0,0,0.1)', color: '#0071e3', textDecoration: 'none', whiteSpace: 'nowrap' }}>
                      {'\u{1F4C4}'} {sheetRowLabel(g.source)} {'↗'}
                    </a>
                  )}
                  <strong style={{ fontSize: 13 }}>{g.title}</strong>
                  {link && <a href={link} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#0071e3' }}>Open video ↗</a>}
                  {g.pendingVideo && (
                    <button type="button" style={{ ...ghost, padding: '2px 9px', fontSize: 11, borderColor: 'rgba(215,0,21,0.35)', color: '#d70015' }} disabled={Boolean(busy)} onClick={() => void attach(g)}>
                      {busy === 'attach' ? 'Attaching…' : 'Pending video — attach'}
                    </button>
                  )}
                </div>
                <p style={{ margin: '4px 0 6px', fontSize: 12, color: '#3a3a3c', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{g.text || 'Scheduled post'}</p>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
                  {g.posts.map((p) => {
                    const meta = postStatusMeta(p.status);
                    const color = p.videoPending ? '#d70015' : meta.tone === 'green' ? '#1f6b3a' : meta.tone === 'amber' ? '#8a5a00' : '#1d4ed8';
                    return (
                      <span key={p.id} style={{ border: '1px solid rgba(0,0,0,0.08)', borderRadius: 999, padding: '2px 8px', color }}>
                        {(p.providers || []).join(', ') || 'post'} · {p.videoPending ? 'pending video' : meta.label.toLowerCase()} · {fmtScheduleDateTime(p.publication_date || '')}
                      </span>
                    );
                  })}
                </div>
                {note[g.key] && <div style={{ fontSize: 11, marginTop: 4, color: '#1f6b3a' }}>{note[g.key]}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {ordered.length > 8 && (
        <button type="button" style={{ ...ghost, marginTop: 8 }} onClick={() => setOpen((v) => !v)}>
          {open ? 'Show fewer' : 'Show all ' + ordered.length}
        </button>
      )}
    </section>
  );
}
