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
    const orig = new Date(post.publication_date);
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
    <main style={{ minHeight: '100vh', background: '#0a0e1a', color: '#e6edf3', fontFamily: '-apple-system,Segoe UI,sans-serif' }}>
      <header style={{ padding: '20px 32px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Content Calendar</h1>
          <div style={{ fontSize: 13, opacity: .6, marginTop: 4 }}>Drag a post to another day to reschedule it.</div>
        </div>
        <a href="/" style={{ color: '#9ca3af', fontSize: 13, textDecoration: 'none', border: '1px solid #1f2937', padding: '6px 12px', borderRadius: 6 }}>Back to dashboard</a>
      </header>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={prevMonth} style={{ background: '#0f172a', color: '#e6edf3', border: '1px solid #1f2937', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}>‹ Prev</button>
            <button onClick={goToday} style={{ background: '#0f172a', color: '#e6edf3', border: '1px solid #1f2937', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}>Today</button>
            <button onClick={nextMonth} style={{ background: '#0f172a', color: '#e6edf3', border: '1px solid #1f2937', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}>Next ›</button>
          </div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{monthLabel}</h2>
          <div style={{ fontSize: 12, opacity: .6, minWidth: 90, textAlign: 'right' }}>{saving ? 'Saving…' : loading ? 'Loading…' : ''}</div>
        </div>

        {err && <div style={{ color: '#f87171', fontSize: 14, marginBottom: 12 }}>Error: {err}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
          {DOW.map((d) => (
            <div key={d} style={{ fontSize: 12, opacity: .6, textAlign: 'center', padding: '4px 0' }}>{d}</div>
          ))}
          {grid.map((day) => {
            const k = dateKey(day);
            const inMonth = day.getMonth() === cursor.month;
            const isToday = k === todayKey;
            const items = byDay[k] || [];
            return (
              <div
                key={k}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); if (dragId) reschedule(dragId, day); setDragId(null); }}
                style={{
                  minHeight: 96,
                  background: inMonth ? '#0f172a' : '#0b1220',
                  border: '1px solid ' + (isToday ? '#3b82f6' : '#1f2937'),
                  borderRadius: 8,
                  padding: 6,
                  opacity: inMonth ? 1 : .5,
                }}
              >
                <div style={{ fontSize: 11, opacity: .7, marginBottom: 4, textAlign: 'right' }}>{day.getDate()}</div>
                <div style={{ display: 'grid', gap: 4 }}>
                  {items.map((p, i) => (
                    <div
                      key={(p.id) || i}
                      draggable
                      onDragStart={() => setDragId(p.id || null)}
                      onDragEnd={() => setDragId(null)}
                      title={p.text || ''}
                      style={{
                        background: '#1e293b',
                        border: '1px solid #334155',
                        borderRadius: 6,
                        padding: '4px 6px',
                        cursor: 'grab',
                        fontSize: 11,
                        opacity: saving === p.id ? .5 : 1,
                      }}
                    >
                      <div style={{ opacity: .7, marginBottom: 2 }}>{timeLabel(p.publication_date)} · {(p.providers && p.providers.join(', ')) || '-'}</div>
                      <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.text || '(no text)'}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {!loading && !err && posts.length === 0 && (
          <div style={{ opacity: .6, fontSize: 14, marginTop: 16 }}>No scheduled posts yet. Schedule one from the dashboard.</div>
        )}
      </div>
    </main>
  );
}
