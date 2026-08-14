'use client';
// web/app/SemrushPanel.tsx
// Semrush Intelligence — the comprehensive SEO command center that replaces the
// old single-topic Keyword Intelligence card. Six views:
//   Overview      — authority score, Semrush rank, organic/paid traffic &
//                   keywords, backlinks, ref domains (domain_ranks +
//                   backlinks_overview), position distribution
//   Top Keywords  — the domain's ranking keywords with positions, volume, KD,
//                   traffic share (domain_organic) — one click to draft
//   Competitors   — organic rivals with competition level + common keywords
//   Backlinks     — link profile breakdown (follow/nofollow, text/image)
//   Site Health   — Site Audit score, errors/warnings + Position Tracking
//                   visibility trend (Projects API, needs SEMRUSH_PROJECT_ID)
//   Keyword Research — the existing topic-based keyword brief that feeds every
//                   AI draft (unchanged, embedded)
// Cache-first and budget-guarded like everything else in the Semrush brain:
// repeat loads cost 0 API units; a live unit-balance chip keeps spending honest.
import { useEffect, useRef, useState } from 'react';
import KeywordIntelligence from './KeywordIntelligence';

// ---------------------------------------------------------------------------
// Types (mirror lib/semrush-domain.ts)
// ---------------------------------------------------------------------------

type SectionMeta = { ok: boolean; source: 'live' | 'cache' | 'none'; reason: string; note?: string; unitsSpent: number };

type DomainOverview = {
  domain: string;
  rank: number | null;
  organicKeywords: number | null;
  organicTraffic: number | null;
  organicCost: number | null;
  paidKeywords: number | null;
  paidTraffic: number | null;
  paidCost: number | null;
};

type BacklinksOverview = {
  authorityScore: number | null;
  backlinksTotal: number | null;
  refDomains: number | null;
  refUrls: number | null;
  refIps: number | null;
  follows: number | null;
  nofollows: number | null;
  texts: number | null;
  images: number | null;
};

type OrganicKeywordRow = {
  keyword: string;
  position: number | null;
  prevPosition: number | null;
  positionDiff: number | null;
  volume: number | null;
  cpc: number | null;
  url: string;
  trafficPct: number | null;
  difficulty: number | null;
  intents: string[];
};

type CompetitorRow = {
  domain: string;
  competitionLevel: number | null;
  commonKeywords: number | null;
  organicKeywords: number | null;
  organicTraffic: number | null;
  organicCost: number | null;
};

type DomainBundle = {
  domain: string;
  isPrimaryDomain: boolean;
  overview: DomainOverview | null;
  overviewMeta: SectionMeta;
  backlinks: BacklinksOverview | null;
  backlinksMeta: SectionMeta;
  topKeywords: OrganicKeywordRow[];
  topKeywordsMeta: SectionMeta;
  competitors: CompetitorRow[];
  competitorsMeta: SectionMeta;
  balance: number | null;
  unitsSpent: number;
};

type SiteAuditSnapshot = {
  configured: boolean;
  status: string | null;
  health: number | null;
  healthDelta: number | null;
  errors: number | null;
  warnings: number | null;
  notices: number | null;
  pagesCrawled: number | null;
  pagesHealthy: number | null;
  pagesWithIssues: number | null;
  lastAudit: string | null;
};

type TrackingSummary = {
  configured: boolean;
  visibility: number | null;
  visibilityDelta: number | null;
  avgPosition: number | null;
  trend: { date: string; visibility: number | null }[];
};

type ProjectData = { audit: SiteAuditSnapshot; auditMeta: SectionMeta; tracking: TrackingSummary; trackingMeta: SectionMeta };

type Tab = 'overview' | 'keywords' | 'competitors' | 'backlinks' | 'health' | 'research';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtNum(v: number | null | undefined): string {
  if (v == null) return '—';
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (Math.abs(v) >= 10_000) return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return v.toLocaleString();
}

function fmtExact(v: number | null | undefined): string {
  return v == null ? '—' : v.toLocaleString();
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—';
  return '$' + fmtNum(Math.round(v));
}

