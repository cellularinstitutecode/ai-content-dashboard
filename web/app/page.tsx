'use client';

import { useEffect, useRef, useState } from 'react';
import { useLiveContent } from "@/components/LiveContentProvider";

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

// Onboarding steps shown in the dismissible "How this works" strip so a
// first-time viewer understands the create -> repurpose -> schedule flow.
const ONBOARD_STEPS: { title: string; body: string }[] = [
{ title: '1 · Create', body: 'Pick a model and format, describe your idea, and generate a ready-to-post content pack.' },
{ title: '2 · Repurpose', body: 'Paste a long YouTube or Vimeo URL and OpusClip turns it into short vertical clips.' },
{ title: '3 · Schedule', body: 'Send posts to Metricool for review — you approve the final publish there.' },
{ title: '4 · Library', body: 'Everything you make is saved under Recent Drafts so you can edit, play, or reuse it.' },
];
const ONBOARD_KEY = 'chi_onboarding_dismissed_v1';


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

function ytId(url: string): string {
try {
const m = String(url).match(/(?:v=|be\/|shorts\/|embed\/)([\w-]{11})/);
return m ? m[1] : '';
} catch { return ''; }
}

// A finished Opus clip (mirrors OpusClip in lib/opus.ts).
type Clip = { id: string; title: string; text: string; description: string; hashtags: string; durationMs: number; preview: string; export: string };

function clipsOf(d: any): Clip[] {
const c = d && d.pack && d.pack.clips;
return Array.isArray(c) ? c : [];
}

function fmtDuration(ms: number): string {
const s = Math.round((Number(ms) || 0) / 1000);
const m = Math.floor(s / 60);
const r = s % 60;
return m + ':' + String(r).padStart(2, '0');
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
const { output, setOutput, drafts, setDrafts, stats, setStats } = useLiveContent();
const [provider, setProvider] = useState<Provider>('anthropic');
const [model, setModel] = useState<string>('claude-sonnet-4-5');
const [type, setType] = useState<ContentType>('social');
const [prompt, setPrompt] = useState('');
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
const [opBusy, setOpBusy] = useState(false);

const [selectedDraft, setSelectedDraft] = useState<any>(null);
const [editingDraft, setEditingDraft] = useState(false);
const [editTitle, setEditTitle] = useState('');
const [editBody, setEditBody] = useState('');
const [savingEdit, setSavingEdit] = useState(false);

// "How this works" onboarding strip. Hidden once the viewer dismisses it
// (persisted in localStorage so it does not nag on every visit).
const [showOnboard, setShowOnboard] = useState(false);
useEffect(() => {
try { if (typeof window !== 'undefined' && window.localStorage.getItem(ONBOARD_KEY) !== '1') setShowOnboard(true); } catch { setShowOnboard(true); }
}, []);
function dismissOnboard() {
setShowOnboard(false);
try { if (typeof window !== 'undefined') window.localStorage.setItem(ONBOARD_KEY, '1'); } catch {}
}

// Manual "Refresh clips" affordance so the viewer can pull the latest Opus
// render status on demand instead of waiting for the 15s poll.
const [refreshingClips, setRefreshingClips] = useState(false);
async function refreshClips() {
setRefreshingClips(true);
try { await refreshDrafts(0, false); await refreshStats(); } finally { setRefreshingClips(false); }
}

// Draft pagination
const PAGE_SIZE = 10;
const [draftsOffset, setDraftsOffset] = useState(0);
const [draftsTotal, setDraftsTotal] = useState(0);
const [loadingMore, setLoadingMore] = useState(false);

useEffect(() => {
const first = PROVIDERS.find(p => p.id === provider)!;
if (!first.models.some(m => m.id === model)) setModel(first.models[0].id);
}, [provider]);

useEffect(() => { refreshDrafts(); refreshStats(); }, []);


// Poll clip drafts that are still processing until Opus finishes rendering.
// The webhook is the fast path; this poll is the fallback / live-refresh so a
// user watching the dashboard sees processing -> ready without reloading.
const pollRef = useRef<any>(null);
useEffect(() => {
const pending = (Array.isArray(drafts) ? drafts : []).filter(
(d: any) => d && d.pack && d.pack.kind === 'clip' && d.pack.projectId && d.pack.status !== 'ready' && d.pack.status !== 'failed'
);
if (pending.length === 0) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } return; }
if (pollRef.current) return; // already polling
pollRef.current = setInterval(async () => {
const current = (Array.isArray(drafts) ? drafts : []).filter(
(d: any) => d && d.pack && d.pack.kind === 'clip' && d.pack.projectId && d.pack.status !== 'ready' && d.pack.status !== 'failed'
);
let changed = false;
for (const d of current) {
try {
const r = await fetch('/api/opus/clip?projectId=' + encodeURIComponent(d.pack.projectId));
if (!r.ok) continue;
const j = await r.json().catch(() => null);
if (j && j.status === 'ready' && Array.isArray(j.clips) && j.clips.length > 0) changed = true;
} catch {}
}
if (changed) refreshDrafts(0, false);
}, 15000);
return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
}, [drafts]);

