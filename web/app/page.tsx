'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

// Networks we can publish to through Metricool, with display labels. These map
// to the providers supported by /api/metricool/schedule.
const PUBLISH_NETWORKS: { id: string; label: string }[] = [
{ id: 'facebook', label: 'Facebook' },
{ id: 'instagram', label: 'Instagram' },
{ id: 'linkedin', label: 'LinkedIn' },
{ id: 'twitter', label: 'X / Twitter' },
];

// Seed topics for the Trending in stem cell therapy panel. These are a curated
// starting set the team controls — NOT scraped live — and only ever pre-fill the
// generator prompt for a human to review. Editable in the UI and remembered per
// browser via localStorage.
const DEFAULT_TRENDING: string[] = [
'Exosome therapy for joint recovery',
'Stem cells and sports injury rehab',
'Regenerative medicine for knee osteoarthritis',
'PRP vs stem cell treatment explained',
'Anti-aging and cellular regeneration',
'Stem cell safety and what to ask your provider',
];
const TRENDING_KEY = 'chi_trending_topics_v1';

// Where a Metricool brand's planner lives, so we can deep-link a queued post
// straight to the place it gets approved.
const METRICOOL_BLOG_ID = '4308292';
function metricoolPlannerUrl(): string {
  return 'https://app.metricool.com/planner?blogId=' + METRICOOL_BLOG_ID + '&userId=3377431';eturn 'https://app.metricool.com/planning/list?blogId=' + METRICOOL_BLOG_ID;
}

// Human-readable status for a scheduled post row from /api/posts.
function postStatusMeta(status: string): { label: string; tone: string } {
const s = String(status || '').toLowerCase();
if (s === 'pending_review' || s === 'draft' || s === 'pending') return { label: 'Waiting for your approval', tone: 'amber' };
if (s === 'scheduled' || s === 'queued') return { label: 'Scheduled', tone: 'blue' };
if (s === 'published' || s === 'sent' || s === 'live') return { label: 'Published', tone: 'green' };
if (s === 'failed' || s === 'error' || s === 'rejected') return { label: 'Needs attention', tone: 'red' };
return { label: status || 'Unknown', tone: 'gray' };
}


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

const OPUS_ASPECTS: { value: string; label: string }[] = [
{ value: '9:16', label: '9:16 · Reels / Shorts / TikTok' },
{ value: '1:1', label: '1:1 · Square' },
{ value: '4:5', label: '4:5 · Feed' },
{ value: '16:9', label: '16:9 · Landscape' },
];

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

// Friendly date/time for a scheduled post, e.g. "Aug 3, 9:00 AM".
function fmtDateTime(input: any): string {
try {
const d = new Date(input);
if (isNaN(d.getTime())) return String(input || '');
return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
} catch { return String(input || ''); }
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
const [mBusy, setMBusy] = useState(false);
  const [mAutoPublish, setMAutoPublish] = useState(false);
  const [mMedia, setMMedia] = useState<string>("");
  const [mMediaLabel, setMMediaLabel] = useState<string>("");
  function platformsForFormat(fmt: string): string[] {
    if (fmt === "video") return ["instagram", "facebook"];
    if (fmt === "blog" || fmt === "email") return ["linkedin", "facebook"];
    return ["instagram", "facebook", "linkedin"];
  }
  function scrollToPublisher() {
    if (typeof document !== "undefined") { const el = document.getElementById("section-publish"); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }
  function prefillComposerFromDraft(d: any) {
    try {
      const fmt = String((d && d.pack && d.pack.format) || (d && d.format) || "social");
      const secs = formatSections(d && d.pack);
      const body = secs.length ? secs.map((s: any) => s.text).join("\n\n") : (typeof (d && d.pack) === "string" ? d.pack : "");
      if (body) setMText(body);
      setMMedia(""); setMMediaLabel("");
      setMNetworks(platformsForFormat(fmt).filter((n) => PUBLISH_NETWORKS.some((p) => p.id === n)));
      setMAutoPublish(false);
      setMStatus(null);
      setSelectedDraft(null); setEditingDraft(false);
      scrollToPublisher();
    } catch {}
  }
  function prefillComposerFromClip(c: any) {
    try {
      const caption = cleanCaption(String((c && c.description) || (c && c.text) || ""));
      const tags = String((c && c.hashtags) || "").trim();
      const media = String((c && c.export) || (c && c.preview) || "");
      setMText([caption, tags].filter(Boolean).join("\n\n"));
      setMMedia(media);
      setMMediaLabel(String((c && c.title) || "Clip video"));
      setMNetworks(["instagram", "facebook"].filter((n) => PUBLISH_NETWORKS.some((p) => p.id === n)));
      setMAutoPublish(false);
      setMStatus(null);
      setSelectedDraft(null); setEditingDraft(false);
      scrollToPublisher();
    } catch {}
  }
  // --- Comprehensive Publishing panel state (brand switcher + live insights) ---
  const [activeBlogId, setActiveBlogId] = useState<string>('4308292');
  const [insights, setInsights] = useState<any>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  async function loadInsights(blogId: string) {
    try {
      setInsightsLoading(true);
      const r = await fetch('/api/metricool/insights?blogId=' + encodeURIComponent(blogId));
      const j = await r.json().catch(() => null);
      setInsights(j);
    } catch {
      setInsights(null);
    } finally {
      setInsightsLoading(false);
    }
  }

  // --- AI Research & Draft Copilot state ---
  const [researchTopicText, setResearchTopicText] = useState('');
  const [researchNetwork, setResearchNetwork] = useState('instagram');
  const [research, setResearch] = useState<any>(null);
  const [researchLoading, setResearchLoading] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);

  async function runResearch() {
    const topic = researchTopicText.trim();
    if (!topic || researchLoading) return;
    setResearchLoading(true);
    setResearchError(null);
    const doFetch = () => fetch('/api/metricool/ai-research', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, provider, network: researchNetwork }),
    });
    try {
      let res = await doFetch();
      if (res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500));
        res = await doFetch();
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResearch(null);
        setResearchError(j && j.error === 'unauthorized' ? 'Please sign in to run AI research.' : ((j && j.error) || 'Research is taking longer than usual. Please try again in a moment.'));
      } else {
        setResearch(j);
      }
    } catch {
      setResearch(null);
      setResearchError('Research failed. Please check your connection and try again.');
    } finally {
      setResearchLoading(false);
    }
  }


// Scheduled / pending-review queue, backed by GET /api/posts. Surfacing this
// is what makes "sent for review" concrete: the post shows up here with its
// status and a link to approve it in Metricool.
const [posts, setPosts] = useState<any[]>([]);
const [postsLoading, setPostsLoading] = useState(false);
const [rescheduleId, setRescheduleId] = useState<string | null>(null);
const [rescheduleAt, setRescheduleAt] = useState('');

