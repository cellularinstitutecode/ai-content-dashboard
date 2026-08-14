'use client';
// web/app/KeywordIntelligence.tsx
// Semrush Keyword Intelligence — the comprehensive hub that replaces the old
// keyword panel. One topic in → four views out:
//   Overview   — the AI's Keyword Brief (primary/supporting/intent) at a glance
//   Related    — full keyword table with difficulty + opportunity scores
//   Questions  — real searcher questions, one click away from a draft
//   SERP       — who currently ranks, so drafts differentiate
// The same data feeds the drafting pre-filter and the chatbot, so what you see
// here is exactly what the AI writes with. Cache-first: repeat topics cost 0
// API units; a live unit-balance chip keeps spending honest.
import { useEffect, useState } from 'react';

type SemKeyword = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  intents: string[];
  opportunity?: number;
};

type Brief = {
  topic: string;
  primary: SemKeyword | null;
  supporting: SemKeyword[];
  questions: SemKeyword[];
  intentSummary: string;
  source: 'semrush' | 'none';
  fromCache: boolean;
  unitsSpent: number;
};

type HubData = {
  ok: boolean;
  source: 'semrush' | 'none';
  fromCache: boolean;
  reason: string;
  note: string | null;
  brief: Brief;
  related: SemKeyword[];
  questions: SemKeyword[];
  balance: number | null;
};

type SerpRow = { domain: string; url: string };

type Tab = 'overview' | 'related' | 'questions' | 'serp';

function semrushUrl(keyword: string): string {
  const kw = (keyword || '').trim();
  const base = 'https://www.semrush.com/analytics/keywordmagic/';
  return kw ? base + '?q=' + encodeURIComponent(kw) + '&db=us' : base + '?db=us';
}

function kdTone(d: number | null | undefined): string {
  if (d == null) return 'text-ink-faint';
  if (d < 30) return 'text-emerald-600';
  if (d < 50) return 'text-amber-600';
  return 'text-rose-600';
}

function kdLabel(d: number | null | undefined): string {
  if (d == null) return '—';
  if (d < 30) return d + ' · easy';
  if (d < 50) return d + ' · possible';
  if (d < 70) return d + ' · hard';
  return d + ' · very hard';
}

function intentChip(i: string): { label: string; cls: string } {
  switch (i) {
    case 'informational': return { label: 'info', cls: 'bg-sky-100 text-sky-700' };
    case 'commercial': return { label: 'commercial', cls: 'bg-violet-100 text-violet-700' };
    case 'transactional': return { label: 'buy', cls: 'bg-emerald-100 text-emerald-700' };
    case 'navigational': return { label: 'brand', cls: 'bg-slate-200 text-slate-700' };
    default: return { label: i, cls: 'bg-subtle text-ink-muted' };
  }
}

function fmtVol(v: number | null | undefined): string {
  return v != null ? v.toLocaleString() : '—';
}