async function refreshStats() {
try {
const r = await fetch('/api/stats');
if (!r.ok) return;
const j = await r.json().catch(() => null);
if (j) setStats(j);
} catch {}
}

async function refreshDrafts(offset = 0, append = false) {
try {
if (append) setLoadingMore(true);
const r = await fetch('/api/drafts?limit=' + PAGE_SIZE + '&offset=' + offset);
if (!r.ok) return;
const ct = r.headers.get('content-type') || '';
if (!ct.includes('application/json')) return;
const j = await r.json().catch(() => null);
const rows = toArray(j);
if (j && typeof j.total === 'number') setDraftsTotal(j.total);
setDraftsOffset(offset);
setDrafts((prev: any) => append ? [...(Array.isArray(prev) ? prev : []), ...rows] : rows);
} catch {} finally { setLoadingMore(false); }
}

async function deleteDraft(id: string) {
if (!id) return;
if (typeof window !== 'undefined' && !window.confirm('Delete this draft? This cannot be undone.')) return;
try {
const r = await fetch('/api/drafts?id=' + encodeURIComponent(id), { method: 'DELETE' });
if (r.ok) refreshDrafts();
} catch {}
}

async function editDraft(d: any) {
const current = (d && (d.topic || d.title || d.name)) || '';
const next = typeof window !== 'undefined' ? window.prompt('Edit draft name', String(current)) : null;
if (next == null) return;
const topic = next.trim();
if (!topic || topic === current) return;
try {
const r = await fetch('/api/drafts', {
method: 'PATCH',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ id: d.id || d._id, topic }),
});
if (r.ok) refreshDrafts();
} catch {}
}


function primaryBodyKey(pack: any): string {
if (!pack || typeof pack !== 'object') return 'content';
for (const k of ['blog', 'instagram', 'text', 'content', 'body', 'facebook', 'linkedin']) {
if (typeof pack[k] === 'string') return k;
}
for (const k of Object.keys(pack)) {
if (typeof pack[k] === 'string') return k;
}
return 'content';
}

function draftBody(d: any): string {
if (!d) return '';
if (typeof d.body === 'string') return d.body;
const pack = d.pack;
if (pack && typeof pack === 'object') {
const k = primaryBodyKey(pack);
if (typeof pack[k] === 'string') return pack[k];
}
if (typeof d.text === 'string') return d.text;
return '';
}

function startEditDraft(d: any) {
if (!d) return;
setEditTitle(String(d.topic || d.title || d.name || ''));
setEditBody(draftBody(d));
setEditingDraft(true);
}