// Trending stem-cell topics: a curated, editable list (not scraped) that only
// pre-fills the generator prompt for a human to review before anything is made.
const [trending, setTrending] = useState<string[]>(DEFAULT_TRENDING);
const [newTrend, setNewTrend] = useState('');

const [opUrl, setOpUrl] = useState('');
const [opStatus, setOpStatus] = useState<string | null>(null);
const [opBusy, setOpBusy] = useState(false);
const [opTitle, setOpTitle] = useState('');
const [opLang, setOpLang] = useState('en');
const [opAspect, setOpAspect] = useState('9:16');

const [selectedDraft, setSelectedDraft] = useState<any>(null);
const [editingDraft, setEditingDraft] = useState(false);
const [editTitle, setEditTitle] = useState('');
const [editBody, setEditBody] = useState('');
const [savingEdit, setSavingEdit] = useState(false);

// "How this works" onboarding strip — collapsible. The header stays
// visible so viewers can always reopen it; the collapsed/expanded
// preference is remembered per browser via localStorage.
  const [onboardOpen, setOnboardOpen] = useState(true);
  useEffect(() => {
    try {
      if (typeof window !== 'undefined' && window.localStorage.getItem(ONBOARD_KEY) === '0') setOnboardOpen(false);
    } catch {}
  }, []);
  function toggleOnboard() {
    setOnboardOpen((open) => {
      const next = !open;
      try { if (typeof window !== 'undefined') window.localStorage.setItem(ONBOARD_KEY, next ? '1' : '0'); } catch {}
      return next;
    });
  }

// Load any saved trending topics on mount.
useEffect(() => {
try {
if (typeof window === 'undefined') return;
const raw = window.localStorage.getItem(TRENDING_KEY);
if (raw) { const arr = JSON.parse(raw); if (Array.isArray(arr) && arr.length) setTrending(arr.map(String)); }
} catch {}
}, []);
function persistTrending(next: string[]) {
setTrending(next);
try { if (typeof window !== 'undefined') window.localStorage.setItem(TRENDING_KEY, JSON.stringify(next)); } catch {}
}
function addTrend() {
const t = newTrend.trim();
if (!t) return;
if (trending.some((x) => x.toLowerCase() === t.toLowerCase())) { setNewTrend(''); return; }
persistTrending([t, ...trending].slice(0, 24));
setNewTrend('');
}
function removeTrend(t: string) { persistTrending(trending.filter((x) => x !== t)); }
function applyTrend(t: string) {
setPrompt(t);
setType('social');
try { if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
}

  // Smooth-scroll the "How this works" cards to the matching section below,
  // and briefly highlight it so the viewer sees where they landed.
  const STEP_ANCHORS = ['section-create', 'section-repurpose', 'section-publish', 'section-library'];
  function scrollToStep(i: number) {
    try {
      const el = typeof document !== 'undefined' ? document.getElementById(STEP_ANCHORS[i]) : null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('ring-2', 'ring-accent');
        setTimeout(() => { el.classList.remove('ring-2', 'ring-accent'); }, 1600);
      }
    } catch {}
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

// On mount: load drafts, stats, the scheduled-posts queue, and (best-effort)
// the latest analytics so the Publishing panel is populated without a click.
useEffect(() => { refreshDrafts(); refreshStats(); refreshPosts(); loadAnalytics(true); warmClips(); }, []);


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
}, 5000);
return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
}, [drafts]);

  // Keep the open draft detail in sync as drafts refresh, so clips appear the
  // instant Opus finishes rendering without needing to close and reopen.
  useEffect(() => {
    if (!selectedDraft) return;
    const list = Array.isArray(drafts) ? drafts : [];
    const key = (x: any) => (x && (x.id ?? x._id));
    const fresh = list.find((d: any) => d && key(d) === key(selectedDraft));
    if (fresh && fresh !== selectedDraft && JSON.stringify(fresh) !== JSON.stringify(selectedDraft)) {
      setSelectedDraft(fresh);
    }
  }, [drafts]);

  // Open a draft and, if it is a still-rendering clip job, immediately check
  // Opus once instead of waiting for the next poll tick.
  async function openDraft(d: any) {
    setSelectedDraft(d);
    setEditingDraft(false);
    try {
      if (d && d.pack && d.pack.kind === 'clip' && d.pack.projectId && d.pack.status !== 'ready' && d.pack.status !== 'failed') {
        const r = await fetch('/api/opus/clip?projectId=' + encodeURIComponent(d.pack.projectId));
        if (r.ok) {
          const j = await r.json().catch(() => null);
          if (j && j.status === 'ready' && Array.isArray(j.clips) && j.clips.length > 0) refreshDrafts(0, false);
        }
      }
    } catch {}
  }

  // Pre-warm every real clip job on load so opening a draft is instant. We fetch
  // the current drafts directly (not state, which may be empty at mount) and, for
  // each clip draft with an Opus projectId that isn't ready yet, ask the API once
  // in parallel; the API persists the clips onto the draft for an instant open.
  async function warmClips() {
    try {
      const lr = await fetch('/api/drafts?limit=100&offset=0');
      if (!lr.ok) return;
      const lj = await lr.json().catch(() => null);
      const list = Array.isArray(lj) ? lj : (lj && (lj.drafts || lj.data || lj.rows)) || [];
      const pending = list.filter(
        (d: any) => d && d.pack && d.pack.kind === 'clip' && d.pack.projectId && d.pack.status !== 'ready' && d.pack.status !== 'failed'
      );
      if (pending.length === 0) return;
      let any = false;
      await Promise.all(
        pending.map(async (d: any) => {
          try {
            const r = await fetch('/api/opus/clip?projectId=' + encodeURIComponent(d.pack.projectId));
            if (!r.ok) return;
            const j = await r.json().catch(() => null);
            if (j && j.status === 'ready' && Array.isArray(j.clips) && j.clips.length > 0) any = true;
          } catch {}
        })
      );
      if (any) refreshDrafts(0, false);
    } catch {}
  }

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

// Pull the current user's scheduled posts (GET /api/posts). Ordered soonest
// first by the API; we keep that order for the queue.
async function refreshPosts() {
setPostsLoading(true);
try {
const r = await fetch('/api/posts');
if (!r.ok) return;
const j = await r.json().catch(() => null);
const rows = (j && Array.isArray(j.posts)) ? j.posts : toArray(j);
setPosts(Array.isArray(rows) ? rows : []);
} catch {} finally { setPostsLoading(false); }
}

