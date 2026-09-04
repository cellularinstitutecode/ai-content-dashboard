'use client';

import { useEffect, useMemo, useState } from 'react';
import PageNav from '@/components/PageNav';
import { localDateKey, tightestLimit, networkLabel } from '@/lib/composer';
import { announce, onRefresh } from '@/components/refreshBus';
import { useWorkspace } from '@/components/workspace';
import { PanelLoader } from '@/components/LoadingScreen';
import { friendlyError, friendlyErrorFromResponse } from '@/lib/friendly-error';
// The Approve button must agree with the API about what may go out.
import { isAwaitingApproval } from '@/lib/post-mode';
import { fmtScheduleTime, scheduleDateKey, scheduleWallClock, isoAtScheduleWallClock, scheduleTzLabel } from '@/lib/schedule-clock';

type Post = {
  id?: string;
  text?: string;
  providers?: string[];
  publication_date?: string;
  status?: string;
  metricool_post_id?: string | null;
};

function toArray(x: any): any[] {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.posts)) return x.posts;
  if (x && Array.isArray(x.data)) return x.data;
  return [];
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const NETWORKS: { id: string; label: string }[] = [
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'twitter', label: 'X / Twitter' },
];

// Shared with lib/composer so the rule has one home and one test.
const dateKey = localDateKey;

function statusWord(status?: string): string {
  const s = String(status || '').toLowerCase();
  if (s === 'published' || s === 'sent' || s === 'live') return 'Published';
  if (s === 'failed' || s === 'error' || s === 'rejected') return 'Needs attention';
  return 'Scheduled';
}

// Which calendar square a post belongs in, and the time printed on it — both
// on the SCHEDULE clock. Bucketing by the viewer's clock put a late-evening
// Cancun post on the following day for anyone east of it, and printed a time
// that disagreed with the composer that created it.
function postDayKey(iso?: string) {
  if (!iso) return '';
  return scheduleDateKey(iso);
}

function timeLabel(iso?: string) {
  if (!iso) return '';
  return fmtScheduleTime(iso);
}

// Build a 6-row x 7-col grid of Dates covering the visible month.
function buildGrid(year: number, month: number): Date[] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay()); // back up to Sunday
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}

