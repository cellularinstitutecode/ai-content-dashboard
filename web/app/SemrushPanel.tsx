'use client';
// web/app/SemrushPanel.tsx
// Semrush Intelligence — the visual SEO command center. Modeled on the Semrush
// dashboard itself: an SEO overview band (Authority Score, traffic + keyword
// trend charts, backlinks, ref domains), a Position-Tracking-style block
// (visibility trend, Top 3/10/20/100 rings, top keywords), a Site Audit block
// (health gauge, errors/warnings, crawled-pages bar), and — because every AI
// draft in this app passes through the Semrush keyword filter automatically —
// a live "Automatic keyword research" feed proving research ran before each
// autonomous post.
//
// Data: /api/semrush?action=domain (overview/backlinks/keywords/competitors +
// daily snapshot history), action=project (Site Audit + Position Tracking),
// action=activity (draft keyword provenance). Everything is cache-first and
// unit-budget-guarded server-side; the panel degrades to link-outs when the
// key/plan is missing.
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import KeywordIntelligence from './KeywordIntelligence';
import { announce, onRefresh } from '@/components/refreshBus';
import { useWorkspace } from '@/components/workspace';

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

type SnapshotRow = {
  date: string;
  authorityScore: number | null;
  semrushRank: number | null;
  organicTraffic: number | null;
  organicKeywords: number | null;
  paidKeywords: number | null;
  backlinksTotal: number | null;
  refDomains: number | null;
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
  history: SnapshotRow[];
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

type ActivityRow = { topic: string; keyword: string; volume: number | null; difficulty: number | null; role: string; createdAt: string };

type MoverRow = {
  keyword: string;
  position: number | null;
  prevPosition: number | null;
  positionDiff: number | null;
  volume: number | null;
  difficulty: number | null;
  url: string;
};

type KeywordMovers = {
  newKeywords: MoverRow[];
  lostKeywords: MoverRow[];
  improved: MoverRow[];
  declined: MoverRow[];
  meta: SectionMeta;
};

type AdvicePriority = {
  rank: number;
  category: string;
  title: string;
  why: string;
  action: string;
  impact: string;
  effort: string;
  keywords: string[];
  draftPrompt: string;
};

type AdvicePlan = { summary: string; priorities: AdvicePriority[] };

type Tab = 'overview' | 'rankings' | 'keywords' | 'competitors' | 'backlinks' | 'research';

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

function fmtDateShort(iso: string): string {
  try {
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function timeAgo(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    return d + 'd ago';
  } catch {
    return '';
  }
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

function healthHex(h: number | null): string {
  if (h == null) return '#a1a1a6';
  if (h >= 90) return '#34c759';
  if (h >= 70) return '#ff9f0a';
  return '#ff3b30';
}

function ascoreHex(a: number | null): string {
  if (a == null) return '#a1a1a6';
  if (a >= 60) return '#34c759';
  if (a >= 30) return '#0071e3';
  return '#ff9f0a';
}

// Percent change between the first and last non-null values of a series.
function pctChange(vals: (number | null)[]): number | null {
  const v = vals.filter((x): x is number => x != null);
  if (v.length < 2 || v[0] === 0) return null;
  return ((v[v.length - 1] - v[0]) / Math.abs(v[0])) * 100;
}

function DeltaText({ pct, suffix = '%' }: { pct: number | null; suffix?: string }) {
  if (pct == null || Math.abs(pct) < 0.005) return null;
  const up = pct > 0;
  return (
    <span className={'text-[12px] font-semibold tabular-nums ' + (up ? 'text-emerald-600' : 'text-rose-600')}>
      {(up ? '+' : '') + pct.toFixed(Math.abs(pct) < 10 ? 2 : 1) + suffix}
    </span>
  );
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
// Chart primitives (SVG, single-series, hover tooltips, recessive grid)
// ---------------------------------------------------------------------------

const CHART = {
  trend: '#6366f1', // indigo trend line (Semrush-style periwinkle)
  trendFill: 'rgba(99,102,241,0.14)',
  up: '#34c759',
  upFill: 'rgba(52,199,89,0.14)',
  down: '#ff3b30',
  downFill: 'rgba(255,59,48,0.12)',
  grid: 'rgba(0,0,0,0.05)',
};

type Pt = { date: string; value: number };

function useMeasuredWidth(): [RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setW(el.clientWidth);
    update();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (ro) ro.observe(el);
    else window.addEventListener('resize', update);
    return () => {
      if (ro) ro.disconnect();
      else window.removeEventListener('resize', update);
    };
  }, []);
  return [ref, w];
}

// Area trend chart with gradient fill + crosshair hover tooltip.
function AreaChart({
  points,
  height = 88,
  color = CHART.trend,
  fill = CHART.trendFill,
  label,
  formatValue = fmtNum,
  emptyNote = 'Trend history builds automatically — check back tomorrow.',
}: {
  points: Pt[];
  height?: number;
  color?: string;
  fill?: string;
  label: string;
  formatValue?: (v: number) => string;
  emptyNote?: string;
}) {
  const [wrapRef, width] = useMeasuredWidth();
  const [hover, setHover] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <div ref={wrapRef} className="flex items-center justify-center rounded-xl bg-subtle/70" style={{ height }}>
        <span className="px-3 text-center text-[11px] text-ink-faint">{emptyNote}</span>
      </div>
    );
  }

  const pad = { l: 6, r: 6, t: 10, b: 6 };
  const w = Math.max(width, 80);
  const min = Math.min(...points.map((p) => p.value));
  const max = Math.max(...points.map((p) => p.value));
  const span = max - min || Math.abs(max) * 0.1 || 1;
  const x = (i: number) => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (height - pad.t - pad.b);
  const line = points.map((p, i) => (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
  const area = line + ' L' + x(points.length - 1).toFixed(1) + ' ' + (height - pad.b) + ' L' + x(0).toFixed(1) + ' ' + (height - pad.b) + ' Z';
  const hv = hover != null ? points[hover] : null;

  return (
    <div ref={wrapRef} className="relative" style={{ height }}>
      {width > 0 && (
        <svg
          width={w}
          height={height}
          role="img"
          aria-label={label + ', ' + points.length + ' data points from ' + points[0].date + ' to ' + points[points.length - 1].date}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const rel = (e.clientX - rect.left - pad.l) / (w - pad.l - pad.r);
            setHover(Math.round(Math.max(0, Math.min(1, rel)) * (points.length - 1)));
          }}
          onMouseLeave={() => setHover(null)}
        >
          {/* recessive grid: 3 light horizontal lines */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={pad.l} x2={w - pad.r} y1={pad.t + f * (height - pad.t - pad.b)} y2={pad.t + f * (height - pad.t - pad.b)} stroke={CHART.grid} strokeWidth="1" />
          ))}
          <path d={area} fill={fill} />
          <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          {hv && (
            <>
              <line x1={x(hover!)} x2={x(hover!)} y1={pad.t} y2={height - pad.b} stroke="rgba(0,0,0,0.18)" strokeWidth="1" />
              <circle cx={x(hover!)} cy={y(hv.value)} r="4" fill={color} stroke="#fff" strokeWidth="2" />
            </>
          )}
        </svg>
      )}
      {hv && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1.5 text-center shadow-pop"
          style={{ left: Math.max(44, Math.min(w - 44, x(hover!))), top: -6 }}
        >
          <div className="text-[11px] font-semibold tabular-nums text-white">{formatValue(hv.value)}</div>
          <div className="text-[10px] text-white/70">{fmtDateShort(hv.date)}</div>
        </div>
      )}
    </div>
  );
}