function kdTone(d: number | null | undefined): string {
  if (d == null) return 'text-ink-faint';
  if (d < 30) return 'text-emerald-600';
  if (d < 50) return 'text-amber-600';
  return 'text-rose-600';
}

function posTone(p: number | null | undefined): string {
  if (p == null) return 'bg-subtle text-ink-muted';
  if (p <= 3) return 'bg-emerald-100 text-emerald-700';
  if (p <= 10) return 'bg-sky-100 text-sky-700';
  if (p <= 20) return 'bg-amber-100 text-amber-700';
  return 'bg-subtle text-ink-muted';
}

function healthTone(h: number | null): { text: string; hex: string } {
  if (h == null) return { text: 'text-ink-faint', hex: '#a1a1a6' };
  if (h >= 90) return { text: 'text-emerald-600', hex: '#34c759' };
  if (h >= 70) return { text: 'text-amber-600', hex: '#ff9f0a' };
  return { text: 'text-rose-600', hex: '#ff3b30' };
}

function ascoreTone(a: number | null): { text: string; hex: string } {
  if (a == null) return { text: 'text-ink-faint', hex: '#a1a1a6' };
  if (a >= 60) return { text: 'text-emerald-600', hex: '#34c759' };
  if (a >= 30) return { text: 'text-sky-600', hex: '#0071e3' };
  return { text: 'text-amber-600', hex: '#ff9f0a' };
}

function deltaChip(d: number | null | undefined, invert = false): { label: string; cls: string } | null {
  if (d == null || d === 0) return null;
  const good = invert ? d < 0 : d > 0;
  return {
    label: (d > 0 ? '▲ ' : '▼ ') + Math.abs(d),
    cls: good ? 'text-emerald-600' : 'text-rose-600',
  };
}

// Semrush deep links (always available, even without the API key)
const SEM = {
  overview: (d: string) => 'https://www.semrush.com/analytics/overview/?searchType=domain&q=' + encodeURIComponent(d),
  organic: (d: string) => 'https://www.semrush.com/analytics/organic/positions/?searchType=domain&q=' + encodeURIComponent(d) + '&db=us',
  competitors: (d: string) => 'https://www.semrush.com/analytics/organic/competitors/?searchType=domain&q=' + encodeURIComponent(d) + '&db=us',
  backlinks: (d: string) => 'https://www.semrush.com/analytics/backlinks/overview/' + encodeURIComponent(d) + '/',
  projects: () => 'https://www.semrush.com/projects/',
  keyword: (k: string) => 'https://www.semrush.com/analytics/keywordmagic/?q=' + encodeURIComponent(k) + '&db=us',
};

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function StatTile({ label, value, sub, delta, href }: { label: string; value: string; sub?: string; delta?: { label: string; cls: string } | null; href?: string }) {
  const inner = (
    <>
      <div className="text-[12px] font-medium text-ink-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[24px] font-semibold tabular-nums tracking-tight text-ink">{value}</span>
        {delta && <span className={'text-[12px] font-medium tabular-nums ' + delta.cls}>{delta.label}</span>}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-ink-faint">{sub}</div>}
    </>
  );
  const cls = 'rounded-2xl bg-white p-4 ring-1 ring-line' + (href ? ' block transition hover:ring-accent/40' : '');
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>{inner}</a>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

// Donut gauge (0..100). Number lives in the center; color signals status.
function Gauge({ value, hex, label }: { value: number | null; hex: string; label: string }) {
  const pct = value != null ? Math.max(0, Math.min(100, value)) : 0;
  const r = 42;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center">
      <svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label={label + ': ' + (value != null ? value : 'no data')}>
        <circle cx="60" cy="60" r={r} fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth="10" />
        <circle
          cx="60" cy="60" r={r} fill="none"
          stroke={value != null ? hex : 'rgba(0,0,0,0.07)'}
          strokeWidth="10" strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          transform="rotate(-90 60 60)"
        />
        <text x="60" y="58" textAnchor="middle" className="fill-ink" style={{ font: '600 24px -apple-system, BlinkMacSystemFont, sans-serif' }}>
          {value != null ? Math.round(value) + '%' : '—'}
        </text>
        <text x="60" y="76" textAnchor="middle" style={{ font: '400 10px -apple-system, BlinkMacSystemFont, sans-serif', fill: '#6e6e73' }}>
          {label}
        </text>
      </svg>
    </div>
  );
}