export default function KeywordIntelligence({
  initialTopic = '',
  onUseTopic,
  embedded = false,
}: {
  initialTopic?: string;
  onUseTopic?: (draftPrompt: string) => void;
  /** When true the component renders without its own card chrome/header so it
   *  can live inside another panel (e.g. the Semrush Intelligence hub). */
  embedded?: boolean;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const [tab, setTab] = useState<Tab>('overview');
  const [data, setData] = useState<HubData | null>(null);
  const [serp, setSerp] = useState<SerpRow[] | null>(null);
  const [serpLoading, setSerpLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [connected, setConnected] = useState<'unknown' | 'yes' | 'no'>('unknown');

  // One free balance probe on mount tells us if the key is wired up at all.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/semrush?action=balance');
        const j = await r.json().catch(() => null);
        if (!cancelled) {
          setBalance(j && typeof j.balance === 'number' ? j.balance : null);
          setConnected(j && typeof j.balance === 'number' ? 'yes' : 'no');
        }
      } catch {
        if (!cancelled) setConnected('no');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function analyze() {
    const seed = topic.trim();
    if (!seed) return;
    setLoading(true);
    setSerp(null);
    try {
      const r = await fetch('/api/semrush?action=hub&topic=' + encodeURIComponent(seed));
      const j = (await r.json().catch(() => null)) as HubData | null;
      setData(j);
      if (j && typeof j.balance === 'number') { setBalance(j.balance); setConnected('yes'); }
      setTab('overview');
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadSerp() {
    const seed = (data?.brief.primary?.keyword || topic).trim();
    if (!seed || serpLoading) return;
    setSerpLoading(true);
    try {
      const r = await fetch('/api/semrush?action=serp&topic=' + encodeURIComponent(seed));
      const j = await r.json().catch(() => null);
      setSerp(j && Array.isArray(j.rows) ? j.rows : []);
    } catch {
      setSerp([]);
    } finally {
      setSerpLoading(false);
    }
  }

  function sendToDraft(text: string) {
    if (onUseTopic) onUseTopic(text);
  }

  const live = data?.ok;
  const statusChip = live
    ? data!.fromCache
      ? { cls: 'bg-sky-100 text-sky-700', label: 'Semrush data · cached' }
      : { cls: 'bg-emerald-100 text-emerald-700', label: 'Semrush data · live' }
    : connected === 'no'
    ? { cls: 'bg-amber-100 text-amber-700', label: 'Not connected' }
    : { cls: 'bg-subtle text-ink-muted', label: 'Ready' };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'related', label: 'Related keywords' },
    { id: 'questions', label: 'Questions' },
    { id: 'serp', label: 'SERP rivals' },
  ];

  return (
    <section className={embedded ? '' : 'overflow-hidden rounded-3xl bg-white ring-1 ring-line shadow-soft'}>
      {/* Header (hidden when embedded in the Semrush Intelligence panel) */}
      {!embedded && (
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">🧠</span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[15px] font-semibold text-ink">Semrush Keyword Intelligence</h3>
              <span className={'rounded-full px-2 py-0.5 text-[11px] font-medium ' + statusChip.cls}>{statusChip.label}</span>
              {balance != null && (
                <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] tabular-nums text-ink-muted" title="Semrush API units remaining">
                  ⚡ {balance.toLocaleString()} units
                </span>
              )}
            </div>
            <p className="text-[12px] text-ink-muted">The same data the AI drafts and advises with — analyze once, reuse everywhere.</p>
          </div>
        </div>
        <a href={semrushUrl(topic)} target="_blank" rel="noopener noreferrer" className="shrink-0 text-[12px] font-medium text-emerald-700 hover:text-emerald-800">Open in Semrush ↗</a>
      </div>
      )}

      <div className={embedded ? 'pt-1' : 'p-6'}>
        {/* Search row */}
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') analyze(); }}
            placeholder="e.g. stem cell therapy for knee pain"
            className="flex-1 rounded-xl bg-subtle px-3.5 py-2.5 text-[14px] text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-emerald-300"
          />
          <button
            type="button"
            onClick={analyze}
            disabled={loading || !topic.trim()}
            className="shrink-0 rounded-xl bg-emerald-600 px-4 py-2.5 text-[14px] font-medium text-white transition hover:bg-emerald-700 disabled:opacity-50"
          >
            {loading ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>

        {connected === 'no' && (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-200">
            Semrush is not connected yet. Create an API key in your Semrush account and set it as SEMRUSH_API_KEY in Vercel.
            Seeded topics still work from cache; everything else uses the link-out above until then.
          </p>
        )}

        {data && !data.ok && data.reason !== 'ok' && (
          <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-200">
            {data.reason === 'budget'
              ? 'Unit balance is at the protection floor — serving cached data only.'
              : data.note || 'No Semrush data available for this topic.'}
          </p>
        )}

        {/* Tabs */}
        {data?.ok && (
          <>
            <div className="mt-5 flex flex-wrap gap-1 rounded-xl bg-subtle p-1">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setTab(t.id); if (t.id === 'serp' && serp == null) loadSerp(); }}
                  className={
                    'rounded-lg px-3 py-1.5 text-[13px] font-medium transition ' +
                    (tab === t.id ? 'bg-white text-ink shadow-soft ring-1 ring-line' : 'text-ink-muted hover:text-ink')
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Overview — the Keyword Brief the AI receives */}
            {tab === 'overview' && (
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div className="rounded-2xl bg-emerald-50/60 p-4 ring-1 ring-emerald-100">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Primary keyword</div>
                  {data.brief.primary ? (
                    <>
                      <div className="mt-1 text-[18px] font-semibold text-ink">{data.brief.primary.keyword}</div>
                      <div className="mt-2 flex flex-wrap items-center gap-3 text-[13px]">
                        <span className="tabular-nums text-ink"><span className="text-ink-muted">Volume</span> {fmtVol(data.brief.primary.volume)}/mo</span>
                        <span className={'tabular-nums font-medium ' + kdTone(data.brief.primary.difficulty)}>KD {kdLabel(data.brief.primary.difficulty)}</span>
                        {data.brief.primary.cpc != null && <span className="tabular-nums text-ink-muted">CPC ${data.brief.primary.cpc}</span>}
                        {data.brief.primary.intents.map((i) => {
                          const c = intentChip(i);
                          return <span key={i} className={'rounded-full px-2 py-0.5 text-[11px] font-medium ' + c.cls}>{c.label}</span>;
                        })}
                      </div>
                      <button
                        type="button"
                        onClick={() => sendToDraft(data.brief.primary!.keyword)}
                        className="mt-3 rounded-full bg-emerald-600 px-3.5 py-1.5 text-[12px] font-medium text-white transition hover:bg-emerald-700"
                      >
                        ✍️ Draft with this keyword
                      </button>
                    </>
                  ) : (
                    <p className="mt-2 text-[13px] text-ink-muted">No clear primary keyword found.</p>
                  )}
                </div>
                <div className="rounded-2xl bg-subtle/60 p-4 ring-1 ring-line">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">What the AI is told</div>
                  <ul className="mt-2 space-y-1.5 text-[13px] text-ink-soft">
                    <li>• Lead with the primary keyword in the hook/headline.</li>
                    <li>• Weave in {data.brief.supporting.length} supporting terms: {data.brief.supporting.slice(0, 3).map((k) => k.keyword).join(', ')}{data.brief.supporting.length > 3 ? '…' : ''}</li>
                    {data.brief.questions.length > 0 && <li>• Answer a real searcher question, e.g. “{data.brief.questions[0].keyword}”.</li>}
                    <li>• Match {data.brief.intentSummary} search intent; no keyword stuffing; compliant claims only.</li>
                  </ul>
                  <div className="mt-2 text-[11px] text-ink-faint">
                    {data.fromCache ? 'Served from cache — 0 units spent.' : data.brief.unitsSpent > 0 ? data.brief.unitsSpent + ' units spent (now cached for repeat use).' : ''}
                  </div>
                </div>
              </div>
            )}

            {/* Related keywords table */}
            {tab === 'related' && (
              <div className="mt-4 overflow-hidden rounded-2xl ring-1 ring-line">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-subtle text-ink-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Keyword</th>
                      <th className="px-3 py-2 font-medium text-right">Volume</th>
                      <th className="px-3 py-2 font-medium text-right">Difficulty</th>
                      <th className="px-3 py-2 font-medium">Intent</th>
                      <th className="px-3 py-2 font-medium text-right">Opportunity</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.related.map((k, i) => (
                      <tr key={k.keyword + i} className="border-t border-line">
                        <td className="px-3 py-2 text-ink">
                          <a href={semrushUrl(k.keyword)} target="_blank" rel="noopener noreferrer" className="hover:text-emerald-700">{k.keyword}</a>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{fmtVol(k.volume)}</td>
                        <td className={'px-3 py-2 text-right tabular-nums font-medium ' + kdTone(k.difficulty)}>{k.difficulty ?? '—'}</td>
                        <td className="px-3 py-2">
                          <span className="flex flex-wrap gap-1">
                            {k.intents.map((x) => {
                              const c = intentChip(x);
                              return <span key={x} className={'rounded-full px-1.5 py-0.5 text-[10px] font-medium ' + c.cls}>{c.label}</span>;
                            })}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">{k.opportunity ?? '—'}</td>
                        <td className="px-3 py-2 text-right">
                          <button type="button" onClick={() => sendToDraft(k.keyword)} className="rounded-full px-2.5 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200 transition hover:bg-emerald-50">Use</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Questions */}
            {tab === 'questions' && (
              <div className="mt-4 space-y-2">
                {data.questions.length === 0 && <p className="text-[13px] text-ink-muted">No question-style searches found for this topic.</p>}
                {data.questions.map((q, i) => (
                  <div key={q.keyword + i} className="flex items-center justify-between gap-3 rounded-2xl bg-subtle/60 px-4 py-3 ring-1 ring-line">
                    <div>
                      <div className="text-[14px] text-ink">{q.keyword}</div>
                      <div className="mt-0.5 text-[12px] tabular-nums text-ink-muted">{fmtVol(q.volume)}/mo{q.difficulty != null ? ' · KD ' + q.difficulty : ''}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => sendToDraft('Answer this patient question clearly and compliantly: ' + q.keyword)}
                      className="shrink-0 rounded-full bg-indigo-600 px-3.5 py-1.5 text-[12px] font-medium text-white transition hover:bg-indigo-700"
                    >
                      Draft the answer
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* SERP rivals */}
            {tab === 'serp' && (
              <div className="mt-4">
                {serpLoading && <p className="text-[13px] text-ink-muted">Loading who ranks…</p>}
                {!serpLoading && serp && serp.length === 0 && <p className="text-[13px] text-ink-muted">No SERP data available.</p>}
                {!serpLoading && serp && serp.length > 0 && (
                  <>
                    <p className="mb-2 text-[12px] text-ink-muted">Top Google results for “{data.brief.primary?.keyword || topic}” — the AI writes to stand apart from these.</p>
                    <ol className="space-y-1.5">
                      {serp.map((r, i) => (
                        <li key={r.domain + i} className="flex items-center gap-3 rounded-xl bg-subtle/60 px-3.5 py-2 ring-1 ring-line">
                          <span className="w-5 text-right text-[12px] tabular-nums text-ink-faint">{i + 1}.</span>
                          <span className="text-[13px] font-medium text-ink">{r.domain}</span>
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="ml-auto truncate text-[12px] text-ink-muted hover:text-emerald-700" style={{ maxWidth: '50%' }}>{r.url}</a>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