// Donut ring with the count in the middle (Semrush "Top N" style).
function RingStat({ count, total, label, sub, color = '#34c759' }: { count: number; total: number; label: string; sub?: string; color?: string }) {
  const r = 24;
  const c = 2 * Math.PI * r;
  const frac = total > 0 ? Math.max(0.02, Math.min(1, count / total)) : 0;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="relative">
        <svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={label + ': ' + count + ' of ' + total}>
          <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth="6" />
          {count > 0 && (
            <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} transform="rotate(-90 32 32)" />
          )}
          <text x="32" y="37" textAnchor="middle" style={{ font: '600 16px -apple-system, BlinkMacSystemFont, sans-serif', fill: '#1d1d1f' }}>
            {count}
          </text>
        </svg>
      </div>
      <div className="text-[11px] font-medium text-ink-muted">{label}</div>
      {sub && <div className="-mt-1 text-[10px] text-ink-faint">{sub}</div>}
    </div>
  );
}

// Donut gauge (0..100) with % in the center.
function Gauge({ value, label, size = 132 }: { value: number | null; label: string; size?: number }) {
  const r = size * 0.35;
  const c = 2 * Math.PI * r;
  const pct = value != null ? Math.max(0, Math.min(100, value)) : 0;
  const hex = healthHex(value);
  const half = size / 2;
  return (
    <svg width={size} height={size} viewBox={'0 0 ' + size + ' ' + size} role="img" aria-label={label + ': ' + (value != null ? Math.round(value) + '%' : 'no data')}>
      <circle cx={half} cy={half} r={r} fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth={size * 0.085} />
      <circle
        cx={half} cy={half} r={r} fill="none"
        stroke={value != null ? hex : 'rgba(0,0,0,0.07)'}
        strokeWidth={size * 0.085} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)}
        transform={'rotate(-90 ' + half + ' ' + half + ')'}
      />
      <text x={half} y={half - 2} textAnchor="middle" style={{ font: '600 ' + Math.round(size * 0.2) + 'px -apple-system, BlinkMacSystemFont, sans-serif', fill: '#1d1d1f' }}>
        {value != null ? Math.round(value) + '%' : '—'}
      </text>
      <text x={half} y={half + size * 0.13} textAnchor="middle" style={{ font: '400 ' + Math.round(size * 0.085) + 'px -apple-system, BlinkMacSystemFont, sans-serif', fill: '#6e6e73' }}>
        {label}
      </text>
    </svg>
  );
}

