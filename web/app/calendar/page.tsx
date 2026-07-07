'use client';

import { useEffect, useState } from 'react';

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

function dayKey(iso?: string) {
  if (!iso) return 'Unscheduled';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Unscheduled';
  return d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}

function timeLabel(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export default function CalendarPage() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true); setErr(null);
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

  const groups: Record<string, Post[]> = {};
  for (const p of posts) {
    const k = dayKey(p.publication_date);
    (groups[k] = groups[k] || []).push(p);
  }
  const dayKeys = Object.keys(groups);

  return (
    <main style={{ minHeight: '100vh', background: '#0a0e1a', color: '#e6edf3', fontFamily: '-apple-system,Segoe UI,sans-serif' }}>
      <header style={{ padding: '20px 32px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Content Calendar</h1>
          <div style={{ fontSize: 13, opacity: .7 }}>Upcoming and past scheduled posts</div>
        </div>
        <a href="/" style={{ color: '#9ca3af', fontSize: 13, textDecoration: 'none', border: '1px solid #1f2937', padding: '6px 12px', borderRadius: 6 }}>Back to dashboard</a>
      </header>

      <div style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
        {loading && <div style={{ opacity: .6, fontSize: 14 }}>Loading calendar...</div>}
        {err && <div style={{ color: '#f87171', fontSize: 14 }}>Error: {err}</div>}
        {!loading && !err && dayKeys.length === 0 && (
          <div style={{ opacity: .6, fontSize: 14 }}>No scheduled posts yet. Schedule one from the dashboard.</div>
        )}
        {dayKeys.map((k) => (
          <section key={k} style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 15, borderBottom: '1px solid #1f2937', paddingBottom: 8, marginBottom: 12 }}>{k}</h2>
            <div style={{ display: 'grid', gap: 10 }}>
              {groups[k].map((p, i) => (
                <div key={(p.id) || i} style={{ padding: 14, background: '#0f172a', border: '1px solid #1f2937', borderRadius: 10, display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                  <div style={{ fontSize: 13, opacity: .8, minWidth: 60 }}>{timeLabel(p.publication_date)}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, opacity: .6, marginBottom: 4 }}>
                      {(p.providers && p.providers.join(', ')) || '-'} - {p.status || 'scheduled'}
                    </div>
                    <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{p.text || '(no text)'}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
