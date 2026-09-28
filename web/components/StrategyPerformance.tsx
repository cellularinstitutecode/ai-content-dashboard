'use client';

// How each pillar of the weekly strategy is doing (Phase 4).
//
// The numbers are Metricool's, as the daily sync stored them; the pillar,
// angle and caption shape come from the runs that wrote each post
// (lib/strategy-performance.ts). It says how many posts it could measure,
// because a pillar with one measured post is a sample, not a verdict.

import { useCallback, useEffect, useState } from 'react';
import { onRefresh } from '@/components/refreshBus';
import { friendlyError, friendlyErrorFromResponse } from '@/lib/friendly-error';
import type { StrategyPerformance as Perf, PerfCell } from '@/lib/strategy-performance';

type Payload = ({ loaded: true; days: number } & Perf) | { loaded: false; days: number };

const cardStyle: React.CSSProperties = { background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: 24 };
const th: React.CSSProperties = { padding: '5px 8px', fontWeight: 600, textAlign: 'left', opacity: .6, fontSize: 12 };
const td: React.CSSProperties = { padding: '5px 8px', fontSize: 13, borderTop: '1px solid rgba(0,0,0,0.06)', verticalAlign: 'top' };
const num: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

const fmt = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US'));

function Cells({ c }: { c: PerfCell }) {
  return (
    <>
      <td style={num}>{c.posts}</td>
      <td style={num}>{c.measured}</td>
      <td style={num}>{fmt(c.avgEngagement)}</td>
      <td style={num}>{fmt(c.avgImpressions)}</td>
    </>
  );
}

function Head({ first }: { first: string }) {
  return (
    <thead>
      <tr>
        <th style={th}>{first}</th>
        <th style={{ ...th, textAlign: 'right' }}>Published</th>
        <th style={{ ...th, textAlign: 'right' }}>Measured</th>
        <th style={{ ...th, textAlign: 'right' }}>Avg engagement</th>
        <th style={{ ...th, textAlign: 'right' }}>Avg impressions</th>
      </tr>
    </thead>
  );
}

async function fetchPerformance(): Promise<{ data: Payload } | { err: string }> {
  try {
    const r = await fetch('/api/strategy/performance');
    if (!r.ok) return { err: await friendlyErrorFromResponse(r, 'We could not load the strategy performance.') };
    return { data: (await r.json()) as Payload };
  } catch (e) {
    return { err: friendlyError(e, 'We could not reach the server to load the strategy performance.') };
  }
}

export default function StrategyPerformance() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    void fetchPerformance().then((res) => {
      if ('data' in res) { setData(res.data); setErr(null); } else setErr(res.err);
    });
  }, []);

  useEffect(() => {
    let live = true;
    void fetchPerformance().then((res) => {
      if (!live) return;
      if ('data' in res) { setData(res.data); setErr(null); } else setErr(res.err);
    });
    return () => { live = false; };
  }, []);
  useEffect(() => onRefresh((scopes) => { if (scopes.includes('insights') || scopes.includes('templates')) load(); }), [load]);

  if (!data && !err) return null;
  if (data && !data.loaded) return null; // No strategy loaded: nothing to measure.

  return (
    <section style={cardStyle} aria-label="Strategy performance">
      <h2 style={{ margin: 0, fontSize: 17 }}>How the strategy is doing</h2>
      <p style={{ margin: '4px 0 0', fontSize: 13, opacity: .65 }}>
        Metricool&apos;s numbers for strategy posts published in the last {data?.days ?? 90} days, by pillar and caption shape.
        A post counts once it is approved and its time has passed — posts still in Metricool&apos;s review queue or yet to go out are not counted.
      </p>
      {err && <div role="alert" style={{ color: '#d70015', fontSize: 13, marginTop: 10 }}>{err}</div>}
      {data && data.loaded && (
        data.totals.posts === 0 ? (
          <div style={{ fontSize: 13, opacity: .7, marginTop: 14 }}>
            No strategy posts have gone out yet. The first numbers appear the morning after its first posts publish.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, opacity: .7, marginTop: 10 }}>
              {data.totals.measured} of {data.totals.posts} published posts measured.
              {data.totals.measured < data.totals.posts && ' The rest are not in Metricool\'s daily numbers yet (they sync each morning), or their caption was changed in Metricool after it was sent.'}
            </div>
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <Head first="Pillar" />
                <tbody>
                  {data.pillars.map((p) => (
                    <tr key={p.id}>
                      <td style={td}>
                        {p.name}
                        {p.best && <div style={{ fontSize: 11, opacity: .6, marginTop: 2 }}>Best: {p.best.angle}</div>}
                      </td>
                      <Cells c={p} />
                    </tr>
                  ))}
                  <tr>
                    <td style={td}>Weekly article</td>
                    <Cells c={data.article} />
                  </tr>
                </tbody>
              </table>
            </div>
            {data.formats.length > 0 && (
              <div style={{ overflowX: 'auto', marginTop: 18 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <Head first="Caption shape" />
                  <tbody>
                    {data.formats.map((f) => (
                      <tr key={f.format}>
                        <td style={td}>{f.label}</td>
                        <Cells c={f} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ fontSize: 11, opacity: .55, marginTop: 10 }}>
              A slot that covers two pillars (Monday&apos;s assessment post also counts for follow-up) is counted in both. Engagement is summed across the networks a post went to.
            </div>
          </>
        )
      )}
    </section>
  );
}