// Segmented horizontal bar with 2px gaps + labeled legend (never color-alone).
function SegmentBar({ segments, ariaLabel }: { segments: { label: string; count: number; color: string }[]; ariaLabel: string }) {
  const total = segments.reduce((s, b) => s + b.count, 0);
  if (!total) return null;
  return (
    <div>
      <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-subtle" role="img" aria-label={ariaLabel}>
        {segments.map((s, i) =>
          s.count > 0 ? (
            <div key={s.label} style={{ width: (s.count / total) * 100 + '%', background: s.color, marginRight: i < segments.length - 1 ? 2 : 0 }} />
          ) : null
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
            <span aria-hidden className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} />
            {s.label} <span className="font-semibold tabular-nums text-ink">{fmtExact(s.count)}</span>
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

// Card shell shared by the dashboard blocks (Semrush-dashboard look).
function Card({ tag, title, right, children, className = '' }: { tag?: string; title?: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={'rounded-2xl bg-white p-5 ring-1 ring-line shadow-soft ' + className}>
      {(tag || title || right) && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            {tag && <span className="rounded-lg bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent">{tag}</span>}
            {title && <span className="text-[13px] font-semibold text-ink">{title}</span>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
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
  const workspace = useWorkspace();
  const [tab, setTab] = useState<Tab>('overview');
  const [domainInput, setDomainInput] = useState('');
  const [projectLoading, setProjectLoading] = useState(true);
  const [bundle, setBundle] = useState<DomainBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [project, setProject] = useState<ProjectData | null>(null);
  const [activity, setActivity] = useState<ActivityRow[] | null>(null);
  const [movers, setMovers] = useState<KeywordMovers | null>(null);
  const [moversLoading, setMoversLoading] = useState(false);
  const [advice, setAdvice] = useState<AdvicePlan | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [adviceErr, setAdviceErr] = useState('');
  const moversFor = useRef<string | null>(null);

  async function loadDomain(domain?: string) {
    setLoading(true);
    try {
      const q = domain ? '&domain=' + encodeURIComponent(domain) : '';
      const r = await fetch('/api/semrush?action=domain' + q);
      const j = (await r.json().catch(() => null)) as DomainBundle | null;
      setBundle(j);
      if (j && !domainInput) setDomainInput(j.domain);
      // Reset per-domain sections when switching domains.
      if (j && moversFor.current && moversFor.current !== j.domain) {
        moversFor.current = null;
        setMovers(null);
        setAdvice(null);
        setAdviceErr('');
      }
    } catch {
      setBundle(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadMovers(d: string) {
    if (moversFor.current === d) return;
    moversFor.current = d;
    setMoversLoading(true);
    try {
      const r = await fetch('/api/semrush?action=movers&domain=' + encodeURIComponent(d));
      setMovers((await r.json().catch(() => null)) as KeywordMovers | null);
    } catch {
      setMovers(null);
    } finally {
      setMoversLoading(false);
    }
  }

  async function loadAdvice(d: string) {
    if (adviceLoading) return;
    setAdviceLoading(true);
    setAdviceErr('');
    try {
      const r = await fetch('/api/semrush?action=advise&domain=' + encodeURIComponent(d));
      const j = await r.json().catch(() => null);
      if (!r.ok || !j?.ok) throw new Error(j?.error === 'rate_limited' ? 'Rate limit reached — try again in a few minutes.' : j?.error || 'Advisor failed');
      setAdvice(j.plan as AdvicePlan);
      announce('semrush'); // the advisor spends units — refresh the balance chip
    } catch (e: any) {
      setAdviceErr(e?.message || 'Advisor failed');
    } finally {
      setAdviceLoading(false);
    }
  }

  // Everything loads on mount: the overview IS the dashboard.
  useEffect(() => {
    void loadDomain();
    (async () => {
      try {
        const r = await fetch('/api/semrush?action=project');
        setProject((await r.json().catch(() => null)) as ProjectData | null);
      } catch { setProject(null); }
      finally { setProjectLoading(false); }
    })();
    (async () => {
      try {
        const r = await fetch('/api/semrush?action=activity');
        const j = await r.json().catch(() => null);
        setActivity(j && Array.isArray(j.rows) ? j.rows : []);
      } catch { setActivity([]); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Interconnection: when another panel spends Semrush units or the Autopilot
  // engine finishes a research pass, the domain bundle here is re-read so the
  // numbers on this page match the rest of the dashboard.
  useEffect(() => onRefresh((scopes) => {
    if (scopes.includes('semrush')) void loadDomain();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // Keep the shared workspace pointed at the domain under analysis.
  useEffect(() => {
    const d = bundle?.domain;
    if (d && d !== workspace.domain) workspace.setDomain(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle?.domain]);

  const domain = bundle?.domain || domainInput || 'cellularhopeinstitute.com';
  const anyLive = bundle != null && (bundle.overviewMeta.ok || bundle.backlinksMeta.ok || bundle.topKeywordsMeta.ok);
  const fromCache = bundle != null && [bundle.overviewMeta, bundle.backlinksMeta, bundle.topKeywordsMeta].some((m) => m.source === 'cache');

  const statusChip = loading
    ? { cls: 'bg-subtle text-ink-muted', label: 'Loading…' }
    : anyLive
    ? fromCache
      ? { cls: 'bg-sky-100 text-sky-700', label: 'Semrush data · cached' }
      : { cls: 'bg-emerald-100 text-emerald-700', label: 'Semrush data · live' }
    : { cls: 'bg-amber-100 text-amber-700', label: 'Not connected · link-out only' };

  const ov = bundle?.overview ?? null;
  const bl = bundle?.backlinks ?? null;
  const kws = useMemo(() => bundle?.topKeywords ?? [], [bundle]);
  const history = useMemo(() => bundle?.history ?? [], [bundle]);

  const trafficPts: Pt[] = useMemo(() => history.filter((h) => h.organicTraffic != null).map((h) => ({ date: h.date, value: h.organicTraffic as number })), [history]);
  const kwPts: Pt[] = useMemo(() => history.filter((h) => h.organicKeywords != null).map((h) => ({ date: h.date, value: h.organicKeywords as number })), [history]);
  const blPts: Pt[] = useMemo(() => history.filter((h) => h.backlinksTotal != null).map((h) => ({ date: h.date, value: h.backlinksTotal as number })), [history]);
  const trafficDelta = pctChange(trafficPts.map((p) => p.value));
  const kwDelta = pctChange(kwPts.map((p) => p.value));
  const blDelta = pctChange(blPts.map((p) => p.value));

  const dist = useMemo(() => {
    const b = { top3: 0, top10: 0, top20: 0, top100: 0 };
    for (const k of kws) {
      const p = k.position;
      if (p == null) continue;
      if (p <= 3) b.top3++;
      if (p <= 10) b.top10++;
      if (p <= 20) b.top20++;
      b.top100++;
    }
    return b;
  }, [kws]);

  const tracking = project?.tracking ?? null;
  const audit = project?.audit ?? null;
  const visPts: Pt[] = useMemo(
    () => (tracking?.trend ?? []).filter((t) => t.visibility != null).map((t) => ({ date: t.date, value: t.visibility as number })),
    [tracking]
  );
  const visFalling = (tracking?.visibilityDelta ?? 0) < 0;

  function sendToDraft(text: string) {
    // Publish to the shared workspace as well as the direct prop, so panels
    // that aren't children of this one (Image Studio, calendar, templates)
    // pick up the same topic.
    workspace.setTopic(text, { keyword: text, source: 'semrush' });
    if (onUseTopic) onUseTopic(text);
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Dashboard' },
    { id: 'rankings', label: 'Ranking assistant' },
    { id: 'keywords', label: 'Top keywords' },
    { id: 'competitors', label: 'Competitors' },
    { id: 'backlinks', label: 'Backlinks' },
    { id: 'research', label: 'Keyword research' },
  ];

  // Quick wins: page-1-cusp and page-2 keywords (positions 4-20) worth pushing
  // into the top 3 — the highest-leverage ranking work.
  const quickWins = useMemo(() => {
    const score = (k: OrganicKeywordRow) => Math.pow(k.volume ?? 0, 0.7) * ((100 - Math.min(k.difficulty ?? 50, 95)) / 100) * ((21 - (k.position ?? 21)) / 20 + 0.5);
    return kws
      .filter((k) => k.position != null && k.position >= 4 && k.position <= 20 && (k.volume ?? 0) > 0)
      .sort((a, b) => score(b) - score(a))
      .slice(0, 8);
  }, [kws]);

  const intentBreakdown = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const k of kws) for (const i of k.intents) counts[i] = (counts[i] || 0) + 1;
    const palette: Record<string, string> = { informational: '#0ea5e9', commercial: '#8b5cf6', transactional: '#10b981', navigational: '#94a3b8' };
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({ label, count, color: palette[label] || '#a1a1a6' }));
  }, [kws]);

  const kdBreakdown = useMemo(() => {
    const b = [
      { label: 'Easy (KD < 30)', count: 0, color: '#34c759' },
      { label: 'Possible (30-49)', count: 0, color: '#ffcc00' },
      { label: 'Hard (50-69)', count: 0, color: '#ff9f0a' },
      { label: 'Very hard (70+)', count: 0, color: '#ff3b30' },
    ];
    for (const k of kws) {
      const d = k.difficulty;
      if (d == null) continue;
      if (d < 30) b[0].count++;
      else if (d < 50) b[1].count++;
      else if (d < 70) b[2].count++;
      else b[3].count++;
    }
    return b.filter((x) => x.count > 0);
  }, [kws]);

  return (
    <section className="overflow-hidden rounded-3xl bg-canvas ring-1 ring-line shadow-soft">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white px-6 py-4">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-[18px] text-accent">📈</span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[16px] font-semibold text-ink">Semrush Intelligence</h3>
              <span className={'rounded-full px-2 py-0.5 text-[11px] font-medium ' + statusChip.cls}>{statusChip.label}</span>
              {bundle?.balance != null && (
                <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] tabular-nums text-ink-muted" title="Semrush API units remaining">
                  ⚡ {bundle.balance.toLocaleString()} units
                </span>
              )}
            </div>
            <p className="text-[12px] text-ink-muted">
              Every AI draft passes through this data automatically — keyword research runs before a single word is written.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <a href={SEM.overview(domain)} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-accent hover:text-accent-hover">Open in Semrush ↗</a>
        </div>
      </div>

      <div className="p-5 sm:p-6">
        {/* Domain row + tabs */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 gap-2">
            <input
              aria-label="Domain to analyse"
              type="text"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void loadDomain(domainInput); }}
              placeholder="cellularhopeinstitute.com — or any competitor domain"
              className="w-full max-w-md rounded-xl bg-white px-3.5 py-2 text-[13px] text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
            <button
              type="button"
              onClick={() => void loadDomain(domainInput)}
              disabled={loading}
              className="shrink-0 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white transition hover:bg-accent-hover disabled:opacity-50"
            >
              {loading ? 'Analyzing…' : 'Analyze'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1 rounded-xl bg-white p-1 ring-1 ring-line">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => { setTab(t.id); if (t.id === 'rankings') void loadMovers(domain); }}
                className={
                  'rounded-lg px-3 py-1.5 text-[13px] font-medium transition ' +
                  (tab === t.id ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:text-ink')
                }
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {bundle && !bundle.isPrimaryDomain && (
          <p className="mt-2 text-[12px] text-ink-muted">
            Viewing <span className="font-medium text-ink">{bundle.domain}</span> ·{' '}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => { setDomainInput(''); void loadDomain(); }}>
              back to your domain
            </button>
          </p>
        )}
        {!loading && bundle && !anyLive && <SectionNotice meta={bundle.overviewMeta} what="Domain intelligence" />}

        {/* ============================================== DASHBOARD */}
        {tab === 'overview' && (
          <div className="mt-4 space-y-4">
            {/* --- SEO overview band --- */}
            <Card
              tag="SEO"
              title={domain}
              right={
                <span className="text-[11px] text-ink-faint">
                  Root domain · US database{history.length > 0 ? ' · history since ' + fmtDateShort(history[0].date) : ''}
                </span>
              }
            >
              {loading ? (
                <p className="text-[13px] text-ink-muted">Loading domain intelligence…</p>
              ) : (
                <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
                  {/* Authority Score */}
                  <div>
                    <div className="text-[12px] font-medium text-ink-muted">Authority Score</div>
                    <div className="mt-1 flex items-baseline gap-1.5">
                      <span className="text-[28px] font-semibold tabular-nums tracking-tight text-ink">{bl?.authorityScore ?? '—'}</span>
                      <span className="text-[11px] text-ink-faint">/ 100</span>
                    </div>
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-subtle">
                      <div className="h-full rounded-full" style={{ width: (bl?.authorityScore ?? 0) + '%', background: ascoreHex(bl?.authorityScore ?? null) }} />
                    </div>
                    <div className="mt-1.5 text-[11px] text-ink-faint">Semrush Rank {ov?.rank != null ? '#' + fmtNum(ov.rank) : '—'}</div>
                  </div>
                  {/* Organic traffic + trend */}
                  <div>
                    <div className="text-[12px] font-medium text-ink-muted">Organic Traffic</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-[28px] font-semibold tabular-nums tracking-tight text-ink">{fmtNum(ov?.organicTraffic)}</span>
                      <DeltaText pct={trafficDelta} />
                    </div>
                    <div className="mt-2">
                      <AreaChart points={trafficPts} height={56} label="Organic traffic trend" />
                    </div>
                  </div>
                  {/* Organic keywords + trend */}
                  <div>
                    <div className="text-[12px] font-medium text-ink-muted">Organic Keywords</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-[28px] font-semibold tabular-nums tracking-tight text-ink">{fmtNum(ov?.organicKeywords)}</span>
                      <DeltaText pct={kwDelta} />
                    </div>
                    <div className="mt-2">
                      <AreaChart points={kwPts} height={56} label="Organic keywords trend" />
                    </div>
                  </div>
                  {/* Backlinks / ref domains / paid */}
                  <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                    <div>
                      <div className="text-[12px] font-medium text-ink-muted">Ref. Domains</div>
                      <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{fmtNum(bl?.refDomains)}</div>
                    </div>
                    <div>
                      <div className="flex items-center gap-1 text-[12px] font-medium text-ink-muted">Backlinks</div>
                      <div className="mt-0.5 flex items-baseline gap-1.5">
                        <span className="text-[20px] font-semibold tabular-nums text-ink">{fmtNum(bl?.backlinksTotal)}</span>
                        <DeltaText pct={blDelta} />
                      </div>
                    </div>
                    <div>
                      <div className="text-[12px] font-medium text-ink-muted">Paid Keywords</div>
                      <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{fmtNum(ov?.paidKeywords)}</div>
                    </div>
                    <div>
                      <div className="text-[12px] font-medium text-ink-muted">Traffic Value</div>
                      <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{fmtMoney(ov?.organicCost)}</div>
                    </div>
                  </div>
                </div>
              )}
              {!loading && bundle && bundle.overviewMeta.ok && !bundle.backlinksMeta.ok && <SectionNotice meta={bundle.backlinksMeta} what="Backlink metrics" />}
            </Card>

            {/* --- Position tracking + Site audit row --- */}
            <div className="grid gap-4 lg:grid-cols-5">
              {/* Position tracking */}
              <Card
                tag="Position Tracking"
                title="United States (Google) · English"
                className="lg:col-span-3"
                right={<a href={SEM.organic(domain)} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-accent hover:underline">View full report ↗</a>}
              >
                <div className="grid gap-5 sm:grid-cols-[1fr_auto]">
                  <div>
                    <div className="text-[12px] font-medium text-ink-muted">Visibility</div>
                    <div className="mt-1 flex items-baseline gap-2">
                      <span className="text-[28px] font-semibold tabular-nums tracking-tight text-ink">
                        {tracking?.visibility != null ? tracking.visibility.toFixed(2) + '%' : '—'}
                      </span>
                      {tracking?.visibilityDelta != null && tracking.visibilityDelta !== 0 && (
                        <span className={'text-[12px] font-semibold tabular-nums ' + (visFalling ? 'text-rose-600' : 'text-emerald-600')}>
                          {(visFalling ? '' : '+') + tracking.visibilityDelta.toFixed(2)} pts
                        </span>
                      )}
                      {tracking?.avgPosition != null && <span className="text-[12px] text-ink-muted">avg. pos {tracking.avgPosition.toFixed(1)}</span>}
                    </div>
                    <div className="mt-2">
                      <AreaChart
                        points={visPts}
                        height={104}
                        color={visFalling ? CHART.down : CHART.up}
                        fill={visFalling ? CHART.downFill : CHART.upFill}
                        label="Position tracking visibility, last 30 days"
                        formatValue={(v) => v.toFixed(2) + '%'}
                        emptyNote={
                          projectLoading
                            // While the project request is still in flight this
                            // used to claim the integration was unconfigured.
                            ? 'Loading tracked positions…'
                            : tracking?.configured
                            ? 'No tracking history yet — data appears after the campaign collects positions.'
                            : 'Connect your Semrush project (SEMRUSH_PROJECT_ID in Vercel) to chart tracked visibility.'
                        }
                      />
                    </div>
                  </div>
                  <div className="flex flex-row items-center justify-center gap-4 sm:flex-col sm:gap-3 lg:flex-row">
                    <RingStat count={dist.top3} total={kws.length || 1} label="Top 3" color="#34c759" />
                    <RingStat count={dist.top10} total={kws.length || 1} label="Top 10" color="#30b0c7" />
                    <RingStat count={dist.top20} total={kws.length || 1} label="Top 20" color="#6366f1" />
                    <RingStat count={dist.top100} total={kws.length || 1} label="Top 100" color="#a1a1a6" />
                  </div>
                </div>
                {/* Top keywords mini table */}
                {kws.length > 0 && (
                  <div className="mt-4 overflow-hidden rounded-xl ring-1 ring-line">
                    <table className="w-full text-left text-[12px]">
                      <thead className="bg-subtle text-ink-muted">
                        <tr>
                          <th className="px-3 py-1.5 font-medium">Top Keywords</th>
                          <th className="px-3 py-1.5 text-right font-medium">Position</th>
                          <th className="px-3 py-1.5 text-right font-medium">Volume</th>
                          <th className="px-3 py-1.5 text-right font-medium">Traffic %</th>
                          <th className="px-3 py-1.5" />
                        </tr>
                      </thead>
                      <tbody>
                        {kws.slice(0, 6).map((k, i) => (
                          <tr key={k.keyword + i} className="border-t border-line">
                            <td className="max-w-[220px] truncate px-3 py-1.5 text-ink" title={k.keyword}>
                              <a href={SEM.keyword(k.keyword)} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{k.keyword}</a>
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              <span className={'inline-block min-w-[24px] rounded-full px-1.5 py-0.5 text-center text-[11px] font-semibold tabular-nums ' + posTone(k.position)}>{k.position ?? '—'}</span>
                            </td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{fmtExact(k.volume)}</td>
                            <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{k.trafficPct != null ? k.trafficPct.toFixed(2) : '—'}</td>
                            <td className="px-3 py-1.5 text-right">
                              <button type="button" onClick={() => sendToDraft(k.keyword)} className="rounded-full px-2 py-0.5 text-[11px] font-medium text-accent ring-1 ring-accent/30 transition hover:bg-accent-soft">Draft</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {project && !project.trackingMeta.ok && tracking?.configured && <SectionNotice meta={project.trackingMeta} what="Position Tracking" />}
              </Card>

              {/* Site audit */}
              <Card
                tag="Site Audit"
                title={audit?.lastAudit ? 'Updated ' + new Date(audit.lastAudit).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : undefined}
                className="lg:col-span-2"
                right={<a href={SEM.projects()} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-accent hover:underline">View full report ↗</a>}
              >
                {audit && audit.configured && project?.auditMeta.ok ? (
                  <>
                    <div className="flex items-center gap-5">
                      <Gauge value={audit.health} label="Site Health" />
                      <div className="grid flex-1 grid-cols-2 gap-3">
                        <div>
                          <div className="text-[12px] font-medium text-ink-muted">Errors</div>
                          <div className="mt-0.5 text-[26px] font-semibold tabular-nums text-rose-600">{fmtExact(audit.errors)}</div>
                        </div>
                        <div>
                          <div className="text-[12px] font-medium text-ink-muted">Warnings</div>
                          <div className="mt-0.5 text-[26px] font-semibold tabular-nums text-amber-600">{fmtExact(audit.warnings)}</div>
                        </div>
                        <div>
                          <div className="text-[12px] font-medium text-ink-muted">Notices</div>
                          <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{fmtExact(audit.notices)}</div>
                        </div>
                        <div>
                          <div className="text-[12px] font-medium text-ink-muted">Crawled Pages</div>
                          <div className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{fmtExact(audit.pagesCrawled)}</div>
                        </div>
                      </div>
                    </div>
                    {audit.pagesCrawled != null && audit.pagesHealthy != null && audit.pagesWithIssues != null && (
                      <div className="mt-4">
                        <SegmentBar
                          ariaLabel={'Crawled pages: ' + audit.pagesHealthy + ' healthy, ' + audit.pagesWithIssues + ' with issues'}
                          segments={[
                            { label: 'Healthy', count: audit.pagesHealthy, color: '#34c759' },
                            { label: 'With issues', count: audit.pagesWithIssues, color: '#ff9f0a' },
                            { label: 'Other', count: Math.max(0, audit.pagesCrawled - audit.pagesHealthy - audit.pagesWithIssues), color: 'rgba(0,0,0,0.12)' },
                          ]}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 text-center">
                    <Gauge value={null} label="Site Health" />
                    <p className="max-w-[260px] text-[12px] text-ink-muted">
                      {audit?.configured
                        ? 'Site Audit data is unavailable right now' + (project?.auditMeta.note ? ' (' + project.auditMeta.note + ')' : '') + '.'
                        : 'Set SEMRUSH_PROJECT_ID in Vercel to pull your Site Audit score, errors and warnings here.'}
                    </p>
                  </div>
                )}
              </Card>
            </div>

            {/* --- Automatic AI keyword research band --- */}
            <Card
              tag="AI × Semrush"
              title="Automatic keyword research"
              right={<span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">✓ Active on every draft</span>}
            >
              <p className="text-[12px] leading-relaxed text-ink-muted">
                Before the AI writes anything — dashboard generator, chat assistant, guided wizard or research copilot — it runs a Semrush
                Keyword Brief on the topic (primary keyword, supporting terms, real searcher questions, intent) and writes to that contract.
                Each draft is stamped with the research that shaped it, so autonomous posts only ever need your final confirmation.
              </p>
              {activity == null ? (
                <p className="mt-3 text-[12px] text-ink-faint">Loading research activity…</p>
              ) : activity.length === 0 ? (
                <p className="mt-3 rounded-xl bg-subtle px-3 py-2.5 text-[12px] text-ink-muted">
                  No stamped drafts yet — generate your first draft and the research record will appear here.
                </p>
              ) : (
                <div className="mt-3 overflow-hidden rounded-xl ring-1 ring-line">
                  <table className="w-full text-left text-[12px]">
                    <thead className="bg-subtle text-ink-muted">
                      <tr>
                        <th className="px-3 py-1.5 font-medium">Draft topic</th>
                        <th className="px-3 py-1.5 font-medium">Primary keyword applied</th>
                        <th className="px-3 py-1.5 text-right font-medium">Volume</th>
                        <th className="px-3 py-1.5 text-right font-medium">KD</th>
                        <th className="px-3 py-1.5 text-right font-medium">When</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activity.slice(0, 8).map((a, i) => (
                        <tr key={a.topic + a.createdAt + i} className="border-t border-line">
                          <td className="max-w-[260px] truncate px-3 py-1.5 text-ink" title={a.topic}>{a.topic}</td>
                          <td className="px-3 py-1.5">
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-800 ring-1 ring-emerald-200">
                              🔑 {a.keyword}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-ink-muted">{fmtExact(a.volume)}</td>
                          <td className={'px-3 py-1.5 text-right tabular-nums font-medium ' + kdTone(a.difficulty)}>{a.difficulty ?? '—'}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-ink-faint">{timeAgo(a.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-3 text-[12px]">
                <a href={SEM.overview(domain)} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">🤖 AI visibility (Semrush AI toolkit) ↗</a>
                <a href={SEM.projects()} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">📊 Manage Semrush project ↗</a>
              </div>
            </Card>
          </div>
        )}

        {/* ============================================== RANKING ASSISTANT */}
        {tab === 'rankings' && (
          <div className="mt-4 space-y-4">
            {/* Movement metrics */}
            <Card
              tag="Ranking Movement"
              title="Recent position changes"
              right={<span className="text-[11px] text-ink-faint">Top movers by volume · Google US</span>}
            >
              {moversLoading ? (
                <p className="text-[13px] text-ink-muted">Loading ranking changes…</p>
              ) : !movers || !movers.meta.ok ? (
                <SectionNotice meta={movers?.meta ?? { ok: false, source: 'none', reason: 'http', unitsSpent: 0 }} what="Ranking movement" />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    { label: 'Improved', rows: movers.improved, color: 'text-emerald-600', chip: 'bg-emerald-50 ring-emerald-200 text-emerald-800', sign: '▲' },
                    { label: 'Declined', rows: movers.declined, color: 'text-rose-600', chip: 'bg-rose-50 ring-rose-200 text-rose-800', sign: '▼' },
                    { label: 'New rankings', rows: movers.newKeywords, color: 'text-sky-600', chip: 'bg-sky-50 ring-sky-200 text-sky-800', sign: '＋' },
                    { label: 'Lost rankings', rows: movers.lostKeywords, color: 'text-ink-muted', chip: 'bg-subtle ring-line text-ink-muted', sign: '−' },
                  ].map((g) => (
                    <div key={g.label} className="rounded-xl bg-subtle/60 p-3.5 ring-1 ring-line">
                      <div className="flex items-baseline justify-between">
                        <span className="text-[12px] font-medium text-ink-muted">{g.label}</span>
                        <span className={'text-[20px] font-semibold tabular-nums ' + g.color}>{g.rows.length}</span>
                      </div>
                      <div className="mt-2 space-y-1">
                        {g.rows.length === 0 && <div className="text-[11px] text-ink-faint">None detected</div>}
                        {g.rows.slice(0, 4).map((m, mi) => (
                          <div key={m.keyword + mi} className={'flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[11px] ring-1 ' + g.chip}>
                            <span className="truncate" title={m.keyword}>{m.keyword}</span>
                            <span className="shrink-0 tabular-nums font-semibold">
                              {g.sign} {m.position != null ? '#' + m.position : ''}{m.positionDiff != null && m.positionDiff !== 0 ? ' (' + (m.positionDiff > 0 ? '+' : '') + m.positionDiff + ')' : ''}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Quick wins */}
            <Card
              tag="Quick Wins"
              title="Positions 4–20 — closest to the top 3"
              right={<span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-700">Highest leverage</span>}
            >
              {loading ? (
                <p className="text-[13px] text-ink-muted">Loading…</p>
              ) : quickWins.length === 0 ? (
                <p className="text-[13px] text-ink-muted">No page-1-cusp keywords found in the current sample{kws.length ? ' — everything is either top 3 or beyond position 20' : ''}.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl ring-1 ring-line">
                  <table className="w-full min-w-[640px] text-left text-[13px]">
                    <thead className="bg-subtle text-ink-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">Keyword</th>
                        <th className="px-3 py-2 text-right font-medium">Pos</th>
                        <th className="px-3 py-2 text-right font-medium">Volume</th>
                        <th className="px-3 py-2 text-right font-medium">KD</th>
                        <th className="px-3 py-2 font-medium">Ranking URL</th>
                        <th className="px-3 py-2 text-right font-medium">Assist</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quickWins.map((k, i) => (
                        <tr key={k.keyword + i} className="border-t border-line">
                          <td className="px-3 py-2 font-medium text-ink">
                            <a href={SEM.keyword(k.keyword)} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{k.keyword}</a>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <span className={'inline-block min-w-[28px] rounded-full px-1.5 py-0.5 text-center text-[12px] font-semibold tabular-nums ' + posTone(k.position)}>{k.position}</span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{fmtExact(k.volume)}</td>
                          <td className={'px-3 py-2 text-right tabular-nums font-medium ' + kdTone(k.difficulty)}>{k.difficulty ?? '—'}</td>
                          <td className="max-w-[200px] truncate px-3 py-2 text-[12px] text-ink-faint" title={k.url}>{k.url.replace(/^https?:\/\/(www\.)?/, '')}</td>
                          <td className="px-3 py-2 text-right">
                            <div className="flex justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => sendToDraft('Write a new supporting article targeting "' + k.keyword + '" (currently ranking #' + k.position + ', ' + (k.volume ?? '?') + ' searches/mo). Cover the topic more completely than the current page and answer the real questions patients search.')}
                                className="rounded-full px-2.5 py-1 text-[11px] font-medium text-accent ring-1 ring-accent/30 transition hover:bg-accent-soft"
                              >
                                Draft
                              </button>
                              <button
                                type="button"
                                onClick={() => sendToDraft('Rewrite and expand the content at ' + k.url + ' to improve its Google ranking for "' + k.keyword + '" (currently position ' + k.position + '). Fully satisfy the search intent, add depth and real patient questions, keep medical claims compliant.')}
                                className="rounded-full bg-accent px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-accent-hover"
                              >
                                Optimize
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-2 text-[11px] text-ink-faint">Ranked by volume × ease × proximity to page-1 top. “Optimize” prefills the AI with a ranking-improvement brief for the exact page and keyword.</p>
            </Card>

            {/* Portfolio breakdowns */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card tag="Intent Mix" title={'What your top ' + kws.length + ' keywords are for'}>
                {intentBreakdown.length === 0 ? (
                  <p className="text-[13px] text-ink-muted">No intent data in the current sample.</p>
                ) : (
                  <SegmentBar ariaLabel={'Search intent mix: ' + intentBreakdown.map((b) => b.label + ' ' + b.count).join(', ')} segments={intentBreakdown} />
                )}
                <p className="mt-3 text-[11px] text-ink-faint">Informational intent wants education content; commercial/transactional wants comparison and treatment pages.</p>
              </Card>
              <Card tag="Difficulty Mix" title="How hard your ranking keywords are">
                {kdBreakdown.length === 0 ? (
                  <p className="text-[13px] text-ink-muted">No difficulty data in the current sample.</p>
                ) : (
                  <SegmentBar ariaLabel={'Keyword difficulty mix: ' + kdBreakdown.map((b) => b.label + ' ' + b.count).join(', ')} segments={kdBreakdown} />
                )}
                <p className="mt-3 text-[11px] text-ink-faint">With Authority Score {bl?.authorityScore ?? '—'}/100, keywords under KD ~50 are the realistic battleground.</p>
              </Card>
            </div>

            {/* AI Ranking Advisor */}
            <Card
              tag="AI Ranking Advisor"
              title="Data-grounded action plan"
              right={
                <button
                  type="button"
                  onClick={() => void loadAdvice(domain)}
                  disabled={adviceLoading || loading}
                  className="rounded-xl bg-accent px-3.5 py-1.5 text-[12px] font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50"
                >
                  {adviceLoading ? 'Analyzing…' : advice ? 'Regenerate plan' : 'Generate action plan'}
                </button>
              }
            >
              {adviceErr && <p className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-200">{adviceErr}</p>}
              {!advice && !adviceLoading && !adviceErr && (
                <p className="text-[13px] text-ink-muted">
                  The advisor reads everything on this panel — rankings, movers, competitors, backlinks, site audit — and returns a prioritized
                  plan of the highest-impact moves. Content recommendations come with one-click AI draft prompts.
                </p>
              )}
              {adviceLoading && <p className="text-[13px] text-ink-muted">Reading the Semrush data and building your plan…</p>}
              {advice && (
                <div className="space-y-3">
                  {advice.summary && <p className="rounded-xl bg-accent-soft/60 px-3.5 py-2.5 text-[13px] leading-relaxed text-ink">{advice.summary}</p>}
                  {advice.priorities.map((p, i) => (
                    <div key={i} className="rounded-xl bg-subtle/60 p-4 ring-1 ring-line">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink text-[12px] font-bold text-white">{p.rank || i + 1}</span>
                        <span className="text-[14px] font-semibold text-ink">{p.title}</span>
                        <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted ring-1 ring-line">{p.category}</span>
                        <span className={'rounded-full px-2 py-0.5 text-[10px] font-semibold ' + (p.impact === 'high' ? 'bg-emerald-100 text-emerald-700' : p.impact === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-subtle text-ink-muted')}>impact: {p.impact}</span>
                        <span className="rounded-full bg-subtle px-2 py-0.5 text-[10px] font-semibold text-ink-muted ring-1 ring-line">effort: {p.effort}</span>
                      </div>
                      {p.why && <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">{p.why}</p>}
                      {p.action && <p className="mt-1.5 text-[13px] text-ink"><span className="font-semibold">Do this:</span> {p.action}</p>}
                      {(p.keywords?.length > 0 || p.draftPrompt) && (
                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          {(p.keywords || []).slice(0, 6).map((k, ki) => (
                            <span key={k + ki} className="rounded-full bg-white px-2 py-0.5 text-[11px] text-ink-soft ring-1 ring-line">{k}</span>
                          ))}
                          {p.draftPrompt && (
                            <button
                              type="button"
                              onClick={() => sendToDraft(p.draftPrompt)}
                              className="ml-auto rounded-full bg-accent px-3 py-1 text-[11px] font-semibold text-white transition hover:bg-accent-hover"
                            >
                              ✍️ Draft with AI
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                  <p className="text-[11px] text-ink-faint">Grounded only in the Semrush numbers shown on this panel — regenerate after data refreshes to keep the plan current.</p>
                </div>
              )}
            </Card>
          </div>
        )}

        {/* ============================================== TOP KEYWORDS */}
        {tab === 'keywords' && (
          <div className="mt-4">
            <Card tag="Organic Research" title={'Top ranking keywords — ' + domain} right={<a href={SEM.organic(domain)} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-accent hover:underline">Full report ↗</a>}>
              {loading ? (
                <p className="text-[13px] text-ink-muted">Loading rankings…</p>
              ) : kws.length === 0 ? (
                <SectionNotice meta={bundle?.topKeywordsMeta ?? { ok: false, source: 'none', reason: 'empty', unitsSpent: 0 }} what="Ranking keywords" />
              ) : (
                <div className="overflow-x-auto rounded-xl ring-1 ring-line">
                  <table className="w-full min-w-[640px] text-left text-[13px]">
                    <thead className="bg-subtle text-ink-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">Keyword</th>
                        <th className="px-3 py-2 text-right font-medium">Pos</th>
                        <th className="px-3 py-2 text-right font-medium">Δ</th>
                        <th className="px-3 py-2 text-right font-medium">Volume</th>
                        <th className="px-3 py-2 text-right font-medium">KD</th>
                        <th className="px-3 py-2 text-right font-medium">Traffic %</th>
                        <th className="px-3 py-2 font-medium">URL</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {kws.map((k, i) => {
                        const d = k.positionDiff;
                        return (
                          <tr key={k.keyword + i} className="border-t border-line">
                            <td className="px-3 py-2 text-ink">
                              <a href={SEM.keyword(k.keyword)} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{k.keyword}</a>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span className={'inline-block min-w-[28px] rounded-full px-1.5 py-0.5 text-center text-[12px] font-semibold tabular-nums ' + posTone(k.position)}>{k.position ?? '—'}</span>
                            </td>
                            <td className={'px-3 py-2 text-right text-[12px] font-medium tabular-nums ' + (d == null || d === 0 ? 'text-ink-faint' : d > 0 ? 'text-emerald-600' : 'text-rose-600')}>
                              {d == null || d === 0 ? '·' : (d > 0 ? '▲ ' : '▼ ') + Math.abs(d)}
                            </td>
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
                <p className="mt-2 text-[11px] text-ink-faint">Sorted by traffic contribution · Google US organic · “Draft” sends the keyword through the automatic Semrush filter into a new AI draft.</p>
              )}
            </Card>
          </div>
        )}

        {/* ============================================== COMPETITORS */}
        {tab === 'competitors' && (
          <div className="mt-4">
            <Card tag="Competitive Research" title={'Organic competitors — ' + domain} right={<a href={SEM.competitors(domain)} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-accent hover:underline">Full report ↗</a>}>
              {loading ? (
                <p className="text-[13px] text-ink-muted">Loading competitors…</p>
              ) : (bundle?.competitors.length ?? 0) === 0 ? (
                <SectionNotice meta={bundle?.competitorsMeta ?? { ok: false, source: 'none', reason: 'empty', unitsSpent: 0 }} what="Organic competitors" />
              ) : (
                <>
                  <div className="overflow-x-auto rounded-xl ring-1 ring-line">
                    <table className="w-full min-w-[560px] text-left text-[13px]">
                      <thead className="bg-subtle text-ink-muted">
                        <tr>
                          <th className="px-3 py-2 font-medium">Competitor</th>
                          <th className="px-3 py-2 font-medium">Competition level</th>
                          <th className="px-3 py-2 text-right font-medium">Common keywords</th>
                          <th className="px-3 py-2 text-right font-medium">Their keywords</th>
                          <th className="px-3 py-2 text-right font-medium">Their traffic</th>
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
                                <div className="h-2 w-24 overflow-hidden rounded-full bg-subtle">
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
            </Card>
          </div>
        )}

        {/* ============================================== BACKLINKS */}
        {tab === 'backlinks' && (
          <div className="mt-4">
            <Card tag="Backlink Analytics" title={domain} right={<a href={SEM.backlinks(domain)} target="_blank" rel="noopener noreferrer" className="text-[12px] font-medium text-accent hover:underline">Full report ↗</a>}>
              {loading ? (
                <p className="text-[13px] text-ink-muted">Loading link profile…</p>
              ) : !bl ? (
                <SectionNotice meta={bundle?.backlinksMeta ?? { ok: false, source: 'none', reason: 'empty', unitsSpent: 0 }} what="Backlink metrics" />
              ) : (
                <>
                  <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <div className="text-[12px] font-medium text-ink-muted">Total Backlinks</div>
                      <div className="mt-0.5 flex items-baseline gap-2">
                        <span className="text-[26px] font-semibold tabular-nums text-ink">{fmtNum(bl.backlinksTotal)}</span>
                        <DeltaText pct={blDelta} />
                      </div>
                      <div className="mt-1"><AreaChart points={blPts} height={44} label="Backlinks trend" /></div>
                    </div>
                    <div>
                      <div className="text-[12px] font-medium text-ink-muted">Referring Domains</div>
                      <div className="mt-0.5 text-[26px] font-semibold tabular-nums text-ink">{fmtNum(bl.refDomains)}</div>
                    </div>
                    <div>
                      <div className="text-[12px] font-medium text-ink-muted">Referring URLs</div>
                      <div className="mt-0.5 text-[26px] font-semibold tabular-nums text-ink">{fmtNum(bl.refUrls)}</div>
                    </div>
                    <div>
                      <div className="text-[12px] font-medium text-ink-muted">Referring IPs</div>
                      <div className="mt-0.5 text-[26px] font-semibold tabular-nums text-ink">{fmtNum(bl.refIps)}</div>
                    </div>
                  </div>
                  {bl.follows != null && bl.nofollows != null && bl.follows + bl.nofollows > 0 && (
                    <div className="mt-5">
                      <div className="mb-2 text-[12px] font-medium text-ink-muted">Link attributes</div>
                      <SegmentBar
                        ariaLabel={'Follow ' + bl.follows + ', nofollow ' + bl.nofollows}
                        segments={[
                          { label: 'Follow', count: bl.follows, color: '#6366f1' },
                          { label: 'Nofollow', count: bl.nofollows, color: 'rgba(99,102,241,0.3)' },
                        ]}
                      />
                      <div className="mt-2 flex flex-wrap gap-x-4 text-[11px] text-ink-muted">
                        {bl.texts != null && <span>Text links <span className="font-semibold tabular-nums text-ink">{fmtNum(bl.texts)}</span></span>}
                        {bl.images != null && <span>Image links <span className="font-semibold tabular-nums text-ink">{fmtNum(bl.images)}</span></span>}
                      </div>
                    </div>
                  )}
                  <p className="mt-4 text-[11px] text-ink-faint">Backlink quality drives Authority Score ({bl.authorityScore ?? '—'}/100). Earn links from relevant medical and health publications to raise it.</p>
                </>
              )}
            </Card>
          </div>
        )}

        {/* ============================================== KEYWORD RESEARCH */}
        {tab === 'research' && (
          <div className="mt-4">
            <Card tag="Keyword Magic" title="Topic research — the same brief the AI drafts with">
              <KeywordIntelligence embedded initialTopic={initialTopic} onUseTopic={onUseTopic} />
            </Card>
          </div>
        )}
      </div>
    </section>
  );
}