async function saveDraftEdits() {
const d = selectedDraft;
if (!d) return;
const id = d.id || d._id;
if (!id) return;
const topic = editTitle.trim();
const basePack = (d.pack && typeof d.pack === 'object') ? { ...d.pack } : {};
const key = primaryBodyKey(d.pack);
basePack[key] = editBody;
setSavingEdit(true);
try {
const r = await fetch('/api/drafts', {
method: 'PATCH',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ id, topic: topic || (d.topic || 'Untitled'), pack: basePack }),
});
if (r.ok) {
const j = await r.json().catch(() => null);
const updated = (j && j.draft) ? j.draft : { ...d, topic: topic || d.topic, pack: basePack };
setSelectedDraft(updated);
setEditingDraft(false);
refreshDrafts();
}
} catch {} finally { setSavingEdit(false); }
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
setMStatus('Sent for review on ' + ok.join(', ') + ' — approve in Metricool to publish.');
} else if (ok.length === 0) {
setMStatus('Error: failed on ' + failed.join(', ') + '.');
} else {
setMStatus('Sent for review on ' + ok.join(', ') + '; failed on ' + failed.join(', ') + '.');
}
} catch (e: any) {
setMStatus('Error: ' + (e?.message || 'failed'));
}
}

async function clipVideo() {
setOpStatus(null); setOpBusy(true);
try {
// The server creates the gallery draft itself (keyed by the authoritative
// Opus projectId) and returns it, so there is no separate client draft
// insert to race against the webhook or to save an empty projectId.
const r = await fetch('/api/opus/clip', {
method: 'POST', headers: { 'content-type': 'application/json' },
body: JSON.stringify({ videoUrl: opUrl }),
});
const data = await r.json().catch(() => ({}));
if (!r.ok) throw new Error(data?.error || ('OpusClip failed ('+r.status+')'));
const projectId = (data && (data.projectId || (data.project && (data.project.projectId || data.project.id)))) || '';
setOpStatus(projectId ? 'Clip job started — processing…' : 'Clip job started.');

// Optimistically show the server-created draft immediately; otherwise fall
// back to a refresh so the new tile still appears.
if (data && data.draft) {
setDrafts((prev: any) => [data.draft, ...(Array.isArray(prev) ? prev : [])]);
}
setOpUrl('');
refreshDrafts();
refreshStats();
} catch (e: any) { setOpStatus('Error: ' + (e?.message || 'failed')); } finally { setOpBusy(false); }
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
<p className="mt-1 text-[15px] text-ink-muted">Create, schedule, and repurpose content — all in one place.</p>
</div>
<div className="flex items-center gap-2 lg:hidden">
{nav.map(n => (
<a key={n.href} href={n.href} className={'rounded-full px-3.5 py-1.5 text-[13px] font-medium ' + (n.current ? 'bg-ink text-white' : 'bg-white text-ink-muted shadow-soft')}>{n.label}</a>
))}
</div>
</header>

{/* Onboarding "How this works" strip — dismissible, remembered per browser */}
{showOnboard && (
<section className="mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
<div className="flex items-center justify-between border-b border-line px-6 py-4 sm:px-8">
<div>
<h2 className="text-[15px] font-semibold text-ink">How this works</h2>
<p className="mt-0.5 text-[12px] text-ink-muted">A quick tour of the create → repurpose → schedule flow.</p>
</div>
<button type="button" onClick={dismissOnboard}
className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">Got it, hide this</button>
</div>
<div className="grid gap-3 p-6 sm:grid-cols-2 sm:p-8 lg:grid-cols-4">
{ONBOARD_STEPS.map((s) => (
<div key={s.title} className="rounded-2xl bg-subtle/60 p-4 ring-1 ring-line">
<div className="text-[13px] font-semibold text-ink">{s.title}</div>
<p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{s.body}</p>
</div>
))}
</div>
</section>
)}

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
<div className="flex items-center gap-2">
<span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Step 1 · Create</span>
<h2 className="text-headline font-semibold">Content Generator</h2>
</div>
<p className="mt-1 text-[13px] text-ink-muted">Turn an idea into a ready-to-post pack — pick a model and format, describe your idea, then Generate.</p>
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
{loading ? 'Generating...' : 'Generate'}
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
<pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-2xl bg-white p-4 text-[13px] leading-relaxed text-ink-soft ring-1 ring-line">{typeof output === 'string' ? output : JSON.stringify(output, null, 2)}</pre>
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
<div className="flex items-center gap-2">
<span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Step 3 · Schedule</span>
<h2 className="text-headline font-semibold">Analytics &amp; Scheduling</h2>
</div>
<span className="rounded-full bg-subtle px-2.5 py-1 text-[11px] font-medium text-ink-muted ring-1 ring-line">Metricool</span>
</div>
<p className="mb-4 text-[13px] text-ink-muted">Check performance, then queue a post — it goes to Metricool for your review before it publishes. Brand: Cellular Hope Institute · blogId 4308292</p>

<button onClick={loadAnalytics} disabled={mLoading}
className="mb-4 rounded-full bg-ink px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">
{mLoading ? 'Loading...' : 'Load latest analytics'}
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
<button type="button" key="facebook" onClick={() => toggleNetwork("facebook")} aria-pressed={mNetworks.includes("facebook")}
className={"rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " + (mNetworks.includes("facebook") ? "bg-accent text-white ring-accent" : "bg-subtle text-ink ring-line hover:ring-accent/50")}>Facebook</button>
<button type="button" key="instagram" onClick={() => toggleNetwork("instagram")} aria-pressed={mNetworks.includes("instagram")}
className={"rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " + (mNetworks.includes("instagram") ? "bg-accent text-white ring-accent" : "bg-subtle text-ink ring-line hover:ring-accent/50")}>Instagram</button>
<button type="button" key="linkedin" onClick={() => toggleNetwork("linkedin")} aria-pressed={mNetworks.includes("linkedin")}
className={"rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " + (mNetworks.includes("linkedin") ? "bg-accent text-white ring-accent" : "bg-subtle text-ink ring-line hover:ring-accent/50")}>LinkedIn</button>
<button type="button" key="twitter" onClick={() => toggleNetwork("twitter")} aria-pressed={mNetworks.includes("twitter")}
className={"rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " + (mNetworks.includes("twitter") ? "bg-accent text-white ring-accent" : "bg-subtle text-ink ring-line hover:ring-accent/50")}>X / Twitter</button>
</div>
<input type="datetime-local" value={mDate} onChange={e => setMDate(e.target.value)}
className="rounded-xl bg-subtle px-3 py-2 text-[13px] text-ink ring-1 ring-line focus:ring-accent" />
</div>
<textarea value={mText} onChange={e => setMText(e.target.value)} rows={3} placeholder="Post text..."
className="mb-3 w-full resize-none rounded-2xl bg-subtle p-3 text-[14px] text-ink ring-1 ring-line placeholder:text-ink-faint focus:ring-accent" />
<div className="flex items-center gap-3">
<button onClick={schedulePost} className="rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white shadow-soft transition-colors hover:bg-accent-hover">Send to Metricool for review</button>
{mStatus && <span className={'text-[12px] ' + (mStatus.startsWith('Error') ? 'text-danger' : 'text-ink-muted')}>{mStatus}</span>}
</div>
<p className="mt-2 text-[11px] text-ink-faint">Nothing publishes automatically — you approve the final post inside Metricool.</p>
</div>
</div>

{/* OpusClip */}
<div className="rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7">
<div className="mb-1 flex items-center justify-between">
<div className="flex items-center gap-2">
<span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Step 2 · Repurpose</span>
<h2 className="text-headline font-semibold">Long-form to Shorts</h2>
</div>
<span className="rounded-full bg-subtle px-2.5 py-1 text-[11px] font-medium text-ink-muted ring-1 ring-line">OpusClip</span>
</div>
<p className="mb-4 text-[13px] text-ink-muted">Turn one long video into several short vertical clips — paste a YouTube or Vimeo URL to start.</p>
<input value={opUrl} onChange={e => setOpUrl(e.target.value)} placeholder="https://youtube.com/watch?v=..."
className="mb-3 w-full rounded-2xl bg-subtle px-4 py-3 text-[14px] text-ink ring-1 ring-line placeholder:text-ink-faint focus:ring-accent" />
<div className="flex items-center gap-3">
<button onClick={clipVideo} disabled={opBusy || !opUrl.trim()}
className="rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white shadow-soft transition-colors hover:bg-accent-hover disabled:opacity-40">{opBusy ? 'Starting…' : 'Generate clips'}</button>
{opStatus && <span className={'text-[12px] ' + (opStatus.startsWith('Error') ? 'text-danger' : 'text-ink-muted')}>{opStatus}</span>}
</div>
<p className="mt-3 text-[12px] text-ink-faint">Clips render in the background and appear under Recent Drafts when ready — use “Refresh clips” there to check on them.</p>
</div>
</section>


{/* Recent Drafts */}
<section className="rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7">
<h2 className="mb-4 text-headline font-semibold">Recent Drafts</h2>
{/* Clips from Opus — long-form to Shorts */}
{(() => {
const opusClips = safeDrafts.filter((d: any) => d?.pack?.kind === 'clip');
if (opusClips.length === 0) return null;
return (
<div className="mb-6">
<div className="mb-3 flex items-center gap-2">
<h3 className="text-[15px] font-semibold text-ink">Clips from Opus</h3>
<span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-line">{opusClips.length}</span>
<span className="text-[12px] text-ink-faint">Long-form to Shorts</span>
<button type="button" onClick={refreshClips} disabled={refreshingClips}
className="ml-auto rounded-full bg-subtle px-3 py-1 text-[12px] font-medium text-ink ring-1 ring-line transition hover:bg-white disabled:opacity-40">
{refreshingClips ? 'Refreshing…' : 'Refresh clips'}
</button>
</div>
<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
{opusClips.map((d: any, i: number) => {
const ready = d?.pack?.status === 'ready' && clipsOf(d).length > 0;
const failed = d?.pack?.status === 'failed';
const count = clipsOf(d).length;
return (
<button key={(d?.id || d?._id || i) + '-opus'} onClick={() => setSelectedDraft(d)}
className="group overflow-hidden rounded-2xl text-left ring-1 ring-line/60 transition hover:ring-black/20">
<div className="relative">
{d?.pack?.thumb ? (
// eslint-disable-next-line @next/next/no-img-element
<img src={d.pack.thumb} alt="Clip still" className="h-28 w-full object-cover" />
) : (
<div className="flex h-28 w-full items-center justify-center bg-subtle text-[12px] text-ink-faint">Clip</div>
)}
<div className="absolute left-2 top-2">
{ready ? (
<span className="rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white">{count} clip{count === 1 ? '' : 's'}</span>
) : failed ? (
<span className="rounded-full bg-danger/90 px-2 py-0.5 text-[10px] font-semibold text-white">Failed</span>
) : (
<span className="rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">Processing…</span>
)}
</div>
<div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition group-hover:opacity-100">
<span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/90 text-ink shadow-card">▶</span>
</div>
</div>
<div className="truncate px-3 py-2 text-[12px] font-medium text-ink">{String(d?.topic || d?.title || 'Clip')}</div>
</button>
);
})}
</div>
</div>
);
})()}
{safeDrafts.length === 0 ? (
<div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line py-12 text-center">
<div className="text-[14px] font-medium text-ink-muted">No drafts yet</div>
<div className="mt-1 text-[12px] text-ink-faint">Generate something above to get started.</div>
</div>
) : (
<>
<ul className="divide-y divide-line">
{safeDrafts.map((d, i) => {
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
<div className="ml-auto flex shrink-0 items-center gap-1 self-center">
<button type="button" aria-label="Edit draft" onClick={(e) => { e.stopPropagation(); editDraft(d); }}
className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">Edit</button>
<button type="button" aria-label="Delete draft" onClick={(e) => { e.stopPropagation(); deleteDraft((d && (d.id || d._id)) || ''); }}
className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-red-600 ring-1 ring-red-200 transition hover:bg-red-50">Delete</button>
</div>
</li>
);
})}
</ul>
{draftsTotal > safeDrafts.length && (
<div className="mt-5 flex justify-center">
<button type="button" onClick={() => refreshDrafts(draftsOffset + PAGE_SIZE, true)} disabled={loadingMore}
className="rounded-full bg-subtle px-5 py-2 text-[13px] font-medium text-ink ring-1 ring-line transition hover:bg-white disabled:opacity-40">
{loadingMore ? 'Loading…' : 'Load more (' + (draftsTotal - safeDrafts.length) + ' more)'}
</button>
</div>
)}
</>
)}
</section>