// Reschedule a queued post via PATCH /api/posts (updates publication_date).
async function saveReschedule(id: string) {
if (!id || !rescheduleAt) return;
let iso = rescheduleAt;
try { const d = new Date(rescheduleAt); if (!isNaN(d.getTime())) iso = d.toISOString(); } catch {}
try {
const r = await fetch('/api/posts', {
method: 'PATCH',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ id, publication_date: iso }),
});
if (r.ok) { setRescheduleId(null); setRescheduleAt(''); refreshPosts(); }
} catch {}
}

async function deleteDraft(id: string) {
if (!id) return;
if (typeof window !== 'undefined' && !window.confirm('Delete this draft? This cannot be undone.')) return;
try {
const r = await fetch('/api/drafts?id=' + encodeURIComponent(id), { method: 'DELETE' });
if (r.ok) refreshDrafts();
} catch {}
}

function cleanCaption(s: string): string {
    return String(s || "").replace(/__\w+/g, " ").replace(/\s+/g, " ").trim();
  }
  function friendlyGenError(msg: string): string {
    const m = String(msg || "");
    if (/credit_balance_exhausted|insufficient_quota|billing/i.test(m)) return "OpenAI is out of API credits. Add credits to your OpenAI account, or switch the model to Claude (Anthropic) to keep generating.";
    if (/\b429\b|rate.?limit/i.test(m)) return "The AI provider is rate-limited right now. Wait a moment and try again, or switch to Claude (Anthropic).";
    if (/401|invalid.?api.?key|unauthor/i.test(m)) return "The AI provider rejected the API key. Check the provider configuration, or switch to Claude (Anthropic).";
    return m.length > 200 ? m.slice(0, 200) + "…" : m;
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

// Format-aware rendering. Generation always returns the same 4 pack keys
// (instagram/facebook/linkedin/blog); the MEANING of the primary field changes
// per format. formatMeta maps the stored pack.format to the right primary key,
// a human label, and a one-line description so email/video/ad render faithfully
// instead of being mislabeled as INSTAGRAM/BLOG.
function formatMeta(pack: any): { key: string; label: string; lead: string } {
  const f = pack && typeof pack === 'object' ? String(pack.format || '') : '';
  if (f === 'email') return { key: 'blog', label: 'EMAIL CAMPAIGN', lead: 'Subject line, preview text and body' };
  if (f === 'video') return { key: 'blog', label: 'VIDEO SCRIPT', lead: 'Hook, scenes and call-to-action' };
  if (f === 'ad') return { key: 'blog', label: 'AD COPY', lead: 'Headline variations, primary text and CTA' };
  if (f === 'blog') return { key: 'blog', label: 'BLOG ARTICLE', lead: 'Long-form article' };
  return { key: '', label: '', lead: '' };
}
function formatSections(pack: any): { label: string; text: string }[] {
  if (!pack || typeof pack !== 'object') return [];
  const meta = formatMeta(pack);
  const out: { label: string; text: string }[] = [];
  const socials: [string, string][] = [['instagram','INSTAGRAM'],['facebook','FACEBOOK'],['linkedin','LINKEDIN']];
  if (meta.key && typeof pack[meta.key] === 'string' && String(pack[meta.key]).trim()) {
    out.push({ label: meta.label, text: String(pack[meta.key]) });
    const socialLabel = String(pack.format) === 'blog' ? 'PROMO POST' : 'SOCIAL TEASER';
    for (const [k, lbl] of socials) {
      if (typeof pack[k] === 'string' && String(pack[k]).trim()) out.push({ label: socialLabel + ' \u00b7 ' + lbl, text: String(pack[k]) });
    }
    return out;
  }
  for (const [k, lbl] of [...socials, ['blog','BLOG']] as [string, string][]) {
    if (typeof pack[k] === 'string' && String(pack[k]).trim()) out.push({ label: lbl, text: String(pack[k]) });
  }
  return out;
}
function formatOutputString(pack: any): string {
  const secs = formatSections(pack);
  if (!secs.length) return '';
  return secs.map((s) => s.label + '\n' + s.text).join('\n\n');
}

function draftBody(d: any): string {
if (!d) return '';
if (typeof d.body === 'string') return d.body;
const pack = d.pack;
if (pack && pack.kind === 'clip') return typeof pack.caption === 'string' ? pack.caption : '';
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
const isClip = d.pack && d.pack.kind === 'clip';
const key = isClip ? 'caption' : primaryBodyKey(d.pack);
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
setOutput(formatOutputString({ ...pack, format: type }));
try {
await fetch('/api/drafts', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ topic: prompt, pack: { ...pack, format: type }, provider }),
});
} catch {}
refreshDrafts();
} catch (e: any) { setErr(friendlyGenError(e?.message || 'Generation failed')); } finally { setLoading(false); }
}

// Load analytics from GET /api/metricool. When silent (mount auto-load), we do
// not surface an error banner if credentials are not configured yet.
async function loadAnalytics(silent = false) {
setMLoading(true); if (!silent) setMStatus(null);
try {
const r = await fetch('/api/metricool?blogId=' + METRICOOL_BLOG_ID);
const data = await r.json().catch(() => ({}));
if (!r.ok) throw new Error(data?.error || ('Metricool fetch failed ('+r.status+')'));
setMAnalytics(data);
} catch (e: any) { if (!silent) setMStatus('Error: ' + (e?.message || 'failed')); } finally { setMLoading(false); }
}


async function schedulePost() {
if (!mNetworks.length) { setMStatus('Pick at least one network.'); return; }
if (!mDate) { setMStatus('Pick a date & time.'); return; }
if (!mText.trim()) { setMStatus('Write the post text first.'); return; }
setMStatus(null); setMBusy(true);
try {
const results = await Promise.all(
mNetworks.map(async (network) => {
const r = await fetch('/api/metricool/schedule', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ network, text: mText, publishAt: mDate, blogId: METRICOOL_BLOG_ID, autoPublish: mAutoPublish, mediaUrl: mMedia || undefined }),
});
const data = await r.json().catch(() => ({}));
return { network, ok: r.ok, status: r.status, data };
})
);
const ok = results.filter((x) => x.ok).map((x) => x.network);
const failed = results.filter((x) => !x.ok).map((x) => x.network);
if (failed.length === 0) {
setMStatus(mAutoPublish ? ('Published now on ' + ok.join(', ') + ' via Metricool.') : ('Saved to Metricool as a draft on ' + ok.join(', ') + ' — approve it there to publish.'));
setMText('');
} else if (ok.length === 0) {
setMStatus('Error: failed on ' + failed.join(', ') + '.');
} else {
setMStatus('Saved on ' + ok.join(', ') + '; failed on ' + failed.join(', ') + '.');
}
refreshPosts();
refreshStats();
} catch (e: any) {
setMStatus('Error: ' + (e?.message || 'failed'));
} finally { setMBusy(false); }
}

