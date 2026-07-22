'use client';

import { useEffect, useMemo, useState } from 'react';

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

// Local YYYY-MM-DD key for a Date (avoids UTC drift).
function dateKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function postDayKey(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return dateKey(d);
}

function timeLabel(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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

  const today = new Date();
  const [cursor, setCursor] = useState(() => ({ year: today.getFullYear(), month: today.getMonth() }));

  useEffect(() => { refresh(); }, []);

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
    const orig = new Date(post.publication_date ?? '');
    const next = new Date(targetDay);
    if (!isNaN(orig.getTime())) {
      next.setHours(orig.getHours(), orig.getMinutes(), 0, 0);
    } else {
      next.setHours(9, 0, 0, 0);
    }
    if (postDayKey(post.publication_date) === dateKey(next)) return; // no-op

    const iso = next.toISOString();
    // optimistic update
    setPosts((prev) => prev.map((p) => (p.id === id ? { ...p, publication_date: iso } : p)));
    setSaving(id);
    try {
      const r = await fetch('/api/posts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, publication_date: iso }),
      });
      if (!r.ok) throw new Error('reschedule failed (' + r.status + ')');
    } catch (e: any) {
      setErr(e && e.message ? e.message : 'Reschedule failed');
      refresh(); // revert to server truth
    } finally {
      setSaving(null);
    }
  }

  const monthLabel = `${MONTHS[cursor.month]} ${cursor.year}`;
  const todayKey = dateKey(today);

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <header className="flex items-center justify-between border-b border-black/5 bg-surface px-8 py-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Content Calendar</h1>
          <p className="mt-1 text-sm text-ink/50">Drag a post to another day to reschedule it.</p>
        </div>
        <a
          href="/"
          className="rounded-full border border-black/10 px-4 py-2 text-sm text-ink/70 transition hover:bg-black/5 hover:text-ink"
        >
          Back to dashboard
        </a>
      </header>

      <div className="mx-auto max-w-[1100px] px-6 py-8">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={prevMonth}
              className="rounded-full border border-black/10 bg-surface px-4 py-2 text-sm text-ink transition hover:bg-black/5"
            >
              &lsaquo; Prev
            </button>
            <button
              onClick={goToday}
              className="rounded-full border border-black/10 bg-surface px-4 py-2 text-sm text-ink transition hover:bg-black/5"
            >
              Today
            </button>
            <button
              onClick={nextMonth}
              className="rounded-full border border-black/10 bg-surface px-4 py-2 text-sm text-ink transition hover:bg-black/5"
            >
              Next &rsaquo;
            </button>
          </div>
          <h2 className="text-lg font-semibold">{monthLabel}</h2>
          <div className="min-w-[90px] text-right text-xs text-ink/40">
            {saving ? 'Saving…' : loading ? 'Loading…' : ''}
          </div>
        </div>

        {err && (
          <div className="mb-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            Error: {err}
          </div>
        )}

        <div className="grid grid-cols-7 gap-2">
          {DOW.map((d) => (
            <div key={d} className="py-1 text-center text-xs font-medium text-ink/40">
              {d}
            </div>
          ))}
          {grid.map((day) => {
            const k = dateKey(day);
            const inMonth = day.getMonth() === cursor.month;
            const isToday = k === todayKey;
            const dayPosts = byDay[k] || [];
            return (
              <div
                key={k}
                onDragOver={(e) => {
                  if (dragId) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId) reschedule(dragId, day);
                }}
                className={
                  'flex min-h-[104px] flex-col rounded-xl border p-2 transition ' +
                  (inMonth ? 'bg-surface ' : 'bg-canvas ') +
                  (isToday ? 'border-accent ring-1 ring-accent/40 ' : 'border-black/5 ') +
                  (dragId ? 'hover:border-accent/60 hover:bg-accent/5 ' : '')
                }
              >
                <div
                  className={
                    'mb-1 text-right text-xs ' +
                    (isToday ? 'font-semibold text-accent ' : inMonth ? 'text-ink/60 ' : 'text-ink/25 ')
                  }
                >
                  {day.getDate()}
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  {dayPosts.map((p) => (
                    <div
                      key={p.id}
                      draggable
                      onDragStart={() => setDragId(p.id || null)}
                      onDragEnd={() => setDragId(null)}
                      title={p.text || ''}
                      className={
                        'cursor-grab rounded-lg border border-accent/20 bg-accent/5 px-2 py-1 text-[11px] leading-tight text-ink transition hover:bg-accent/10 active:cursor-grabbing ' +
                        (saving === p.id ? 'opacity-50 ' : '')
                      }
                    >
                      <div className="font-medium text-accent">{timeLabel(p.publication_date)}</div>
                      <div className="truncate">{p.text || 'Untitled post'}</div>
                      {p.providers && p.providers.length > 0 && (
                        <div className="mt-0.5 truncate text-[10px] text-ink/40">
                          {p.providers.join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {!loading && posts.length === 0 && (
          <p className="mt-6 text-sm text-ink/50">No scheduled posts yet. Schedule one from the dashboard.</p>
        )}
      </div>
    </main>
  );
}