{/* Draft detail modal — click a draft to view / play / edit */}
{selectedDraft ? (
<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => { setSelectedDraft(null); setEditingDraft(false); }}>
<div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7" onClick={(e) => e.stopPropagation()}>
<div className="mb-4 flex items-start justify-between gap-4">
{editingDraft ? (
<input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="Draft title"
className="min-w-0 flex-1 rounded-xl bg-subtle px-3 py-2 text-[16px] font-semibold text-ink ring-1 ring-line focus:ring-accent" />
) : (
<h3 className="text-headline font-semibold text-ink">{String(selectedDraft?.title || selectedDraft?.topic || selectedDraft?.name || 'Draft')}</h3>
)}
<div className="flex shrink-0 items-center gap-2">
{selectedDraft?.pack?.kind !== 'clip' && !editingDraft ? (
<button onClick={() => startEditDraft(selectedDraft)} className="rounded-xl px-3 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">Edit</button>
) : null}
<button onClick={() => { setSelectedDraft(null); setEditingDraft(false); }} className="rounded-xl px-3 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">Close</button>
</div>
</div>
{selectedDraft?.pack?.kind === 'clip' ? (
(() => {
const clips = clipsOf(selectedDraft);
if (clips.length > 0) {
return (
<div className="space-y-5">
{clips.map((c: Clip, ci: number) => (
<div key={c.id || ci} className="overflow-hidden rounded-2xl ring-1 ring-line/60">
<video controls preload="metadata" poster={selectedDraft?.pack?.thumb || undefined} src={c.preview || c.export}
className="aspect-video w-full bg-black" />
<div className="p-3">
<div className="flex items-center justify-between gap-3">
<div className="truncate text-[13px] font-semibold text-ink">{c.title || ('Clip ' + (ci + 1))}</div>
<span className="shrink-0 text-[11px] text-ink-faint">{fmtDuration(c.durationMs)}</span>
</div>
{c.description ? <p className="mt-1 line-clamp-2 text-[12px] text-ink-muted">{c.description}</p> : null}
{c.hashtags ? <p className="mt-1 truncate text-[11px] text-accent">{c.hashtags}</p> : null}
<div className="mt-2 flex items-center gap-2">
{c.export ? (
<a href={c.export} target="_blank" rel="noopener noreferrer"
className="rounded-full bg-ink px-3 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90">Download</a>
) : null}
</div>
</div>
</div>
))}
</div>
);
}
if (selectedDraft?.pack?.status === 'failed') {
return (<div className="rounded-2xl border border-dashed border-line p-6 text-center text-[13px] text-ink-muted">This clip job failed to render. Try submitting the video again.</div>);
}
return (
<div className="rounded-2xl border border-dashed border-line p-8 text-center">
<div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
<div className="text-[14px] font-medium text-ink-muted">Clips are still rendering</div>
<div className="mt-1 text-[12px] text-ink-faint">This can take a few minutes. They&apos;ll appear here automatically when ready.</div>
</div>
);
})()
) : editingDraft ? (
<div>
<textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={14} placeholder="Draft content..."
className="w-full resize-y rounded-2xl bg-subtle/50 p-4 text-[14px] leading-relaxed text-ink ring-1 ring-line/60 focus:ring-accent" />
<div className="mt-4 flex items-center gap-3">
<button onClick={saveDraftEdits} disabled={savingEdit} className="rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white shadow-soft transition-colors hover:bg-accent-hover disabled:opacity-40">{savingEdit ? 'Saving...' : 'Save changes'}</button>
<button onClick={() => setEditingDraft(false)} disabled={savingEdit} className="rounded-full px-4 py-2 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle disabled:opacity-40">Cancel</button>
</div>
</div>
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