async function clipVideo() {
setOpStatus(null); setOpBusy(true);
try {
// The server creates the gallery draft itself (keyed by the authoritative
// Opus projectId) and returns it, so there is no separate client draft
// insert to race against the webhook or to save an empty projectId.
const r = await fetch('/api/opus/clip', {
method: 'POST', headers: { 'content-type': 'application/json' },
body: JSON.stringify({ videoUrl: opUrl, title: opTitle.trim() || undefined, language: opLang }),
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
const safePosts = Array.isArray(posts) ? posts : [];
const pendingReviewCount = safePosts.filter((p: any) => postStatusMeta(p?.status).label === 'Waiting for your approval').length;
const metrics = metricoolMetrics(mAnalytics);
const activeType = CONTENT_TYPES.find(t => t.id === type)!;

const statCards = [
{ label: 'Drafts', value: (stats && (stats.drafts ?? stats.draftsCount)) ?? safeDrafts.length ?? 0 },
{ label: 'Scheduled posts', value: (stats && (stats.scheduled ?? stats.scheduledCount)) ?? safePosts.length ?? 0 },
{ label: 'Awaiting approval', value: pendingReviewCount },
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
      {(
        <section className="mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
          <div className="flex items-center justify-between border-b border-line px-6 py-4 sm:px-8">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">How this works</h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">A quick tour of the create → repurpose → schedule flow.</p>
            </div>
            <button type="button" onClick={toggleOnboard} aria-expanded={onboardOpen}
              className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">
              {onboardOpen ? 'Hide guide' : 'Show guide'}
            </button>
          </div>
          {onboardOpen && (
            <div className="grid gap-3 p-6 sm:grid-cols-2 sm:p-8 lg:grid-cols-4">
              {ONBOARD_STEPS.map((s, i) => (
                <button key={s.title} type="button" onClick={() => scrollToStep(i)} className="cursor-pointer rounded-2xl bg-subtle/60 p-4 text-left ring-1 ring-line transition hover:bg-white hover:ring-accent">
                  <div className="text-[13px] font-semibold text-ink">{s.title}</div>
                  <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{s.body}</p>
                </button>
              ))}
            </div>
          )}
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
<section id="section-create" className="mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
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
<div className="mb-2 flex items-center justify-between">
<label className="block text-[12px] font-medium uppercase tracking-wide text-ink-muted">Trending in stem cell therapy</label>
<span className="text-[11px] text-ink-faint">Tap one to start · a person always reviews before anything posts</span>
</div>
<div className="flex flex-wrap gap-2">
{trending.slice(0, 12).map((t) => (
<span key={t} className="group inline-flex items-center gap-1 rounded-full bg-subtle px-3 py-1.5 text-[12px] font-medium text-ink ring-1 ring-line">
<button type="button" onClick={() => applyTrend(t)} className="transition hover:text-accent">{t}</button>
<button type="button" aria-label={'Remove ' + t} onClick={() => removeTrend(t)} className="text-ink-faint opacity-0 transition group-hover:opacity-100 hover:text-danger">×</button>
</span>
))}
</div>
<div className="mt-2 flex items-center gap-2">
<input value={newTrend} onChange={(e) => setNewTrend(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTrend(); } }}
placeholder="Add a trending topic to track…"
className="min-w-0 flex-1 rounded-full bg-subtle px-3 py-1.5 text-[12px] text-ink ring-1 ring-line placeholder:text-ink-faint focus:ring-accent" />
<button type="button" onClick={addTrend} className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90">Add</button>
</div>
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
{loading ? (<><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />Generating…</>) : 'Generate'}
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


{/* Publishing (Metricool) — compose, review flow, and live queue */}
<section id="section-publish" className="mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
<div className="border-b border-line px-6 py-5 sm:px-8">
<div className="flex flex-wrap items-center justify-between gap-3">
<div className="flex items-center gap-3">
<span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-2xl bg-accent/10 text-accent text-[18px]">📣</span>
<div>
<span className="mb-1 inline-block rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Step 3 · Schedule</span><h2 className="text-[18px] font-semibold text-ink">Publishing</h2>
<p className="text-[13px] text-ink-muted">Plan, schedule, and track your posts across every channel.</p>
</div>
</div>
<div className="flex items-center gap-2">
{(() => {
const brands = mAnalytics && Array.isArray(mAnalytics.data) ? mAnalytics.data.filter((b: any) => b && (b.label || b.title)) : [];
if (brands.length <= 1) return <span className="rounded-full bg-white px-3 py-1 font-medium text-ink ring-1 ring-line text-[12px]">Powered by Metricool</span>;
return (
<label className="flex items-center gap-2 text-[12px] text-ink-muted">Brand
<select value={activeBlogId} onChange={(e) => { setActiveBlogId(e.target.value); loadInsights(e.target.value); }} className="rounded-full bg-white px-3 py-1.5 text-[13px] font-medium text-ink ring-1 ring-line focus:ring-accent">
{brands.map((b: any) => <option key={String(b.id)} value={String(b.id)}>{b.label || b.title}</option>)}
</select>
</label>
);
})()}
</div>
</div>
<div className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 ring-1 ring-emerald-100">
<p className="text-[13px] text-emerald-900"><span className="font-semibold">Nothing is ever posted automatically.</span> You write it here, send it for review, and give the final approval yourself inside Metricool.</p>
</div>
<ol className="mt-4 grid gap-3 sm:grid-cols-3">
<li className="rounded-2xl bg-white p-3 ring-1 ring-line"><div className="text-[12px] font-semibold text-accent">Write</div><div className="mt-0.5 text-[13px] text-ink-muted">Choose your networks and write the post below.</div></li>
<li className="rounded-2xl bg-white p-3 ring-1 ring-line"><div className="text-[12px] font-semibold text-accent">Send for review</div><div className="mt-0.5 text-[13px] text-ink-muted">It lands safely in Metricool as a draft — never live yet.</div></li>
<li className="rounded-2xl bg-white p-3 ring-1 ring-line"><div className="text-[12px] font-semibold text-accent">You approve</div><div className="mt-0.5 text-[13px] text-ink-muted">Open Metricool, take a final look, and publish when ready.</div></li>
</ol>
</div>
<div className="grid gap-0 lg:grid-cols-5">
<div className="border-b border-line p-6 sm:p-8 lg:col-span-3 lg:border-b-0 lg:border-r">
<div className="mb-3 flex items-center justify-between gap-2">
<label className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Schedule a post</label>
{mBusy && <span className="text-[11px] text-ink-faint">Sending…</span>}
</div>
<div className="mb-2 text-[12px] text-ink-muted">Which channels should this go to?</div>
<div className="flex flex-wrap gap-2" role="group" aria-label="Networks to post to">
{PUBLISH_NETWORKS.map((n) => {
const on = mNetworks.includes(n.id);
const emoji = n.id === 'facebook' ? '📘' : n.id === 'instagram' ? '📸' : n.id === 'linkedin' ? '💼' : n.id === 'twitter' ? '𝕏' : '🔗';
return (
<button type="button" key={n.id} onClick={() => toggleNetwork(n.id)} aria-pressed={on}
className={"inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " + (on ? "bg-accent text-white ring-accent" : "bg-white text-ink ring-line hover:ring-accent")}>
<span aria-hidden>{emoji}</span>{n.label}
</button>
);
})}
</div>
<p className="mt-1.5 text-[11px] text-ink-faint">{mNetworks.length ? 'Posting to ' + mNetworks.length + ' channel' + (mNetworks.length > 1 ? 's' : '') + '.' : 'Pick at least one channel.'}</p>
<div className="mt-4 flex items-center justify-between gap-2">
<span className="text-[12px] font-medium text-ink-muted">When should it go out?</span>
<span className="text-[11px] text-ink-faint">Times in America/Cancun</span>
</div>
<div className="mt-1 flex flex-wrap gap-2">
{[{ label: 'Tomorrow 9 AM', h: 9, d: 1 }, { label: 'Tomorrow 6 PM', h: 18, d: 1 }, { label: 'In 2 days, 12 PM', h: 12, d: 2 }].map((preset) => (
<button type="button" key={preset.label} onClick={() => { const dt = new Date(); dt.setDate(dt.getDate() + preset.d); dt.setHours(preset.h, 0, 0, 0); const pad = (x: number) => String(x).padStart(2, '0'); setMDate(dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + 'T' + pad(dt.getHours()) + ':' + pad(dt.getMinutes())); }}
className="rounded-full bg-subtle px-3 py-1 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:ring-accent">{preset.label}</button>
))}
</div>
<input type="datetime-local" value={mDate} onChange={(e) => setMDate(e.target.value)} className="mt-2 w-full rounded-xl bg-subtle px-3 py-2 text-[14px] text-ink ring-1 ring-line focus:ring-accent" />
<div className="mt-4 text-[12px] font-medium text-ink-muted">What should it say?</div>
<textarea value={mText} onChange={(e) => setMText(e.target.value)} rows={4} placeholder="Write your post… you can paste anything you generated above." className="mt-1 w-full resize-none rounded-2xl bg-subtle p-4 text-[14px] text-ink ring-1 ring-line placeholder:text-ink-faint focus:ring-accent" />
{mMedia ? (<div className="mt-2 flex items-center justify-between gap-2 rounded-2xl bg-subtle p-2.5 ring-1 ring-line"><div className="flex min-w-0 items-center gap-2"><span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">\uD83C\uDFAC</span><div className="min-w-0"><div className="truncate text-[13px] font-medium text-ink">{mMediaLabel || "Video attached"}</div><div className="text-[11px] text-ink-faint">This video will be attached to the post.</div></div></div><button type="button" onClick={() => { setMMedia(""); setMMediaLabel(""); }} className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-white">Remove</button></div>) : null}
<div className="mt-2 flex items-center justify-between text-[11px] text-ink-faint">
<span>{mText.trim().length} characters</span>
<span>{mDate ? 'Scheduled for ' + fmtDateTime(mDate) : 'No time set — sends as a draft'}</span>
</div>
<div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Publishing mode"><button type="button" onClick={() => setMAutoPublish(false)} aria-pressed={!mAutoPublish} className={"inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " + (!mAutoPublish ? "bg-accent text-white ring-accent" : "bg-white text-ink ring-line hover:ring-accent")}>Save as draft in Metricool</button><button type="button" onClick={() => setMAutoPublish(true)} aria-pressed={mAutoPublish} className={"inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium ring-1 transition " + (mAutoPublish ? "bg-red-600 text-white ring-red-600" : "bg-white text-ink ring-line hover:ring-accent")}>Publish now</button></div><p className="mt-1 text-[11px] text-ink-faint">{mAutoPublish ? "Publish now posts live to the selected channels via Metricool." : "Save as draft queues it in Metricool for you to approve there."}</p>
<div className="mt-4 flex flex-wrap items-center gap-3">
<button onClick={schedulePost} disabled={mBusy} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-semibold text-white shadow-soft transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">{mBusy ? 'Sending…' : (mAutoPublish ? 'Publish now' : 'Send to Metricool for review')}</button>
<a href={metricoolPlannerUrl()} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2.5 text-[13px] font-medium text-ink ring-1 ring-line transition hover:ring-accent">Open in Metricool ↗</a>
</div>
{mStatus && <p className="mt-3 rounded-xl bg-subtle px-3 py-2 text-[13px] text-ink-muted ring-1 ring-line">{mStatus}</p>}
<p className="mt-3 text-[11px] text-ink-faint">{mAutoPublish ? "Publish now sends straight to your channels via Metricool the moment you click — review carefully first." : "Nothing publishes automatically — it lands in Metricool as a draft for you to approve."}</p>
</div>
<div className="p-6 sm:p-8 lg:col-span-2">
<div className="mb-3 flex items-center justify-between gap-2">
<label className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Connection health</label>
<button type="button" onClick={() => { loadAnalytics(false); loadInsights(activeBlogId); }} className="text-[12px] font-medium text-accent hover:underline">{(mLoading || insightsLoading) ? 'Checking…' : 'Refresh'}</button>
</div>
{(() => {
const brand = mAnalytics && Array.isArray(mAnalytics.data) ? (mAnalytics.data.find((b: any) => String(b.id) === String(activeBlogId)) || mAnalytics.data[0]) : null;
const channels = [
{ id: 'facebook', label: 'Facebook', emoji: '📘', handle: brand && brand.facebook ? 'Connected' : '' },
{ id: 'instagram', label: 'Instagram', emoji: '📸', handle: brand && brand.instagram ? '@' + brand.instagram : '' },
{ id: 'twitter', label: 'X / Twitter', emoji: '𝕏', handle: brand && brand.twitter ? '@' + brand.twitter : '' },
{ id: 'linkedin', label: 'LinkedIn', emoji: '💼', handle: brand && brand.linkedinCompany ? 'Connected' : '' },
{ id: 'youtube', label: 'YouTube', emoji: '▶️', handle: brand && (brand.youtubeChannelName || brand.youtube) ? (brand.youtubeChannelName || 'Connected') : '' },
{ id: 'tiktok', label: 'TikTok', emoji: '🎵', handle: brand && brand.tiktok ? '@' + brand.tiktok : '' },
];
const connectedCount = channels.filter((c) => c.handle).length;
const ads = brand ? [brand.facebookAds && 'Facebook Ads', brand.adwords && 'Google Ads', brand.tiktokads && 'TikTok Ads'].filter(Boolean) : [];
if (!mAnalytics) {
return <div className="rounded-2xl bg-subtle p-4 text-center ring-1 ring-line"><div className="text-[13px] font-medium text-ink-muted">See which accounts are linked</div><div className="mt-1 text-[12px] text-ink-faint">Tap Refresh to load the accounts connected to your Metricool brand.</div></div>;
}
if (connectedCount === 0) {
return <div className="rounded-2xl bg-amber-50 p-4 text-center ring-1 ring-amber-100"><div className="text-[13px] font-medium text-amber-900">No accounts connected yet</div><div className="mt-1 text-[12px] text-amber-800">Connect the accounts for this brand inside Metricool to start publishing.</div></div>;
}
return (
<div>
<ul className="space-y-2">
{channels.map((c) => (
<li key={c.id} className="flex items-center justify-between rounded-2xl bg-white px-3 py-2 ring-1 ring-line">
<span className="flex items-center gap-2 text-[13px] text-ink"><span aria-hidden className="text-[16px]">{c.emoji}</span><span className="font-medium">{c.label}</span>{c.handle && c.handle !== 'Connected' && <span className="text-[12px] text-ink-faint">{c.handle}</span>}</span>
{c.handle ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-100">Connected</span> : <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-ink-faint ring-1 ring-line">Not connected</span>}
</li>
))}
</ul>
<p className="mt-2 text-[11px] text-ink-faint">{connectedCount} of {channels.length} channels connected.</p>
{ads.length > 0 && <p className="mt-1 text-[11px] text-ink-faint">Ad accounts linked: {ads.join(', ')}.</p>}
</div>
);
})()}
<div className="mt-6 border-t border-line pt-5">
<label className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">How your recent posts did</label>
{(() => {
const posts = insights && Array.isArray(insights.posts) ? insights.posts : [];
if (!insights) return <div className="mt-2 rounded-2xl bg-subtle p-4 text-center text-[12px] text-ink-faint ring-1 ring-line">Tap Refresh to load recent performance.</div>;
if (posts.length === 0) return <div className="mt-2 rounded-2xl bg-subtle p-4 text-center text-[12px] text-ink-faint ring-1 ring-line">No recent post data yet. Numbers appear here once your channels have activity.</div>;
const num = (p: any) => Number((p && (p.engagement || p.interactions || p.likes || p.impressions)) || 0);
const total = posts.reduce((s: number, p: any) => s + num(p), 0);
return (
<div className="mt-2 grid grid-cols-2 gap-2">
<div className="rounded-2xl bg-white p-3 ring-1 ring-line"><div className="text-[20px] font-semibold text-ink">{posts.length}</div><div className="text-[12px] text-ink-muted">Posts (last 28 days)</div></div>
<div className="rounded-2xl bg-white p-3 ring-1 ring-line"><div className="text-[20px] font-semibold text-ink">{total.toLocaleString()}</div><div className="text-[12px] text-ink-muted">Total interactions</div></div>
</div>
);
})()}
</div>
<div className="mt-6 border-t border-line pt-5">
<label className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Coming up next</label>
{(() => {
const sched = insights && Array.isArray(insights.scheduled) ? insights.scheduled : [];
if (sched.length === 0) return <div className="mt-2 rounded-2xl bg-subtle p-4 text-center ring-1 ring-line"><div className="text-[13px] font-medium text-ink-muted">Nothing scheduled yet</div><div className="mt-1 text-[12px] text-ink-faint">Posts you send for review will appear here, and your upcoming Metricool posts show once you refresh.</div></div>;
return (
<ul className="mt-2 space-y-2">
{sched.slice(0, 5).map((p: any, i: number) => (
<li key={(p && (p.id || p.uuid)) || i} className="rounded-2xl bg-white p-3 ring-1 ring-line">
<div className="flex items-center justify-between gap-2"><span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700 ring-1 ring-blue-100">Scheduled</span><span className="text-[11px] text-ink-faint">{fmtDateTime((p && (p.publicationDate || p.publishAt || p.date || (p.data && p.data.date))) || '')}</span></div>
<p className="mt-1.5 line-clamp-2 text-[13px] text-ink">{(p && (p.text || p.content || (p.data && p.data.text))) || 'Scheduled post'}</p>
</li>
))}
</ul>
);
})()}
</div>
<div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-5 text-[12px]">
<a href={'https://app.metricool.com/inbox?blogId=4308292&userId=3377431'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">💬 Open Inbox ↗</a>
<a href={'https://app.metricool.com/smartlink?blogId=4308292&userId=3377431'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">🔗 Smartlinks ↗</a>
<a href={metricoolPlannerUrl()} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">📅 Full planner ↗</a>
</div>
</div>
</div>
              {/* AI Research & Draft Copilot — full-width band below the two columns */}
              <div className="border-t border-line p-6 sm:p-8">
              <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-50 to-white ring-1 ring-indigo-100">
                <div className="border-b border-indigo-100 px-5 py-4">
                  <div className="flex items-center gap-2">
                    <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-xl bg-indigo-600/10 text-indigo-700">&#10024;</span>
                    <div>
                      <h3 className="text-[15px] font-semibold text-ink">AI Research &amp; Draft Copilot</h3>
                      <p className="text-[12px] text-ink-muted">Give it a topic and it does the research legwork &mdash; angles, keywords, hashtags, hooks and a ready draft.</p>
                    </div>
                  </div>
                </div>
                <div className="p-5">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      type="text"
                      value={researchTopicText}
                      onChange={(e) => setResearchTopicText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") runResearch(); }}
                      placeholder="e.g. stem cell therapy for knee pain"
                      className="flex-1 rounded-xl bg-white px-3.5 py-2.5 text-[13px] text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    />
                    <select
                      value={researchNetwork}
                      onChange={(e) => setResearchNetwork(e.target.value)}
                      className="rounded-xl bg-white px-3 py-2.5 text-[13px] text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    >
                      <option value="instagram">Instagram</option>
                      <option value="facebook">Facebook</option>
                      <option value="linkedin">LinkedIn</option>
                      <option value="x">X / Twitter</option>
                      <option value="blog">Blog</option>
                    </select>
                    <button
                      type="button"
                      onClick={runResearch}
                      disabled={researchLoading || !researchTopicText.trim()}
                      className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2.5 text-[13px] font-medium text-white transition hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {researchLoading ? "Researching\u2026" : "Research this topic"}
                    </button>
                  </div>

                  {researchError && (
                    <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700 ring-1 ring-red-100">{researchError}</p>
                  )}

                  {research && (
                    <div className="mt-4 space-y-4">
                      {research.summary && (
                        <p className="text-[13px] leading-relaxed text-ink">{research.summary}</p>
                      )}

                      <div className="grid gap-3 sm:grid-cols-2">
                        {Array.isArray(research.angles) && research.angles.length > 0 && (
                          <div className="rounded-xl bg-white p-4 ring-1 ring-line">
                            <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Content angles</div>
                            <ul className="mt-2 space-y-1">
                              {research.angles.map((a: string, i: number) => (
                                <li key={i} className="text-[13px] text-ink">&bull; {a}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {Array.isArray(research.viralityFactors) && research.viralityFactors.length > 0 && (
                          <div className="rounded-xl bg-white p-4 ring-1 ring-line">
                            <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Why it can spread</div>
                            <ul className="mt-2 space-y-1">
                              {research.viralityFactors.map((v: string, i: number) => (
                                <li key={i} className="text-[13px] text-ink">&bull; {v}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>

                      {Array.isArray(research.keywords) && research.keywords.length > 0 && (
                        <div className="rounded-xl bg-white p-4 ring-1 ring-line">
                          <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Suggested keywords</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {research.keywords.map((k: any, i: number) => (
                              <span key={i} title={k.why} className="rounded-full bg-indigo-50 px-3 py-1 text-[12px] text-indigo-800 ring-1 ring-indigo-100">{k.term}</span>
                            ))}
                          </div>
                        </div>
                      )}

                      {Array.isArray(research.hashtags) && research.hashtags.length > 0 && (
                        <div className="rounded-xl bg-white p-4 ring-1 ring-line">
                          <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Hashtags</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {research.hashtags.map((h: string, i: number) => (
                              <span key={i} className="rounded-full bg-subtle px-3 py-1 text-[12px] text-ink-muted ring-1 ring-line">{h}</span>
                            ))}
                          </div>
                        </div>
                      )}

                      {Array.isArray(research.hooks) && research.hooks.length > 0 && (
                        <div className="rounded-xl bg-white p-4 ring-1 ring-line">
                          <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Hooks to open with</div>
                          <ul className="mt-2 space-y-1">
                            {research.hooks.map((h: string, i: number) => (
                              <li key={i} className="text-[13px] text-ink">&bull; {h}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {research.trendRead && (
                        <div className="rounded-xl bg-white p-4 ring-1 ring-line">
                          <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Trend read</div>
                          <p className="mt-2 text-[13px] leading-relaxed text-ink">{research.trendRead}</p>
                        </div>
                      )}

                      {research.draft && (
                        <div className="rounded-xl bg-white p-4 ring-1 ring-line">
                          <div className="flex items-center justify-between">
                            <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Ready-to-edit draft</div>
                            <button type="button" onClick={() => { try { setMText(String(research.draft || "")); setMStatus(null); scrollToPublisher(); } catch {} }} className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-indigo-700">Use this draft</button> <button type="button" onClick={() => { try { navigator.clipboard.writeText(String(research.draft || "")); } catch {} }} className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-indigo-700 ring-1 ring-indigo-200 transition hover:bg-indigo-50">Copy draft</button>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{research.draft}</p>
                        </div>
                      )}

                      {research.liveDataNote && (
                        <p className="text-[11px] leading-relaxed text-ink-muted">{research.liveDataNote}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
              </div>
</section>


{/* OpusClip — long-form to Shorts (video repurposing workspace) */}
<section id="section-repurpose" className="mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
<div className="border-b border-line px-6 py-5 sm:px-8">
<div className="flex flex-wrap items-center justify-between gap-3">
<div className="flex items-center gap-2">
<span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Step 2 · Repurpose</span>
<h2 className="text-[18px] font-semibold text-ink">Long-form to Shorts</h2>
</div>
<span className="rounded-full bg-subtle px-2.5 py-1 text-[11px] font-medium text-ink-muted ring-1 ring-line">Powered by OpusClip</span>
</div>
<p className="mt-1.5 text-[13px] text-ink-muted">Drop in one long YouTube or Vimeo video and get back a set of ready-to-post vertical clips — each auto-captioned and cropped for Reels, Shorts and TikTok.</p>
<div className="mt-4 grid gap-3 sm:grid-cols-3">
<div className="rounded-2xl bg-subtle p-3 ring-1 ring-line">
<p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">1 · Paste</p>
<p className="mt-1 text-[12px] text-ink-muted">Add a YouTube or Vimeo link and name the project.</p>
</div>
<div className="rounded-2xl bg-subtle p-3 ring-1 ring-line">
<p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">2 · Auto-clip</p>
<p className="mt-1 text-[12px] text-ink-muted">Opus finds the best moments and cuts vertical clips with captions.</p>
</div>
<div className="rounded-2xl bg-subtle p-3 ring-1 ring-line">
<p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">3 · Review</p>
<p className="mt-1 text-[12px] text-ink-muted">Clips land under Recent Drafts — preview, then send to Metricool.</p>
</div>
</div>
</div>
<div className="grid lg:grid-cols-5">
<div className="p-6 sm:p-8 lg:col-span-3 lg:border-r lg:border-line">
<p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Source video</p>
<input
type="url"
value={opUrl}
onChange={e => setOpUrl(e.target.value)}
placeholder="https://youtube.com/watch?v=…  or  https://vimeo.com/…"
className="w-full rounded-xl bg-white px-4 py-3 text-[14px] text-ink shadow-soft ring-1 ring-line transition placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent"
/>
<div className="mt-4 grid gap-3 sm:grid-cols-2">
<div>
<label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Project title <span className="text-ink-faint normal-case">(optional)</span></label>
<input
type="text"
value={opTitle}
onChange={e => setOpTitle(e.target.value)}
placeholder="e.g. Ben Rothwell — Recovery"
className="w-full rounded-xl bg-white px-3 py-2.5 text-[13px] text-ink shadow-soft ring-1 ring-line transition placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent"
/>
</div>
<div>
<label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Caption language</label>
<select
value={opLang}
onChange={e => setOpLang(e.target.value)}
className="w-full rounded-xl bg-white px-3 py-2.5 text-[13px] text-ink shadow-soft ring-1 ring-line transition focus:outline-none focus:ring-2 focus:ring-accent"
>
<option value="en">English</option>
<option value="es">Spanish</option>
<option value="pt">Portuguese</option>
<option value="fr">French</option>
<option value="de">German</option>
<option value="it">Italian</option>
</select>
</div>
</div>
<p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Format preset</p>
<div className="flex flex-wrap gap-2">
{OPUS_ASPECTS.map(a => (
<button
key={a.value}
type="button"
onClick={() => setOpAspect(a.value)}
className={`rounded-full px-3 py-1.5 text-[12px] font-medium ring-1 transition ${opAspect === a.value ? 'bg-accent text-white ring-accent' : 'bg-white text-ink-muted ring-line hover:ring-accent'}`}
>
{a.label}
</button>
))}
</div>
<div className="mt-5 flex flex-wrap items-center gap-3">
<button
type="button"
onClick={clipVideo}
disabled={opBusy || !opUrl.trim()}
className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-semibold text-white shadow-soft transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
>
{opBusy ? (<><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />Sending to Opus…</>) : 'Generate clips'}
</button>
<span className="text-[12px] text-ink-faint">Processing runs in the background — no need to wait here.</span>
</div>
{opStatus && (
<p className="mt-3 rounded-xl bg-subtle px-3 py-2 text-[12px] text-ink-muted ring-1 ring-line">{opStatus}</p>
)}
</div>
<div className="p-6 sm:p-8 lg:col-span-2">
<p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">What you&apos;ll get</p>
<ul className="space-y-2.5">
<li className="flex items-start gap-2 text-[13px] text-ink-muted"><span className="mt-0.5 text-accent">▸</span>Several short vertical clips from the best moments of your video.</li>
<li className="flex items-start gap-2 text-[13px] text-ink-muted"><span className="mt-0.5 text-accent">▸</span>Auto-generated captions burned in, in your chosen language.</li>
<li className="flex items-start gap-2 text-[13px] text-ink-muted"><span className="mt-0.5 text-accent">▸</span>A virality score and suggested title on each clip.</li>
<li className="flex items-start gap-2 text-[13px] text-ink-muted"><span className="mt-0.5 text-accent">▸</span>Everything saved to Recent Drafts, ready to send to Metricool.</li>
</ul>
<div className="mt-6 rounded-2xl bg-subtle p-4 ring-1 ring-line">
<p className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">This run</p>
<dl className="mt-2 space-y-1.5 text-[12px]">
<div className="flex items-center justify-between"><dt className="text-ink-muted">Format</dt><dd className="font-medium text-ink">{OPUS_ASPECTS.find(a => a.value === opAspect)?.label || opAspect}</dd></div>
<div className="flex items-center justify-between"><dt className="text-ink-muted">Captions</dt><dd className="font-medium text-ink">{({en:'English',es:'Spanish',pt:'Portuguese',fr:'French',de:'German',it:'Italian'})[opLang] || opLang}</dd></div>
<div className="flex items-center justify-between"><dt className="text-ink-muted">Project</dt><dd className="max-w-[150px] truncate font-medium text-ink">{opTitle.trim() || 'Auto from video'}</dd></div>
</dl>
</div>
<div className="mt-4 flex items-start gap-2 rounded-2xl bg-blue-50 p-4 text-[12px] text-blue-700 ring-1 ring-blue-100">
<span className="mt-0.5">ⓘ</span>
<span>Clips can take a few minutes. They appear under <span className="font-medium">Recent Drafts</span> below — hit <span className="font-medium">Refresh clips</span> there to check progress. Format is a hint to Opus; final crop depends on your Opus brand settings.</span>
</div>
</div>
</div>
</section>


{/* Recent Drafts */}
<section id="section-library" className="rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7">
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
<button key={(d?.id || d?._id || i) + '-opus'} onClick={() => openDraft(d)}
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
<li onClick={() => openDraft(d)} role="button" tabIndex={0} key={(d && (d.id || d._id)) || i} className="cursor-pointer rounded-xl transition hover:bg-subtle/60 flex items-start gap-4 py-4">
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
<button type="button" aria-label="Edit draft" onClick={(e) => { e.stopPropagation(); prefillComposerFromDraft(d); }}
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
{selectedDraft && typeof document !== 'undefined' ? createPortal((
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
{!editingDraft ? (
<button onClick={() => startEditDraft(selectedDraft)} className="rounded-xl px-3 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">Edit</button>
) : null}
{!editingDraft && !(selectedDraft && selectedDraft.pack && selectedDraft.pack.kind === "clip") ? (<button onClick={() => prefillComposerFromDraft(selectedDraft)} className="rounded-xl bg-accent px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-accent-hover">Schedule / Publish</button>) : null}
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
<video controls autoPlay muted playsInline preload="auto" poster={selectedDraft?.pack?.thumb || undefined} src={c.preview || c.export}
  onError={(e) => { const v = e.currentTarget; const box = v.parentElement; if (box && !box.querySelector('[data-clip-expired]')) { v.style.display = 'none'; const d = document.createElement('div'); d.setAttribute('data-clip-expired', '1'); d.className = 'aspect-video w-full bg-black text-[13px] text-white flex items-center justify-center text-center px-4'; d.textContent = 'Preview link expired — re-sync this clip to play it again.'; box.prepend(d); } }}
className="aspect-video w-full bg-black" />
<div className="p-3">
<div className="flex items-center justify-between gap-3">
<div className="truncate text-[13px] font-semibold text-ink">{c.title || ('Clip ' + (ci + 1))}</div>
<span className="shrink-0 text-[11px] text-ink-faint">{fmtDuration(c.durationMs)}</span>
</div>
{c.description ? <p className="mt-1 line-clamp-2 text-[12px] text-ink-muted">{c.description}</p> : null}
{c.hashtags ? <p className="mt-1 truncate text-[11px] text-accent">{c.hashtags}</p> : null}
<div className="mt-2 flex items-center gap-2">
<button type="button" onClick={() => prefillComposerFromClip(c)} className="rounded-full bg-accent px-3 py-1 text-[12px] font-semibold text-white transition hover:bg-accent-hover">Publish / Schedule</button>
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
(() => {
  const secs = formatSections(selectedDraft?.pack);
  if (secs.length > 0) {
    return (
      <div className="space-y-4">
        {secs.map((s, si) => (
          <div key={si} className="rounded-2xl bg-subtle/50 p-4 ring-1 ring-line/60">
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">{s.label}</div>
            <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-ink">{s.text}</div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="whitespace-pre-wrap rounded-2xl bg-subtle/50 p-4 text-[14px] leading-relaxed text-ink ring-1 ring-line/60">{String(selectedDraft?.body || selectedDraft?.pack?.instagram || selectedDraft?.pack?.text || selectedDraft?.text || selectedDraft?.pack?.content || JSON.stringify(selectedDraft?.pack ?? {}, null, 2))}</div>
  );
})()
)}
</div>
</div>
), document.body) : null}
</main>
</div>
</div>
);
}
