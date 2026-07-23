'use client';

import { useEffect, useState } from 'react';

type Provider = 'anthropic' | 'openai';
type ContentType = 'social' | 'blog' | 'email' | 'video' | 'ad';

const PROVIDERS: { id: Provider; label: string; models: { id: string; label: string }[] }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)', models: [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ]},
  { id: 'openai', label: 'OpenAI', models: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ]},
];

const CONTENT_TYPES: { id: ContentType; label: string; hint: string }[] = [
  { id: 'social', label: 'Social Post', hint: 'Short caption with hashtags for Instagram/X/LinkedIn/Facebook.' },
  { id: 'blog', label: 'Blog Article', hint: 'Long-form SEO-friendly article with H2/H3 structure.' },
  { id: 'email', label: 'Email Campaign', hint: 'Subject line + preview text + body for newsletter.' },
  { id: 'video', label: 'Video Script', hint: 'Hook + scenes + CTA for short-form video (Reels/TikTok/Shorts).' },
  { id: 'ad', label: 'Ad Copy', hint: 'Headline variations + body + CTA for Meta/Google Ads.' },
];

function metricoolMetrics(a: any): { label: string; value: any }[] {
  if (!a || typeof a !== 'object') return [];
  const found: { label: string; value: any }[] = [];
  const seen = new Set<string>();
  const wanted: [string, RegExp][] = [
    ['Followers', /followers|fans|subscribers/i],
    ['Reach', /reach/i],
    ['Impressions', /impressions|views/i],
    ['Engagement', /engagement|interactions/i],
  ];
  const walk = (obj: any, depth: number) => {
    if (!obj || depth > 4 || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'number' && isFinite(v)) {
        for (const [label, re] of wanted) {
          if (!seen.has(label) && re.test(k)) { found.push({ label, value: v }); seen.add(label); }
        }
      } else if (v && typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  walk(a, 0);
  return found.slice(0, 4);
}

function ytThumb(url: string): string {
  try {
    const m = String(url).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([A-Za-z0-9_-]{11})/);
    return m ? 'https://img.youtube.com/vi/' + m[1] + '/hqdefault.jpg' : '';
  } catch { return ''; }
}

// Video IDs from Cellular Hope Institute's OWN YouTube channel (allowlist — nothing external can be embedded)
const OWN_VIDEO_IDS = new Set<string>(['N0x4zSdIoL8','Slh2u-aNbsA','P9eVqXAlOX0','Jp-4LoYjg9c','si7cwDqh87E','Lg4i2gZ3h9A','W9dGgIlm1D8','Lm54IKoWagY','REKxqVAgojQ','dJmkZffjnc8','NIxBmJX5Ofo','FyLyGD3tsOU','5cT8jnA6yy0','PUdDRDQ5o0Y','d5j1wPu0wqA','_HTcG6Ct8R0','SvZvrpZO24I','ZlAh066wph4','K8sZpsNOe2I','2-0fzkVIiSc','fNGee0Ax4Q0','kJd2yPHq3I0','1sHPntPRQm8','Fp-ArLlh__E','sNkFdy1b4Mo','39IV4hnJ3bc','y370BBoyE-0','GR3SoM0ZcNE','GHI6oX03JB8','6emvqez-1Gg']);
function ytId(url: string): string {
  try {
    const m = String(url).match(/(?:v=|be\/|shorts\/|embed\/)([\w-]{11})/);
    return m ? m[1] : '';
  } catch { return ''; }
}

function toArray(x: any): any[] {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.data)) return x.data;
  if (x && Array.isArray(x.drafts)) return x.drafts;
  if (x && Array.isArray(x.rows)) return x.rows;
  if (x && Array.isArray(x.items)) return x.items;
  return [];
}