export default function CalendarPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  // Click-a-day scheduling panel state
  const [scheduleDay, setScheduleDay] = useState<Date | null>(null);
  const [pNetworks, setPNetworks] = useState<string[]>(['facebook']);
  const [pTime, setPTime] = useState('09:00');
  const [pText, setPText] = useState('');
  const [pBusy, setPBusy] = useState(false);
  const [pStatus, setPStatus] = useState<string | null>(null);

  // The "today" marker has to be decided in the browser, never at prerender time.
  // This is a client component, but Next.js still renders its HTML on the server,
  // and React does not reconcile mismatched className attributes during
  // production hydration — so a date captured when the page was built stays
  // baked into the grid and highlights the wrong cell (it marked Aug 20 on
  // Aug 21). `mounted` guarantees one real post-hydration render, which is what
  // actually patches the DOM. Until then no cell claims to be today, which is
  // honest rather than wrong. The interval keeps a tab left open overnight right.
  const [mounted, setMounted] = useState(false);
  const [today, setToday] = useState(() => new Date());
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  useEffect(() => {
    setMounted(true);
    const now = new Date();
    setToday(now);
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
    const id = setInterval(() => {
      setToday((prev) => {
        const d = new Date();
        return dateKey(prev) === dateKey(d) ? prev : d;
      });
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  const [aiTopic, setAiTopic] = useState('');
  const [aiProvider, setAiProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [aiBusy, setAiBusy] = useState(false);
  const workspace = useWorkspace();

  async function draftWithAI() {
    if (!aiTopic.trim()) { setErr('Enter a topic for the AI to draft from.'); return; }
    setErr('');
    setAiBusy(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-chi-progress-scope': 'calendar' },
        body: JSON.stringify({ topic: aiTopic, provider: aiProvider, model: aiProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o', type: 'social' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to draft');
      const pack = data?.pack || {};
      const drafted = pack.instagram || pack.facebook || pack.linkedin || pack.blog || '';
      setPText(drafted);
      workspace.setTopic(aiTopic, { source: 'calendar' });
      // Persist it like every other generator does, so a draft written on the
      // calendar is not lost when the scheduling panel closes.
      try {
        const saved = await fetch('/api/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: aiTopic, pack }),
        });
        if (saved.ok) announce('drafts', 'stats');
      } catch { /* the draft is still usable in the composer */ }
    } catch (e: any) {
      setErr(e?.message || 'Failed to draft with AI');
    } finally {
      setAiBusy(false);
    }
  }

  useEffect(() => { refresh(); }, []);

  // The calendar grid is the same `posts` table the dashboard's queue and stat
  // cards read, so anything that schedules, approves or reschedules a post
  // anywhere in the app refreshes this grid.
  useEffect(() => onRefresh((scopes) => { if (scopes.includes('posts')) refresh(); }), []);

  // Carry the current topic in from the generator / Semrush.
  useEffect(() => {
    if (workspace.topic && !aiTopic) setAiTopic(workspace.topic);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.topic]);

  async function refresh() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch('/api/posts');
      if (!r.ok) throw new Error('Failed to load posts (' + r.status + ')');
      const j = await r.json().catch(() => null);
      setPosts(toArray(j));
    } catch (e: any) {
      setErr(e && e.message ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  const grid = useMemo(() => buildGrid(cursor.year, cursor.month), [cursor.year, cursor.month]);

  const byDay = useMemo(() => {
    const m: Record<string, Post[]> = {};
    for (const p of posts) {
      const k = postDayKey(p.publication_date);
      if (!k) continue;
      (m[k] = m[k] || []).push(p);
    }
    return m;
  }, [posts]);

  function prevMonth() {
    setCursor((c) => {
      const d = new Date(c.year, c.month - 1, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }
  function nextMonth() {
    setCursor((c) => {
      const d = new Date(c.year, c.month + 1, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }
  function goToday() {
    const n = new Date();
    setCursor({ year: n.getFullYear(), month: n.getMonth() });
  }

  // Reschedule: keep the original time-of-day, move to the dropped calendar day.
  async function reschedule(id: string, targetDay: Date) {
    const post = posts.find((p) => p.id === id);
    if (!post) return;
    // Keep the post's time of day AS THE CLINIC READS IT, and land it on the
    // dropped square. Reading getHours() off the viewer's clock moved the post
    // by the offset between the two zones every time it was dragged.
    const w = post.publication_date ? scheduleWallClock(post.publication_date) : null;
    const iso = isoAtScheduleWallClock(
      targetDay.getFullYear(), targetDay.getMonth() + 1, targetDay.getDate(),
      w ? w.hh : 9, w ? w.mm : 0
    );
    if (postDayKey(post.publication_date) === dateKey(targetDay)) return; // no-op

    // optimistic update
    setPosts((prev) => prev.map((p) => (p.id === id ? { ...p, publication_date: iso } : p)));
    setSaving(id);
    try {
      const r = await fetch('/api/posts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, publication_date: iso }),
      });
      // The server refuses the local move when it cannot move the post in
      // Metricool, so a failure here means nothing changed anywhere - put the
      // chip back and say why, instead of leaving the calendar disagreeing
      // with the account it is supposed to mirror.
      if (!r.ok) throw new Error(await friendlyErrorFromResponse(r, 'We could not move that post.'));
      announce('posts', 'stats', 'insights');
    } catch (e: any) {
      setErr(friendlyError(e, 'We could not move that post.'));
      refresh(); // revert to server truth
    } finally {
      setSaving(null);
    }
  }

  // The reviewer's yes, from the calendar. Same endpoint and same rules as the
  // dashboard queue: Metricool moves the post to its live queue first, and our
  // row changes only if that succeeded.
  async function approve(post: Post) {
    if (!post.id) return;
    const nets = (post.providers || []).map(networkLabel).join(', ') || 'the selected channels';
    if (!window.confirm('Approve this post?\n\nIt will be published to ' + nets + ' at ' + timeLabel(post.publication_date) + ' on this day (' + scheduleTzLabel() + ' time). Metricool does the publishing.')) return;
    setSaving(post.id);
    try {
      const r = await fetch('/api/posts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: post.id, action: 'approve' }),
      });
      if (!r.ok) throw new Error(await friendlyErrorFromResponse(r, 'We could not approve that post.'));
      await refresh();
      announce('posts', 'stats', 'insights');
    } catch (e: any) {
      setErr(friendlyError(e, 'We could not approve that post.'));
    } finally {
      setSaving(null);
    }
  }

  // Open the scheduling panel for a given day.
  function openScheduler(day: Date) {
    setScheduleDay(day);
    setPNetworks(['facebook']);
    setPTime('09:00');
    setPText('');
    setPStatus(null);
  }

  function togglePNetwork(id: string) {
    setPNetworks((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  // Schedule a new post on the selected day across all chosen networks.
  async function submitSchedule() {
    if (!scheduleDay) return;
    if (!pNetworks.length) { setPStatus('Pick at least one network.'); return; }
    if (!pText.trim()) { setPStatus('Add some post text.'); return; }
    const overBy = pOverBy;
    if (overBy > 0) {
      setPStatus('Too long for ' + networkLabel(pLimit!.network) + ' by ' + overBy.toLocaleString() + ' character' + (overBy === 1 ? '' : 's') + '. Trim it, or unselect that channel.');
      return;
    }
    const [hh, mm] = pTime.split(':').map((x) => parseInt(x, 10));
    // "09:00" means 9 AM at the clinic, not 9 AM wherever the browser is.
    const publishAt = isoAtScheduleWallClock(
      scheduleDay.getFullYear(), scheduleDay.getMonth() + 1, scheduleDay.getDate(),
      isNaN(hh) ? 9 : hh, isNaN(mm) ? 0 : mm
    );

    setPBusy(true);
    setPStatus(null);
    try {
      const results = await Promise.all(
        pNetworks.map(async (network) => {
          const r = await fetch('/api/metricool/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ network, text: pText, publishAt, blogId: 4308292 }),
          });
          return { network, ok: r.ok };
        })
      );
      const ok = results.filter((x) => x.ok).map((x) => x.network);
      const failed = results.filter((x) => !x.ok).map((x) => x.network);
      await refresh();
      if (ok.length) announce('posts', 'stats', 'insights');
      if (failed.length === 0) {
        setPStatus('Scheduled on ' + ok.join(', ') + '.');
        setScheduleDay(null);
      } else if (ok.length === 0) {
        setPStatus('Error: failed on ' + failed.join(', ') + '.');
      } else {
        setPStatus('Scheduled on ' + ok.join(', ') + '; failed on ' + failed.join(', ') + '.');
      }
    } catch (e: any) {
      setPStatus('Error: ' + (e?.message || 'failed'));
    } finally {
      setPBusy(false);
    }
  }

  // The dashboard composer has enforced network character limits for months;
  // this panel did not, so an over-limit post got as far as Metricool before
  // anything said no. Same helper, same rule, both places.
  const pLimit = tightestLimit(pNetworks);
  const pOverBy = pLimit ? Math.max(0, pText.length - pLimit.limit) : 0;

  const monthLabel = `${MONTHS[cursor.month]} ${cursor.year}`;
  // Empty until mount, so the server-rendered grid never marks a stale day.
  const todayKey = mounted ? dateKey(today) : '';

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <header className="flex items-center justify-between border-b border-black/5 bg-surface px-8 py-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Content Calendar</h1>
          <p className="mt-1 text-sm text-ink/50">Click a day to schedule a post, or drag a post to another day to reschedule it. All times {scheduleTzLabel()} time.</p>
        </div>
        <PageNav current="/calendar" />
      </header>

      <div className="mx-auto max-w-[1100px] px-6 py-8">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button onClick={prevMonth} className="rounded-full border border-black/10 bg-surface px-4 py-2 text-sm text-ink transition hover:bg-black/5">&lsaquo; Prev</button>
            <button onClick={goToday} className="rounded-full border border-black/10 bg-surface px-4 py-2 text-sm text-ink transition hover:bg-black/5">Today</button>
            <button onClick={nextMonth} className="rounded-full border border-black/10 bg-surface px-4 py-2 text-sm text-ink transition hover:bg-black/5">Next &rsaquo;</button>
          </div>
          <h2 className="text-lg font-semibold">{monthLabel}</h2>
          <div className="min-w-[90px] text-right text-xs text-ink/40">
            {saving ? 'Saving…' : loading ? 'Loading…' : ''}
          </div>
        </div>

        {err && (
          <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">Error: {err}</div>
        )}

        <div className="grid grid-cols-7 gap-2">
          {DOW.map((d) => (
            <div key={d} className="py-1 text-center text-xs font-medium text-ink/40">{d}</div>
          ))}
          {grid.map((day) => {
            const k = dateKey(day);
            const inMonth = day.getMonth() === cursor.month;
            const isToday = k === todayKey;
            const dayPosts = byDay[k] || [];
            return (
              <div
                key={k}
                onClick={() => openScheduler(day)}
                onDragOver={(e) => { if (dragId) e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (dragId) reschedule(dragId, day); }}
                className={
                  'group flex min-h-[104px] cursor-pointer flex-col rounded-xl border p-2 transition ' +
                  (inMonth ? 'bg-surface ' : 'bg-canvas ') +
                  (isToday ? 'border-accent ring-1 ring-accent/40 ' : 'border-black/5 ') +
                  'hover:border-accent/60 hover:bg-accent/5 '
                }
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] text-accent opacity-0 transition group-hover:opacity-100">+ Add</span>
                  <span className={'text-xs ' + (isToday ? 'font-semibold text-accent ' : inMonth ? 'text-ink/60 ' : 'text-ink/25 ')}>{day.getDate()}</span>
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  {dayPosts.map((p) => (
                    <div
                      key={p.id}
                      draggable
                      onClick={(e) => e.stopPropagation()}
                      onDragStart={() => setDragId(p.id || null)}
                      onDragEnd={() => setDragId(null)}
                      title={p.text || ''}
                      className={
                        'cursor-grab rounded-lg border border-accent/20 bg-accent/5 px-2 py-1 text-[11px] leading-tight text-ink transition hover:bg-accent/10 active:cursor-grabbing ' +
                        (saving === p.id ? 'opacity-50 ' : '')
                      }
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-medium text-accent">{timeLabel(p.publication_date)}</span>
                        {isAwaitingApproval(p.status) ? (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void approve(p); }}
                            disabled={saving === p.id}
                            title="Approve — Metricool publishes it at this time"
                            className="rounded-full bg-accent px-1.5 py-[1px] text-[9px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                          >
                            Approve
                          </button>
                        ) : (
                          <span className="text-[9px] font-medium text-emerald-700">{statusWord(p.status)}</span>
                        )}
                      </div>
                      <div className="truncate">{p.text || 'Untitled post'}</div>
                      {p.providers && p.providers.length > 0 && (
                        <div className="mt-0.5 truncate text-[10px] text-ink/40">{p.providers.join(', ')}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {!loading && posts.length === 0 && (
          <p className="mt-6 text-sm text-ink/50">No scheduled posts yet. Click any day above to schedule one.</p>
        )}
      </div>

      {scheduleDay && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
          onClick={() => { if (!pBusy) setScheduleDay(null); }}
        >
          <div
            className="relative w-full max-w-md rounded-2xl bg-surface p-5 shadow-2xl ring-1 ring-black/10"
            onClick={(e) => e.stopPropagation()}
          >
            <PanelLoader scope="calendar" rounded="rounded-2xl" />
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-base font-semibold text-ink">Schedule a post</h3>
                <p className="mt-0.5 text-sm text-ink/50">
                  {scheduleDay.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
              <button onClick={() => setScheduleDay(null)} aria-label="Close" className="rounded-full p-1 text-ink/40 hover:bg-black/5 hover:text-ink">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>

            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink/40">Networks</label>
            <div className="mb-4 flex flex-wrap gap-2">
              {NETWORKS.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => togglePNetwork(n.id)}
                  aria-pressed={pNetworks.includes(n.id)}
                  className={
                    'rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition ' +
                    (pNetworks.includes(n.id) ? 'bg-accent text-white ring-accent' : 'bg-canvas text-ink ring-black/10 hover:ring-accent/50')
                  }
                >
                  {n.label}
                </button>
              ))}
            </div>

            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink/40">Time</label>
            <input
              type="time"
              value={pTime}
              onChange={(e) => setPTime(e.target.value)}
              className="mb-4 w-full rounded-xl bg-canvas px-3 py-2 text-sm text-ink outline-none ring-1 ring-black/10 focus:ring-accent/40"
            />

            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink/40">Draft with AI</label>
            <div className="mb-4 rounded-xl bg-canvas p-3 ring-1 ring-black/10">
              <div className="mb-2 flex items-center gap-2">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 2l1.9 5.4L19 9.3l-4.6 2.3L12 17l-2.4-5.4L5 9.3l5.1-1.9L12 2z" fill="#0071e3" />
                </svg>
                <span className="text-xs text-ink/50">Let GPT or Anthropic write this post for you.</span>
              </div>
              <div className="mb-2 flex gap-2">
                {([['anthropic', 'Anthropic'], ['openai', 'GPT']] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setAiProvider(val)}
                    className={'rounded-full px-3 py-1 text-xs font-medium transition ring-1 ring-black/10 ' + (aiProvider === val ? 'bg-accent text-white' : 'bg-surface text-ink hover:bg-black/5')}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <input
                  value={aiTopic}
                  onChange={(e) => setAiTopic(e.target.value)}
                  placeholder="What should this post be about?"
                  className="w-full rounded-lg bg-surface px-3 py-2 text-sm text-ink outline-none ring-1 ring-black/10 focus:ring-accent/40"
                />
                <button
                  type="button"
                  onClick={draftWithAI}
                  disabled={aiBusy}
                  className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {aiBusy ? 'Drafting…' : 'Draft with AI'}
                </button>
              </div>
            </div>

            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink/40">Post text</label>
            <textarea
              value={pText}
              onChange={(e) => setPText(e.target.value)}
              rows={4}
              placeholder="What should this post say?"
              className="mb-1 w-full resize-none rounded-xl bg-canvas px-3 py-2 text-sm text-ink outline-none ring-1 ring-black/10 focus:ring-accent/40"
            />
            <p className={'mb-4 text-xs ' + (pOverBy > 0 ? 'text-red-600' : 'text-ink/40')}>
              {pOverBy > 0
                ? 'Too long for ' + networkLabel(pLimit!.network) + ' by ' + pOverBy.toLocaleString() + ' character' + (pOverBy === 1 ? '' : 's') + '. Trim it, or unselect that channel.'
                : pLimit
                  ? pText.length.toLocaleString() + ' / ' + pLimit.limit.toLocaleString() + ' characters · ' + networkLabel(pLimit.network) + ' is the tightest limit'
                  : pText.length.toLocaleString() + ' characters'}
            </p>

            {pStatus && (
              <div className={'mb-3 text-sm ' + (pStatus.startsWith('Error') ? 'text-red-600' : 'text-ink/60')}>{pStatus}</div>
            )}

            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setScheduleDay(null)} disabled={pBusy} className="rounded-full border border-black/10 px-4 py-2 text-sm text-ink/70 transition hover:bg-black/5 disabled:opacity-50">Cancel</button>
              <button onClick={submitSchedule} disabled={pBusy || pOverBy > 0} className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50">
                {pBusy ? 'Scheduling…' : 'Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
