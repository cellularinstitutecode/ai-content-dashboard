'use client';

// components/YouTubeStats.tsx
// The YouTube channel's community numbers on the dashboard's main page:
// subscribers (with the net change) and video views for the last 30 days, from
// Metricool's Community · Growth data. Read from GET /api/metricool/youtube; a figure Metricool did not
// return shows as "—", never as a made-up zero.

import { useEffect, useState } from 'react';
import { friendlyError, friendlyErrorFromResponse } from '@/lib/friendly-error';
import type { YouTubeStats as Stats } from '@/lib/youtube-stats';

const fmt = (n: number | null | undefined, opts: Intl.NumberFormatOptions = {}) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 0, ...opts });

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string | null; tone: string }) {
  return (
    <div className={'rounded-2xl px-4 py-3 ring-1 ' + tone}>
      <div className="text-[26px] font-semibold leading-tight tabular-nums">{value}</div>
      <div className="text-[12px] font-medium opacity-80">{label}</div>
      {sub && <div className="mt-0.5 text-[11px] opacity-70">{sub}</div>}
    </div>
  );
}

export default function YouTubeStats() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/metricool/youtube');
        if (!r.ok) { if (!cancelled) setErr(await friendlyErrorFromResponse(r, 'The YouTube numbers could not be read from Metricool just now.')); return; }
        const j = await r.json();
        if (!cancelled) { setStats(j?.stats ?? null); setDays(Number(j?.days) || 30); }
      } catch (e) {
        if (!cancelled) setErr(friendlyError(e, 'The YouTube numbers could not be read from Metricool just now.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const change = stats?.subscribersChange;
  const changeText = change == null ? null : (change > 0 ? '+' : '') + change.toLocaleString() + ' in ' + days + ' days';

  return (
    <section id="section-youtube" className="mb-8 rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7 2xl:col-span-2 2xl:mb-0" aria-label="YouTube community">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-ink">YouTube community</h2>
        <span className="text-[12px] text-ink-faint">Last {days} days · from Metricool</span>
      </div>
      {loading ? (
        <p className="mt-3 text-[13px] text-ink-faint">Reading the channel&rsquo;s numbers…</p>
      ) : err ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-900 ring-1 ring-amber-200/60">{err}</p>
      ) : (
        // Subscribers and views only, as the team asked.
        <div className="mt-4 grid grid-cols-2 gap-3">
          <Tile label="Subscribers" value={fmt(stats?.subscribers)} sub={changeText} tone="bg-indigo-50 text-indigo-900 ring-indigo-100" />
          <Tile label="Video views" value={fmt(stats?.views)} tone="bg-emerald-50 text-emerald-900 ring-emerald-100" />
        </div>
      )}
    </section>
  );
}