export default function Dashboard() {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState<string>('claude-sonnet-4-5');
  const [type, setType] = useState<ContentType>('social');
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [mLoading, setMLoading] = useState(false);
  const [mAnalytics, setMAnalytics] = useState<any>(null);
  const [mNetworks, setMNetworks] = useState<string[]>(["facebook"]);
  const toggleNetwork = (n: string) => setMNetworks((prev) => prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]);
  const [mText, setMText] = useState('');
  const [mDate, setMDate] = useState('');
  const [mStatus, setMStatus] = useState<string | null>(null);

  const [opUrl, setOpUrl] = useState('');
  const [opStatus, setOpStatus] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [selectedDraft, setSelectedDraft] = useState<any>(null);

  useEffect(() => {
    const first = PROVIDERS.find(p => p.id === provider)!;
    if (!first.models.some(m => m.id === model)) setModel(first.models[0].id);
  }, [provider]);

  useEffect(() => { refreshDrafts(); refreshStats(); }, []);

  async function refreshStats() {
    try {
      const r = await fetch('/api/stats');
      if (!r.ok) return;
      const j = await r.json().catch(() => null);
      if (j) setStats(j);
    } catch {}
  }

  async function refreshDrafts() {
    try {
      const r = await fetch('/api/drafts');
      if (!r.ok) return;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return;
      const j = await r.json().catch(() => null);
      setDrafts(toArray(j));
    } catch {}
  }

  async function generate() {
    setLoading(true); setErr(null); setOutput('');
    try {
      const r = await fetch('/api/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: prompt, provider, model, type }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || ('Generation failed ('+r.status+')'));
      const pack = data.pack || {};
      setOutput([
        'INSTAGRAM', pack.instagram || '', '',
        'FACEBOOK', pack.facebook || '', '',
        'LINKEDIN', pack.linkedin || '', '',
        'BLOG', pack.blog || ''
      ].join('\n'));
      try {
        await fetch('/api/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: prompt, pack, provider }),
        });
      } catch {}
      refreshDrafts();
    } catch (e: any) { setErr(e?.message || 'Generation failed'); } finally { setLoading(false); }
  }

  async function loadAnalytics() {
    setMLoading(true); setMStatus(null);
    try {
      const r = await fetch('/api/metricool?blogId=4308292');
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || ('Metricool fetch failed ('+r.status+')'));
      setMAnalytics(data);
    } catch (e: any) { setMStatus('Error: ' + (e?.message || 'failed')); } finally { setMLoading(false); }
  }

  async function schedulePost() {
    if (!mNetworks.length) { setMStatus('Pick at least one network.'); return; }
    if (!mDate) { setMStatus('Pick a date & time.'); return; }
    setMStatus(null);
    try {
      const results = await Promise.all(
        mNetworks.map(async (network) => {
          const r = await fetch('/api/metricool/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ network, text: mText, publishAt: mDate, blogId: 4308292 }),
          });
          const data = await r.json().catch(() => ({}));
          return { network, ok: r.ok, status: r.status, data };
        })
      );
      const ok = results.filter((x) => x.ok).map((x) => x.network);
      const failed = results.filter((x) => !x.ok).map((x) => x.network);
      if (failed.length === 0) {
        setMStatus('Scheduled on ' + ok.join(', ') + '.');
      } else if (ok.length === 0) {
        setMStatus('Error: failed on ' + failed.join(', ') + '.');
      } else {
        setMStatus('Scheduled on ' + ok.join(', ') + '; failed on ' + failed.join(', ') + '.');
      }
    } catch (e: any) {
      setMStatus('Error: ' + (e?.message || 'failed'));
    }
  }

  async function clipVideo() {
    setOpStatus(null);
    try {
      const r = await fetch('/api/opus/clip', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoUrl: opUrl }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || ('OpusClip failed ('+r.status+')'));
      setOpStatus('Clip job started ' + ((data && data.project && (data.project.projectId || data.project.id)) || ''));
      try {
        await fetch('/api/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            topic: 'Video clips from ' + opUrl,
            provider: 'opusclip',
            pack: { kind: 'clip', video: opUrl, thumb: ytThumb(opUrl) },
          }),
        });
        refreshDrafts();
      } catch {}
    } catch (e: any) { setOpStatus('Error: ' + (e?.message || 'failed')); }
  }

  async function copyOutput() {
    try { await navigator.clipboard.writeText(output); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  }

  const currentModels = PROVIDERS.find(p => p.id === provider)!.models;
  const safeDrafts = Array.isArray(drafts) ? drafts : [];
  const metrics = metricoolMetrics(mAnalytics);
  const activeType = CONTENT_TYPES.find(t => t.id === type)!;

  const statCards = [
    { label: 'Drafts', value: (stats && (stats.drafts ?? stats.draftsCount)) ?? safeDrafts.length ?? 0 },
    { label: 'Scheduled posts', value: (stats && (stats.scheduled ?? stats.scheduledCount)) ?? 0 },
    { label: 'Upcoming', value: (stats && (stats.upcoming ?? stats.upcomingCount)) ?? 0 },
    { label: 'Clip jobs', value: (stats && (stats.clips ?? stats.clipJobs)) ?? 0 },
  ];

  const nav = [
    { href: '/', label: 'Dashboard', current: true },
    { href: '/calendar', label: 'Calendar', current: false },
    { href: '/brand', label: 'Brand Brain', current: false },
    { href: '/templates', label: 'Templates', current: false },
  ];

  return (
    <div className="glow min-h-screen bg-canvas text-ink">
      <div className="relative z-10 mx-auto flex max-w-[1400px] gap-8 px-6 py-8 lg:px-10">
        {/* Sidebar */}
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-8">
            <div className="mb-8 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-accent text-white shadow-soft">
                <span className="text-lg font-semibold">C</span>
              </div>
              <div>
                <div className="text-[15px] font-semibold leading-tight">Content Studio</div>
                <div className="text-xs text-ink-muted">Cellular Hope Institute</div>
              </div>
            </div>
            <nav className="space-y-1">
              {nav.map(n => (
                <a key={n.href} href={n.href}
                  className={'flex items-center rounded-xl px-3.5 py-2.5 text-[14px] font-medium transition-colors ' + (n.current ? 'bg-white text-ink shadow-soft' : 'text-ink-muted hover:bg-white/60 hover:text-ink')}>
                  {n.label}
                </a>
              ))}
            </nav>
            <div className="mt-8 border-t border-line pt-6">
              <a href="/sign-out" className="flex items-center rounded-xl px-3.5 py-2.5 text-[14px] font-medium text-ink-muted transition-colors hover:bg-white/60 hover:text-ink">Sign out</a>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="min-w-0 flex-1 animate-in">
          <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-title font-semibold">Good to see you</h1>
              <p className="mt-1 text-[15px] text-ink-muted">Create, schedule, and repurpose content â all in one place.</p>
            </div>
            <div className="flex items-center gap-2 lg:hidden">
              {nav.map(n => (
                <a key={n.href} href={n.href} className={'rounded-full px-3.5 py-1.5 text-[13px] font-medium ' + (n.current ? 'bg-ink text-white' : 'bg-white text-ink-muted shadow-soft')}>{n.label}</a>
              ))}
            </div>
          </header>

          {/* Stat cards */}
          <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
            {statCards.map(s => (
              <div key={s.label} className="rounded-2xl bg-surface p-5 shadow-card ring-1 ring-line/60">
                <div className="text-[28px] font-semibold leading-none tracking-tight">{s.value}</div>
                <div className="mt-2 text-[13px] text-ink-muted">{s.label}</div>
              </div>
            ))}
          </section>

          {/* Generator */}
          <section className="mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
            <div className="border-b border-line px-6 py-5 sm:px-8">
              <h2 className="text-headline font-semibold">Content Generator</h2>
              <p className="mt-0.5 text-[13px] text-ink-muted">Pick a model and format, describe your idea, and generate a ready-to-post pack.</p>
            </div>
            <div className="grid gap-0 lg:grid-cols-2">
              {/* Controls */}
              <div className="space-y-5 p-6 sm:p-8">
                <div>
                  <label className="mb-2 block text-[12px] font-medium uppercase tracking-wide text-ink-muted">Model</label>
                  <div className="flex flex-wrap items-center gap-2">
                    {PROVIDERS.map(p => (
                      <button key={p.id} onClick={() => setProvider(p.id)}
                        className={'rounded-full px-4 py-2 text-[13px] font-medium transition-all ' + (provider === p.id ? 'bg-ink text-white shadow-soft' : 'bg-subtle text-ink-muted ring-1 ring-line hover:text-ink')}>
                        {p.label}
                      </button>
                    ))}
                    <select value={model} onChange={e => setModel(e.target.value)}
                      className="rounded-full bg-subtle px-4 py-2 text-[13px] font-medium text-ink ring-1 ring-line focus:ring-accent">
                      {currentModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-2 block text-[12px] font-medium uppercase tracking-wide text-ink-muted">Format</label>
                  <div className="flex flex-wrap gap-2">
                    {CONTENT_TYPES.map(t => (
                      <button key={t.id} onClick={() => setType(t.id)}
                        className={'rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-all ' + (type === t.id ? 'bg-accent text-white shadow-soft' : 'bg-subtle text-ink-muted ring-1 ring-line hover:text-ink')}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[12px] text-ink-faint">{activeType.hint}</p>
                </div>

                <div>
                  <label className="mb-2 block text-[12px] font-medium uppercase tracking-wide text-ink-muted">Your idea</label>
                  <textarea value={prompt} onChange={e => setPrompt(e.target.value)} rows={5}
                    placeholder="e.g. 3 Instagram captions about exosome therapy benefits for athletes"
                    className="w-full resize-none rounded-2xl bg-subtle p-4 text-[14px] text-ink ring-1 ring-line placeholder:text-ink-faint focus:ring-accent" />
                </div>

                <div className="flex items-center gap-3">
                  <button onClick={generate} disabled={loading || !prompt.trim()}
                    className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-[14px] font-semibold text-white shadow-soft transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">
                    {loading ? 'Generatingâ¦' : 'Generate'}
                  </button>
                  {err && <span className="text-[13px] text-danger">{err}</span>}
                </div>
              </div>

              {/* Output */}
              <div className="border-t border-line bg-subtle/50 p-6 sm:p-8 lg:border-l lg:border-t-0">
                <div className="mb-3 flex items-center justify-between">
                  <span className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Output</span>
                  {output && (
                    <button onClick={copyOutput} className="rounded-full bg-white px-3 py-1 text-[12px] font-medium text-ink ring-1 ring-line transition-colors hover:bg-subtle">
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  )}
                </div>
                {output ? (
                  <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-2xl bg-white p-4 text-[13px] leading-relaxed text-ink-soft ring-1 ring-line">{output}</pre>
                ) : (
                  <div className="flex h-[300px] flex-col items-center justify-center rounded-2xl border border-dashed border-line text-center">
                    <div className="text-[14px] font-medium text-ink-muted">Nothing generated yet</div>
                    <div className="mt-1 text-[12px] text-ink-faint">Your content pack will appear here.</div>
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* Metricool + OpusClip */}
          <section className="mb-8 grid gap-6 lg:grid-cols-2">
            {/* Metricool */}
            <div className="rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7">
              <div className="mb-1 flex items-center justify-between">
                <h2 className="text-headline font-semibold">Analytics &amp; Scheduling</h2>
                <span className="rounded-full bg-subtle px-2.5 py-1 text-[11px] font-medium text-ink-muted ring-1 ring-line">Metricool</span>
              </div>
              <p className="mb-4 text-[13px] text-ink-muted">Brand: Cellular Hope Institute Â· blogId 4308292</p>

              <button onClick={loadAnalytics} disabled={mLoading}
                className="mb-4 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">
                {mLoading ? 'Loadingâ¦' : 'Load latest analytics'}
              </button>

              {metrics.length > 0 && (
                <div className="mb-5 grid grid-cols-2 gap-3">
                  {metrics.map(m => (
                    <div key={m.label} className="rounded-2xl bg-subtle p-3 ring-1 ring-line">
                      <div className="text-[18px] font-semibold">{typeof m.value === 'number' ? m.value.toLocaleString() : String(m.value)}</div>
                      <div className="text-[12px] text-ink-muted">{m.label}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="border-t border-line pt-5">
                <label className="mb-2 block text-[12px] font-medium uppercase tracking-wide text-ink-muted">Schedule a post</label>
                <div className="mb-3 flex flex-wrap gap-2">
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Networks to post to">
            <button
              type="button"
              key="facebook"
              onClick={() => toggleNetwork("facebook")}
              aria-pressed={mNetworks.includes("facebook")}
              className={
                "rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " +
                (mNetworks.includes("facebook")
                  ? "bg-accent text-white ring-accent"
                  : "bg-subtle text-ink ring-line hover:ring-accent/50")
              }
            >
              Facebook
            </button>
            <button
              type="button"
              key="instagram"
              onClick={() => toggleNetwork("instagram")}
              aria-pressed={mNetworks.includes("instagram")}
              className={
                "rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " +
                (mNetworks.includes("instagram")
                  ? "bg-accent text-white ring-accent"
                  : "bg-subtle text-ink ring-line hover:ring-accent/50")
              }
            >
              Instagram
            </button>
            <button
              type="button"
              key="linkedin"
              onClick={() => toggleNetwork("linkedin")}
              aria-pressed={mNetworks.includes("linkedin")}
              className={
                "rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " +
                (mNetworks.includes("linkedin")
                  ? "bg-accent text-white ring-accent"
                  : "bg-subtle text-ink ring-line hover:ring-accent/50")
              }
            >
              LinkedIn
            </button>
            <button
              type="button"
              key="twitter"
              onClick={() => toggleNetwork("twitter")}
              aria-pressed={mNetworks.includes("twitter")}
              className={
                "rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " +
                (mNetworks.includes("twitter")
                  ? "bg-accent text-white ring-accent"
                  : "bg-subtle text-ink ring-line hover:ring-accent/50")
              }
            >
              X / Twitter
            </button>
          </div>
                  <input type="datetime-local" value={mDate} onChange={e => setMDate(e.target.value)}
                    className="rounded-xl bg-subtle px-3 py-2 text-[13px] text-ink ring-1 ring-line focus:ring-accent" />
                </div>
                <textarea value={mText} onChange={e => setMText(e.target.value)} rows={3} placeholder="Post textâ¦"
                  className="mb-3 w-full resize-none rounded-2xl bg-subtle p-3 text-[14px] text-ink ring-1 ring-line placeholder:text-ink-faint focus:ring-accent" />
                <div className="flex items-center gap-3">
                  <button onClick={schedulePost} className="rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white shadow-soft transition-colors hover:bg-accent-hover">Schedule via Metricool</button>
                  {mStatus && <span className={'text-[12px] ' + (mStatus.startsWith('Error') ? 'text-danger' : 'text-ink-muted')}>{mStatus}</span>}
                </div>
              </div>
            </div>

            {/* OpusClip */}
            <div className="rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7">
              <div className="mb-1 flex items-center justify-between">
                <h2 className="text-headline font-semibold">Long-form to Shorts</h2>
                <span className="rounded-full bg-subtle px-2.5 py-1 text-[11px] font-medium text-ink-muted ring-1 ring-line">OpusClip</span>
              </div>
              <p className="mb-4 text-[13px] text-ink-muted">Paste a YouTube or Vimeo URL to auto-generate short clips.</p>
              <input value={opUrl} onChange={e => setOpUrl(e.target.value)} placeholder="https://youtube.com/watch?v=â¦"
                className="mb-3 w-full rounded-2xl bg-subtle px-4 py-3 text-[14px] text-ink ring-1 ring-line placeholder:text-ink-faint focus:ring-accent" />
              <div className="flex items-center gap-3">
                <button onClick={clipVideo} disabled={!opUrl.trim()}
                  className="rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white shadow-soft transition-colors hover:bg-accent-hover disabled:opacity-40">Generate clips</button>
                {opStatus && <span className={'text-[12px] ' + (opStatus.startsWith('Error') ? 'text-danger' : 'text-ink-muted')}>{opStatus}</span>}
              </div>
            </div>
          </section>

          {/* Recent Drafts */}
          <section className="rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7">
            <h2 className="mb-4 text-headline font-semibold">Recent Drafts</h2>
            {safeDrafts.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line py-12 text-center">
                <div className="text-[14px] font-medium text-ink-muted">No drafts yet</div>
                <div className="mt-1 text-[12px] text-ink-faint">Generate something above to get started.</div>
              </div>
            ) : (
              <ul className="divide-y divide-line">
                {safeDrafts.slice(0, 8).map((d, i) => {
                  const title = (d && (d.title || d.topic || d.name)) || 'Untitled draft';
                  const body = (d && (d.body || d.instagram || d.text || d.content)) || '';
                  return (
                    <li onClick={() => setSelectedDraft(d)} role="button" tabIndex={0} key={(d && (d.id || d._id)) || i} className="cursor-pointer rounded-xl transition hover:bg-subtle/60 flex items-start gap-4 py-4">
                      {d?.pack?.kind === 'clip' && d?.pack?.thumb ? (
                        <div className="mb-2 overflow-hidden rounded-lg ring-1 ring-black/10">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={d.pack.thumb} alt="Video still" className="h-32 w-full object-cover" />
                        </div>
                      ) : null}
                      <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-subtle text-[13px] font-semibold text-ink-muted ring-1 ring-line">{i + 1}</div>
                      <div className="min-w-0">
                        <div className="truncate text-[14px] font-medium text-ink">{String(title)}</div>
                        {body && <div className="mt-0.5 line-clamp-2 text-[13px] text-ink-muted">{String(body)}</div>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          {/* Draft detail modal — click a draft to view / play */}
          {selectedDraft ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setSelectedDraft(null)}>
              <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7" onClick={(e) => e.stopPropagation()}>
                <div className="mb-4 flex items-start justify-between gap-4">
                  <h3 className="text-headline font-semibold text-ink">{String(selectedDraft?.title || selectedDraft?.topic || selectedDraft?.name || 'Draft')}</h3>
                  <button onClick={() => setSelectedDraft(null)} className="shrink-0 rounded-xl px-3 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">Close</button>
                </div>
                {selectedDraft?.pack?.kind === 'clip' ? (
                  (() => {
                    const vid = ytId(selectedDraft?.pack?.video || '');
                    if (vid && OWN_VIDEO_IDS.has(vid)) {
                      return (
                        <div className="overflow-hidden rounded-2xl ring-1 ring-black/10">
                          <div className="relative w-full" style={{ paddingBottom: '56.25%' }}>
                            <iframe className="absolute inset-0 h-full w-full" src={`https://www.youtube.com/embed/${vid}`} title="Cellular Hope video" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
                          </div>
                        </div>
                      );
                    }
                    return (<div className="rounded-2xl border border-dashed border-line p-6 text-center text-[13px] text-ink-muted">This clip isn’t linked to a Cellular Hope Institute video, so it can’t be played here.</div>);
                  })()
                ) : (
                  <div className="whitespace-pre-wrap rounded-2xl bg-subtle/50 p-4 text-[14px] leading-relaxed text-ink ring-1 ring-line/60">{String(selectedDraft?.body || selectedDraft?.pack?.instagram || selectedDraft?.pack?.text || selectedDraft?.text || selectedDraft?.pack?.content || JSON.stringify(selectedDraft?.pack ?? {}, null, 2))}</div>
                )}
              </div>
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