// Single-series sparkline: 2px accent line, no legend (title names the series).
function Sparkline({ points, width = 220, height = 48 }: { points: { date: string; visibility: number | null }[]; width?: number; height?: number }) {
  const vals = points.filter((p) => p.visibility != null) as { date: string; visibility: number }[];
  if (vals.length < 2) return <div className="text-[12px] text-ink-faint">Not enough history yet.</div>;
  const min = Math.min(...vals.map((p) => p.visibility));
  const max = Math.max(...vals.map((p) => p.visibility));
  const span = max - min || 1;
  const pad = 4;
  const pts = vals.map((p, i) => {
    const x = pad + (i / (vals.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (p.visibility - min) / span) * (height - pad * 2);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  return (
    <svg width={width} height={height} viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label="Visibility trend, last 30 days">
      <polyline points={pts.join(' ')} fill="none" stroke="#0071e3" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Segmented distribution bar — sequential single hue (accent, light→dark),
// 2px white gaps between segments, labels carry identity (never color alone).
function Distribution({ buckets }: { buckets: { label: string; count: number }[] }) {
  const total = buckets.reduce((s, b) => s + b.count, 0);
  const shades = ['rgba(0,113,227,0.25)', 'rgba(0,113,227,0.45)', 'rgba(0,113,227,0.7)', '#0071e3'];
  if (!total) return null;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-subtle" role="img" aria-label={'Position distribution: ' + buckets.map((b) => b.label + ' ' + b.count).join(', ')}>
        {buckets.map((b, i) =>
          b.count > 0 ? (
            <div key={b.label} style={{ width: (b.count / total) * 100 + '%', background: shades[i % shades.length], marginRight: i < buckets.length - 1 ? 2 : 0 }} />
          ) : null
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {buckets.map((b, i) => (
          <span key={b.label} className="inline-flex items-center gap-1.5 text-[12px] text-ink-muted">
            <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: shades[i % shades.length] }} />
            {b.label} <span className="font-medium tabular-nums text-ink">{b.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function SectionNotice({ meta, what }: { meta: SectionMeta; what: string }) {
  if (meta.ok) return null;
  const msg =
    meta.reason === 'no_token'
      ? what + ' needs the Semrush API connection (set SEMRUSH_API_KEY in Vercel).'
      : meta.reason === 'budget'
      ? 'Unit balance is at the protection floor — ' + what.toLowerCase() + ' will refresh when the budget recovers.'
      : meta.reason === 'plan'
      ? 'Your Semrush plan does not include API access to ' + what.toLowerCase() + ' (or the project/report is unavailable).'
      : meta.reason === 'auth'
      ? 'Semrush rejected the API key — verify SEMRUSH_API_KEY.'
      : meta.reason === 'empty'
      ? 'Semrush has no data for this yet.'
      : 'Could not load ' + what.toLowerCase() + (meta.note ? ' (' + meta.note + ')' : '') + '.';
  return <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-200">{msg}</p>;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export default function SemrushPanel({
  initialTopic = '',
  onUseTopic,
}: {
  initialTopic?: string;
  onUseTopic?: (draftPrompt: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const [domainInput, setDomainInput] = useState('');
  const [bundle, setBundle] = useState<DomainBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState<ProjectData | null>(null);
  const [projectLoading, setProjectLoading] = useState(false);
  const projectLoaded = useRef(false);

  async function loadDomain(domain?: string) {
    setLoading(true);
    try {
      const q = domain ? '&domain=' + encodeURIComponent(domain) : '';
      const r = await fetch('/api/semrush?action=domain' + q);
      const j = (await r.json().catch(() => null)) as DomainBundle | null;
      setBundle(j);
      if (j && !domainInput) setDomainInput(j.domain);
    } catch {
      setBundle(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadProject() {
    if (projectLoaded.current) return;
    projectLoaded.current = true;
    setProjectLoading(true);
    try {
      const r = await fetch('/api/semrush?action=project');
      const j = (await r.json().catch(() => null)) as ProjectData | null;
      setProject(j);
    } catch {
      setProject(null);
    } finally {
      setProjectLoading(false);
    }
  }

  // Load the primary domain bundle once on mount (cache-first server side).
  useEffect(() => {
    void loadDomain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const domain = bundle?.domain || domainInput || 'cellularhopeinstitute.com';
  const connected = bundle != null && (bundle.overviewMeta.reason !== 'no_token' || bundle.overviewMeta.ok);
  const anyLive = bundle != null && (bundle.overviewMeta.ok || bundle.backlinksMeta.ok || bundle.topKeywordsMeta.ok);
  const fromCache = bundle != null && [bundle.overviewMeta, bundle.backlinksMeta, bundle.topKeywordsMeta].some((m) => m.source === 'cache');

  const statusChip = loading
    ? { cls: 'bg-subtle text-ink-muted', label: 'Loading…' }
    : anyLive
    ? fromCache
      ? { cls: 'bg-sky-100 text-sky-700', label: 'Semrush data · cached' }
      : { cls: 'bg-emerald-100 text-emerald-700', label: 'Semrush data · live' }
    : connected
    ? { cls: 'bg-amber-100 text-amber-700', label: 'No data' }
    : { cls: 'bg-amber-100 text-amber-700', label: 'Not connected · link-out only' };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'keywords', label: 'Top keywords' },
    { id: 'competitors', label: 'Competitors' },
    { id: 'backlinks', label: 'Backlinks' },
    { id: 'health', label: 'Site health' },
    { id: 'research', label: 'Keyword research' },
  ];

  const ov = bundle?.overview ?? null;
  const bl = bundle?.backlinks ?? null;
  const kws = bundle?.topKeywords ?? [];

  const distBuckets = (() => {
    const b = [
      { label: 'Top 3', count: 0 },
      { label: 'Top 10', count: 0 },
      { label: 'Top 20', count: 0 },
      { label: 'Top 100', count: 0 },
    ];
    for (const k of kws) {
      const p = k.position;
      if (p == null) continue;
      if (p <= 3) b[0].count++;
      else if (p <= 10) b[1].count++;
      else if (p <= 20) b[2].count++;
      else b[3].count++;
    }
    return b;
  })();

  const aTone = ascoreTone(bl?.authorityScore ?? null);

  function sendToDraft(text: string) {
    if (onUseTopic) onUseTopic(text);
  }

  return (
    <section className="overflow-hidden rounded-3xl bg-white ring-1 ring-line shadow-soft">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-soft text-accent">📈</span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold text-ink">Semrush Intelligence</h3>
              <span className={'rounded-full px-2 py-0.5 text-[11px] font-medium ' + statusChip.cls}>{statusChip.label}</span>
              {bundle?.balance != null && (
                <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] tabular-nums text-ink-muted" title="Semrush API units remaining">
                  ⚡ {bundle.balance.toLocaleString()} units
                </span>
              )}
            </div>
            <p className="text-[12px] text-ink-muted">Domain health, rankings, competitors and backlinks — the full SEO picture behind every draft.</p>
          </div>
        </div>
        <a href={SEM.overview(domain)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[12px] font-medium text-accent hover:text-accent-hover">Open in Semrush ↗</a>
      </div>

      <div className="p-6">
        {/* Domain row */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void loadDomain(domainInput); }}
            placeholder="cellularhopeinstitute.com — or type any competitor domain"
            className="flex-1 rounded-xl bg-subtle px-3.5 py-2.5 text-[14px] text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-accent/40"
          />
          <button
            type="button"
            onClick={() => void loadDomain(domainInput)}
            disabled={loading}
            className="shrink-0 rounded-xl bg-accent px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
          >
            {loading ? 'Analyzing…' : 'Analyze domain'}
          </button>
        </div>
        {bundle && !bundle.isPrimaryDomain && (
          <p className="mt-2 text-[12px] text-ink-muted">
            Viewing <span className="font-medium text-ink">{bundle.domain}</span> ·{' '}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => { setDomainInput(''); void loadDomain(); }}>
              back to your domain
            </button>
          </p>
        )}

        {!loading && bundle && !anyLive && (
          <SectionNotice meta={bundle.overviewMeta} what="Domain intelligence" />
        )}

        {/* Tabs */}
        <div className="mt-5 flex flex-wrap gap-1 rounded-xl bg-subtle p-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { setTab(t.id); if (t.id === 'health') void loadProject(); }}
              className={
                'rounded-lg px-3 py-1.5 text-[13px] font-medium transition ' +
                (tab === t.id ? 'bg-white text-ink shadow-soft ring-1 ring-line' : 'text-ink-muted hover:text-ink')
              }
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ------------------------------------------------ Overview */}
        {tab === 'overview' && (
          <div className="mt-4">
            {loading ? (
              <p className="text-[13px] text-ink-muted">Loading domain intelligence…</p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-2xl bg-white p-4 ring-1 ring-line">
                    <div className="text-[12px] font-medium text-ink-muted">Authority Score</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className={'text-[24px] font-semibold tabular-nums tracking-tight ' + aTone.text}>{bl?.authorityScore ?? '—'}</span>
                      <span className="text-[11px] text-ink-faint">/ 100</span>
                    </div>
                    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-subtle">
                      <div className="h-full rounded-full" style={{ width: (bl?.authorityScore ?? 0) + '%', background: aTone.hex }} />
                    </div>
                  </div>
                  <StatTile label="Semrush Rank" value={ov?.rank != null ? '#' + fmtNum(ov.rank) : '—'} sub="global rank by organic traffic" href={SEM.overview(domain)} />
                  <StatTile label="Organic Traffic" value={fmtNum(ov?.organicTraffic)} sub={'est. visits / month · value ' + fmtMoney(ov?.organicCost)} href={SEM.organic(domain)} />
                  <StatTile label="Organic Keywords" value={fmtNum(ov?.organicKeywords)} sub="ranking in Google top 100" href={SEM.organic(domain)} />
                  <StatTile label="Backlinks" value={fmtNum(bl?.backlinksTotal)} sub={bl?.follows != null ? fmtNum(bl.follows) + ' follow · ' + fmtNum(bl.nofollows) + ' nofollow' : undefined} href={SEM.backlinks(domain)} />
                  <StatTile label="Referring Domains" value={fmtNum(bl?.refDomains)} sub={bl?.refIps != null ? fmtNum(bl.refIps) + ' referring IPs' : undefined} href={SEM.backlinks(domain)} />
                  <StatTile label="Paid Keywords" value={fmtNum(ov?.paidKeywords)} sub={ov?.paidTraffic != null ? fmtNum(ov.paidTraffic) + ' paid visits / mo' : 'no active ads detected'} />
                  <StatTile label="Paid Traffic Cost" value={fmtMoney(ov?.paidCost)} sub="est. monthly ad spend" />
                </div>
                <SectionNotice meta={bundle?.overviewMeta ?? { ok: false, source: 'none', reason: 'http', unitsSpent: 0 }} what="Domain overview" />
                {bundle?.backlinksMeta && !bundle.backlinksMeta.ok && bundle.overviewMeta.ok && (
                  <SectionNotice meta={bundle.backlinksMeta} what="Backlink metrics" />
                )}

                {kws.length > 0 && (
                  <div className="mt-4 rounded-2xl bg-subtle/60 p-4 ring-1 ring-line">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-[12px] font-medium text-ink-muted">Position distribution <span className="text-ink-faint">(top {kws.length} keywords by traffic)</span></div>
                      <a href={SEM.organic(domain)} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-accent hover:underline">Full report ↗</a>
                    </div>
                    <Distribution buckets={distBuckets} />
                  </div>
                )}

                <div className="mt-4 flex flex-wrap gap-3 text-[12px]">
                  <a href={'https://www.semrush.com/analytics/overview/?searchType=domain&q=' + encodeURIComponent(domain)} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">🤖 AI visibility (Semrush AI toolkit) ↗</a>
                  <a href={SEM.projects()} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">📊 Position tracking project ↗</a>
                </div>
              </>
            )}
          </div>
        )}

        {/* ------------------------------------------------ Top keywords */}
        {tab === 'keywords' && (
          <div className="mt-4">
            {loading ? (
              <p className="text-[13px] text-ink-muted">Loading rankings…</p>
            ) : kws.length === 0 ? (
              <SectionNotice meta={bundle?.topKeywordsMeta ?? { ok: false, source: 'none', reason: 'empty', unitsSpent: 0 }} what="Ranking keywords" />
            ) : (
              <div className="overflow-x-auto rounded-2xl ring-1 ring-line">
                <table className="w-full min-w-[640px] text-left text-[13px]">
                  <thead className="bg-subtle text-ink-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Keyword</th>
                      <th className="px-3 py-2 font-medium text-right">Pos</th>
                      <th className="px-3 py-2 font-medium text-right">Δ</th>
                      <th className="px-3 py-2 font-medium text-right">Volume</th>
                      <th className="px-3 py-2 font-medium text-right">KD</th>
                      <th className="px-3 py-2 font-medium text-right">Traffic %</th>
                      <th className="px-3 py-2 font-medium">URL</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {kws.map((k, i) => {
                      const d = deltaChip(k.positionDiff);
                      return (
                        <tr key={k.keyword + i} className="border-t border-line">
                          <td className="px-3 py-2 text-ink">
                            <a href={SEM.keyword(k.keyword)} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{k.keyword}</a>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <span className={'inline-block min-w-[28px] rounded-full px-1.5 py-0.5 text-center text-[12px] font-semibold tabular-nums ' + posTone(k.position)}>{k.position ?? '—'}</span>
                          </td>
                          <td className={'px-3 py-2 text-right text-[12px] font-medium tabular-nums ' + (d ? d.cls : 'text-ink-faint')}>{d ? d.label : '·'}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{fmtExact(k.volume)}</td>
                          <td className={'px-3 py-2 text-right tabular-nums font-medium ' + kdTone(k.difficulty)}>{k.difficulty ?? '—'}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{k.trafficPct != null ? k.trafficPct.toFixed(2) : '—'}</td>
                          <td className="max-w-[220px] truncate px-3 py-2 text-[12px] text-ink-faint" title={k.url}>{k.url.replace(/^https?:\/\/(www\.)?/, '')}</td>
                          <td className="px-3 py-2 text-right">
                            <button type="button" onClick={() => sendToDraft(k.keyword)} className="rounded-full px-2.5 py-1 text-[11px] font-medium text-accent ring-1 ring-accent/30 transition hover:bg-accent-soft">Draft</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {!loading && kws.length > 0 && (
              <p className="mt-2 text-[11px] text-ink-faint">Sorted by traffic contribution. Positions are Google US organic. Click a keyword for the full Semrush view.</p>
            )}
          </div>
        )}

        {/* ------------------------------------------------ Competitors */}
        {tab === 'competitors' && (
          <div className="mt-4">
            {loading ? (
              <p className="text-[13px] text-ink-muted">Loading competitors…</p>
            ) : (bundle?.competitors.length ?? 0) === 0 ? (
              <SectionNotice meta={bundle?.competitorsMeta ?? { ok: false, source: 'none', reason: 'empty', unitsSpent: 0 }} what="Organic competitors" />
            ) : (
              <>
                <div className="overflow-x-auto rounded-2xl ring-1 ring-line">
                  <table className="w-full min-w-[560px] text-left text-[13px]">
                    <thead className="bg-subtle text-ink-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">Competitor</th>
                        <th className="px-3 py-2 font-medium">Competition level</th>
                        <th className="px-3 py-2 font-medium text-right">Common keywords</th>
                        <th className="px-3 py-2 font-medium text-right">Their keywords</th>
                        <th className="px-3 py-2 font-medium text-right">Their traffic</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {bundle!.competitors.map((c, i) => (
                        <tr key={c.domain + i} className="border-t border-line">
                          <td className="px-3 py-2 font-medium text-ink">
                            <a href={SEM.overview(c.domain)} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{c.domain}</a>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-subtle">
                                <div className="h-full rounded-full bg-accent" style={{ width: Math.round((c.competitionLevel ?? 0) * 100) + '%' }} />
                              </div>
                              <span className="text-[11px] tabular-nums text-ink-muted">{c.competitionLevel != null ? Math.round(c.competitionLevel * 100) + '%' : '—'}</span>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{fmtExact(c.commonKeywords)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{fmtNum(c.organicKeywords)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{fmtNum(c.organicTraffic)}</td>
                          <td className="px-3 py-2 text-right">
                            <button type="button" onClick={() => { setDomainInput(c.domain); void loadDomain(c.domain); setTab('overview'); }} className="rounded-full px-2.5 py-1 text-[11px] font-medium text-accent ring-1 ring-accent/30 transition hover:bg-accent-soft">Inspect</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="mt-2 text-[11px] text-ink-faint">Competition level = share of keyword overlap with {domain}. “Inspect” loads that domain in this panel.</p>
              </>
            )}
          </div>
        )}

        {/* ------------------------------------------------ Backlinks */}
        {tab === 'backlinks' && (
          <div className="mt-4">
            {loading ? (
              <p className="text-[13px] text-ink-muted">Loading link profile…</p>
            ) : !bl ? (
              <SectionNotice meta={bundle?.backlinksMeta ?? { ok: false, source: 'none', reason: 'empty', unitsSpent: 0 }} what="Backlink metrics" />
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatTile label="Total Backlinks" value={fmtNum(bl.backlinksTotal)} href={SEM.backlinks(domain)} />
                  <StatTile label="Referring Domains" value={fmtNum(bl.refDomains)} href={SEM.backlinks(domain)} />
                  <StatTile label="Referring URLs" value={fmtNum(bl.refUrls)} />
                  <StatTile label="Referring IPs" value={fmtNum(bl.refIps)} />
                </div>
                {bl.follows != null && bl.nofollows != null && bl.follows + bl.nofollows > 0 && (
                  <div className="mt-4 rounded-2xl bg-subtle/60 p-4 ring-1 ring-line">
                    <div className="text-[12px] font-medium text-ink-muted">Link attributes</div>
                    <div className="mt-2 flex h-3 w-full overflow-hidden rounded-full bg-subtle" role="img" aria-label={'Follow ' + bl.follows + ', nofollow ' + bl.nofollows}>
                      <div style={{ width: (bl.follows / (bl.follows + bl.nofollows)) * 100 + '%', background: '#0071e3', marginRight: 2 }} />
                      <div style={{ width: (bl.nofollows / (bl.follows + bl.nofollows)) * 100 + '%', background: 'rgba(0,113,227,0.25)' }} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-muted">
                      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: '#0071e3' }} />Follow <span className="font-medium tabular-nums text-ink">{fmtNum(bl.follows)}</span></span>
                      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'rgba(0,113,227,0.25)' }} />Nofollow <span className="font-medium tabular-nums text-ink">{fmtNum(bl.nofollows)}</span></span>
                      {bl.texts != null && <span>Text links <span className="font-medium tabular-nums text-ink">{fmtNum(bl.texts)}</span></span>}
                      {bl.images != null && <span>Image links <span className="font-medium tabular-nums text-ink">{fmtNum(bl.images)}</span></span>}
                    </div>
                  </div>
                )}
                <p className="mt-3 text-[11px] text-ink-faint">Backlink quality drives Authority Score ({bl.authorityScore ?? '—'}/100). Earn links from relevant medical and health publications to raise it.</p>
              </>
            )}
          </div>
        )}

        {/* ------------------------------------------------ Site health */}
        {tab === 'health' && (
          <div className="mt-4">
            {projectLoading && <p className="text-[13px] text-ink-muted">Loading Site Audit &amp; Position Tracking…</p>}
            {!projectLoading && project && (
              <>
                {project.audit.configured && project.auditMeta.ok ? (
                  <div className="grid gap-3 lg:grid-cols-[auto_1fr]">
                    <div className="flex items-center justify-center rounded-2xl bg-subtle/60 p-4 ring-1 ring-line">
                      <Gauge value={project.audit.health} hex={healthTone(project.audit.health).hex} label="Site Health" />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <StatTile label="Errors" value={fmtExact(project.audit.errors)} sub="fix these first" />
                      <StatTile label="Warnings" value={fmtExact(project.audit.warnings)} />
                      <StatTile label="Notices" value={fmtExact(project.audit.notices)} />
                      <StatTile label="Pages crawled" value={fmtExact(project.audit.pagesCrawled)} />
                      <StatTile label="Healthy pages" value={fmtExact(project.audit.pagesHealthy)} />
                      <StatTile label="Pages with issues" value={fmtExact(project.audit.pagesWithIssues)} />
                    </div>
                  </div>
                ) : (
                  <SectionNotice
                    meta={project.auditMeta}
                    what={project.audit.configured ? 'Site Audit' : 'Site Audit (set SEMRUSH_PROJECT_ID in Vercel to connect your Semrush project)'}
                  />
                )}

                <div className="mt-4 rounded-2xl bg-subtle/60 p-4 ring-1 ring-line">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-[12px] font-medium text-ink-muted">Position Tracking visibility <span className="text-ink-faint">(last 30 days)</span></div>
                      <div className="mt-1 flex items-baseline gap-2">
                        <span className="text-[24px] font-semibold tabular-nums tracking-tight text-ink">
                          {project.tracking.visibility != null ? project.tracking.visibility.toFixed(2) + '%' : '—'}
                        </span>
                        {project.tracking.visibilityDelta != null && project.tracking.visibilityDelta !== 0 && (
                          <span className={'text-[12px] font-medium tabular-nums ' + (project.tracking.visibilityDelta > 0 ? 'text-emerald-600' : 'text-rose-600')}>
                            {(project.tracking.visibilityDelta > 0 ? '▲ ' : '▼ ') + Math.abs(project.tracking.visibilityDelta).toFixed(2)} pts
                          </span>
                        )}
                        {project.tracking.avgPosition != null && (
                          <span className="text-[12px] text-ink-muted">avg. position {project.tracking.avgPosition.toFixed(1)}</span>
                        )}
                      </div>
                    </div>
                    <Sparkline points={project.tracking.trend} />
                  </div>
                  {!project.trackingMeta.ok && (
                    <SectionNotice
                      meta={project.trackingMeta}
                      what={project.tracking.configured ? 'Position Tracking' : 'Position Tracking (set SEMRUSH_PROJECT_ID in Vercel to connect your campaign)'}
                    />
                  )}
                </div>

                {project.audit.lastAudit && (
                  <p className="mt-2 text-[11px] text-ink-faint">Last audit: {new Date(project.audit.lastAudit).toLocaleDateString()} · <a href={SEM.projects()} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">manage in Semrush ↗</a></p>
                )}
              </>
            )}
            {!projectLoading && !project && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-200">
                Could not reach the Site Audit / Position Tracking endpoint. Check the Semrush connection and try again.
              </p>
            )}
          </div>
        )}

        {/* ------------------------------------------------ Keyword research */}
        {tab === 'research' && (
          <div className="mt-4">
            <KeywordIntelligence embedded initialTopic={initialTopic} onUseTopic={onUseTopic} />
          </div>
        )}
      </div>
    </section>
  );
}
