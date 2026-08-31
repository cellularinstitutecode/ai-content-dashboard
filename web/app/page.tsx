'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLiveContent } from "@/components/LiveContentProvider";
import SemrushPanel from "./SemrushPanel";
import AutopilotQueue from "./AutopilotQueue";
import ImageStudio from "./ImageStudio";
import CollapsibleSection from "@/components/CollapsibleSection";
import SystemStatus from "@/components/SystemStatus";
import ProcessTracker, { makeSteps, stepActive, stepError, stepSkip, stepsDone, type ProcessStep } from "@/components/ProcessTracker";
import { announce, onRefresh, fetchDrafts } from "@/components/refreshBus";
import { tightestLimit, networkLabel, parseVideoUrl, localDateTimeValue, draftLabel } from "@/lib/composer";
import { useWorkspace } from "@/components/workspace";
import { PanelLoader } from "@/components/LoadingScreen";
import { friendlyError, friendlyErrorFromResponse } from '@/lib/friendly-error';
import { semrushDraftNote } from '@/lib/semrush-reason';
import { fmtScheduleDateTime, scheduleTzLabel, schedulePresetValue } from '@/lib/schedule-clock';

// The visible pipeline every manual generation walks through. Steps light up
// as the real calls behind them start/finish so the viewer can follow the
// process live instead of staring at a spinner.
const GEN_STEPS = [
  { id: 'research', label: 'Keyword research', detail: 'Checking live search volumes and difficulty…' },
  { id: 'draft', label: 'AI drafting', detail: 'Writing your multi-channel content pack…' },
  { id: 'save', label: 'Saving to library', detail: 'Storing the draft so nothing is lost…' },
  { id: 'image', label: 'Hero image', detail: 'Generating an on-brand visual with the OpenAI image pipeline…' },
  { id: 'verify', label: 'Machine verification', detail: 'Confirming the image is a text-free content image (no words/letters, no warped anatomy, no logos) — text triggers an automatic regeneration…' },
];

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
{ title: '1 · Create', body: 'Describe your idea and generate a ready-to-post content pack for every channel.' },
{ title: '2 · Images', body: 'Every AI visual is generated and machine-verified text-free in the Image Studio.' },
{ title: '3 · Repurpose', body: 'Paste a long YouTube or Vimeo URL and OpusClip turns it into short vertical clips.' },
{ title: '4 · Schedule', body: 'Send posts to Metricool for review — you approve the final publish there.' },
{ title: '5 · Library', body: 'Everything you make is saved under Recent Drafts so you can edit, play, or reuse it.' },
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
// straight to the place it gets approved. The DEFAULT brand; the Publishing
// panel's brand switcher overrides it everywhere via activeBlogId.
const METRICOOL_BLOG_ID = '4308292';
function metricoolPlannerUrl(blogId: string = METRICOOL_BLOG_ID): string {
return 'https://app.metricool.com/planning/list?blogId=' + encodeURIComponent(blogId || METRICOOL_BLOG_ID);
}

// Deep-link into the Semrush Keyword Magic Tool for keyword research, pre-filled
// with the topic the user is working on. Opens in a new tab; no credentials involved.
function semrushUrl(keyword: string): string {
  const kw = (keyword || '').trim();
  const base = 'https://www.semrush.com/analytics/keywordmagic/';
  return kw ? (base + '?q=' + encodeURIComponent(kw) + '&db=us') : (base + '?db=us');
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

// A finished Opus clip (mirrors OpusClip in lib/opus.ts).
type Clip = { id: string; title: string; text: string; description: string; hashtags: string; durationMs: number; preview: string; export: string };

// The format picker that used to live here was removed. It set local state,
// echoed the chosen ratio back under "This run" as if it had been applied, and
// was never sent to Opus - clipVideo() posts { videoUrl, title, language } and
// nothing in lib/opus.ts or the clip route has ever read an aspect ratio. A
// control that reports a setting it does not apply is worse than no control.
// Opus uses the ratio configured on the project in its own dashboard.

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

// Friendly date/time for a scheduled post, e.g. "Sep 1, 9:00 AM".
//
// Always rendered on the SCHEDULE clock, never the browser's. The composer
// promises "times are in Cancun" and the server schedules that way; when this
// used to render in the viewer's zone, a coordinator in Tijuana was shown
// 9:00 AM in the composer and 7:00 AM in the queue for the very same post.
const fmtDateTime = fmtScheduleDateTime;

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
const workspace = useWorkspace();
const [provider, setProvider] = useState<Provider>('anthropic');
const [model, setModel] = useState<string>('claude-sonnet-4-5');
const [type, setType] = useState<ContentType>('social');
const [prompt, setPrompt] = useState('');
const [copied, setCopied] = useState(false);
const [loading, setLoading] = useState(false);
const [err, setErr] = useState<string | null>(null);
// A failed load used to leave every panel in its EMPTY state, so a 401, a 429
// or a dropped connection all read as "you have no drafts / nothing queued".
// These two carry the difference: loadError is "we could not read your data",
// actionMsg is "the thing you just clicked did not happen".
const [loadError, setLoadError] = useState<string | null>(null);
const [actionMsg, setActionMsg] = useState<string | null>(null);
const [keywordsApplied, setKeywordsApplied] = useState<string[]>([]);
const [keywordSource, setKeywordSource] = useState<string>('none');
// WHY there was no live keyword data, straight from /api/generate. Held so the
// note under the output can state the true reason instead of assuming one.
const [keywordReason, setKeywordReason] = useState<string | undefined>(undefined);
const [genImage, setGenImage] = useState<{ url: string; alt?: string; model?: string; verification?: { status?: string; score?: number | null; issues?: string[]; textDetected?: boolean } } | null>(null);
const [genImageLoading, setGenImageLoading] = useState(false);
const [lastDraftId, setLastDraftId] = useState<string | null>(null);
const [modalImgBusy, setModalImgBusy] = useState(false);

// Live process pipeline for the Content Generator (see GEN_STEPS above).
const [proc, setProc] = useState<ProcessStep[] | null>(null);
const procTimers = useRef<any[]>([]);
// Monotonic run id: late responses from a superseded generation (e.g. its
// hero image resolving after the user hit Generate again) are discarded
// instead of scrambling the new run's tracker/image.
const genRun = useRef(0);
function clearProcTimers() { procTimers.current.forEach((t) => clearTimeout(t)); procTimers.current = []; }
function procAdvanceLater(id: string, ms: number) {
  procTimers.current.push(setTimeout(() => setProc((p) => (p ? stepActive(p, id) : p)), ms));
}
useEffect(() => () => clearProcTimers(), []);

// Interconnection: refetch whatever another panel (Image Studio, Autopilot,
// assistant) announces it changed, so this page never shows stale data.
useEffect(() => {
  return onRefresh((scopes) => {
    if (scopes.includes('drafts')) refreshDrafts(0, false);
    if (scopes.includes('stats')) refreshStats();
    if (scopes.includes('posts')) refreshPosts();
    // The Metricool panels sit directly under the Schedule button and used to
    // stay stale after it was pressed, so they refresh on a posts change too.
    if (scopes.includes('insights') || scopes.includes('posts')) loadInsights(activeBlogId);
    if (scopes.includes('insights')) loadAnalytics(true);
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);

// The shared topic: whatever Semrush, Keyword Intelligence, the Image Studio,
// the calendar or the templates page is working on lands in the generator's
// prompt, and anything typed here travels back out to them.
useEffect(() => {
  const incoming = (workspace.topic || '').trim();
  if (incoming && incoming !== prompt.trim()) setPrompt(incoming);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [workspace.topic]);

// Every research finding is actionable: clicking one loads it into the
// generator prompt and shares it with every other panel. They used to be
// inert text.
const applyIdea = (text: string, source = 'research') => {
  const v = (text || '').trim();
  if (!v) return;
  setPrompt(v);
  publishTopic(v, source);
  if (typeof document !== 'undefined') {
    document.getElementById('content-generator')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

const publishTopic = (value: string, source = 'generator') => {
  const v = value.trim();
  if (v && v !== (workspace.topic || '').trim()) workspace.setTopic(v, { source });
};

const [mLoading, setMLoading] = useState(false);
const [mAnalytics, setMAnalytics] = useState<any>(null);
const [mNetworks, setMNetworks] = useState<string[]>(["facebook"]);
const toggleNetwork = (n: string) => setMNetworks((prev) => prev.includes(n) ? prev.filter((x) => x !== n) : [...prev, n]);
const [mText, setMText] = useState('');
const [mDate, setMDate] = useState('');
const [mStatus, setMStatus] = useState<string | null>(null);
const [mBusy, setMBusy] = useState(false);
  // Auto-publish was removed deliberately. The dashboard's contract is that
  // nothing reaches a live channel without a human approving it inside
  // Metricool, and a "Publish now" button in this composer contradicted that
  // promise three lines below where the promise is made. Everything now goes
  // out as a Metricool draft; approval happens there.

  // --- Composer validation -------------------------------------------------
  // Everything the Send button depends on is derived here so the button state,
  // the counter and the inline messages can never disagree with each other.
  const [nowTick, setNowTick] = useState<Date | null>(null);
  useEffect(() => {
    setNowTick(new Date());
    const id = setInterval(() => setNowTick(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const mChars = mText.trim().length;
  const mLimit = tightestLimit(mNetworks);
  const mOverBy = mLimit ? mChars - mLimit.limit : 0;
  const mTooLong = mOverBy > 0;
  // `min` is only applied once we know the browser's clock, so the server-rendered
  // HTML never ships a stale floor.
  const mMinDateTime = nowTick ? localDateTimeValue(nowTick) : undefined;
  const mDateInPast = Boolean(mDate && nowTick && new Date(mDate).getTime() < nowTick.getTime());
  const mProblem =
    !mNetworks.length ? 'Pick at least one channel.'
    : !mText.trim() ? 'Write the post first.'
    : mTooLong && mLimit ? networkLabel(mLimit.network) + ' allows ' + mLimit.limit.toLocaleString() + ' characters. Trim ' + mOverBy.toLocaleString() + '.'
    : !mDate ? 'Pick the date and time it should go out.'
    : mDateInPast ? 'That time has already passed. Pick a future time.'
    : null;
  const mCanSend = !mProblem && !mBusy;
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
      // HARD RULE at the ship-point: never prefill the scheduler with an
      // image the checker flagged for text — reroll it in the Image Studio
      // first. Content images must be text-free wherever they publish.
      const heroImg = d && d.pack && d.pack._image;
      const heroHasText = Boolean(heroImg && heroImg.verification && heroImg.verification.textDetected === true);
      const heroUrl = heroImg && heroImg.url && !heroHasText ? String(heroImg.url) : "";
      if (heroUrl) { setMMedia(heroUrl); setMMediaLabel("AI hero image"); }
      else { setMMedia(""); setMMediaLabel(""); }
      setMNetworks(platformsForFormat(fmt).filter((n) => PUBLISH_NETWORKS.some((p) => p.id === n)));
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
      // Without this check the error BODY was stored as the insights object, so
      // a rate-limited or expired request rendered as "No recent post data yet".
      if (!r.ok) {
        setInsights(null);
        setLoadError(await friendlyErrorFromResponse(r, 'We could not load your channel numbers.'));
        return;
      }
      const j = await r.json().catch(() => null);
      setInsights(j);
    } catch (e) {
      setInsights(null);
      setLoadError(friendlyError(e, 'We could not reach Metricool just now.'));
    } finally {
      setInsightsLoading(false);
    }
  }

  // --- AI Research & Draft Copilot state ---
  const [researchTopicText, setResearchTopicText] = useState('');
  // Two topic inputs on one page used to drift apart; both now read the same
  // shared value.
  useEffect(() => {
    const incoming = (workspace.topic || '').trim();
    if (incoming && incoming !== researchTopicText.trim()) setResearchTopicText(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.topic]);
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
        workspace.setTopic(topic, { source: 'research' });
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

// --- Repurpose validation --------------------------------------------------
// Parsed up front so the button, the ring colour and the helper line all agree,
// and so an unusable link can never start a billable Opus job.
const opParsed = parseVideoUrl(opUrl);
const opValid = opParsed.ok;
const opError = !opParsed.ok && opUrl.trim() ? opParsed.reason : '';
const [opTitle, setOpTitle] = useState('');
const [opLang, setOpLang] = useState('en');

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
  publishTopic(t, 'trending');
setPrompt(t);
setType('social');
try { if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' }); } catch {}
}

  // Smooth-scroll the "How this works" cards to the matching section below,
  // and briefly highlight it so the viewer sees where they landed.
  const STEP_ANCHORS = ['section-create', 'section-images', 'section-repurpose', 'section-publish', 'section-library'];
  function scrollToStep(i: number) {
    try {
      // Sections that arrive folded must unfold before we scroll to them —
      // otherwise the card lands the viewer on a closed header.
      window.dispatchEvent(new CustomEvent('section:open', { detail: STEP_ANCHORS[i] }));
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
// setInterval does NOT await its callback. Each tick fetches every pending
// clip job, and the server side of that downloads multi-MB MP4s and uploads
// them to Drive - routinely more than 5s. Ticks therefore overlapped, and
// each concurrent request saw an un-updated draft row (knownClips empty), so
// every one of them re-uploaded the whole set as fresh public Drive files.
// A re-entrancy guard makes a tick that is still running skip the next slot.
let tickInFlight = false;
pollRef.current = setInterval(async () => {
if (tickInFlight) return;
tickInFlight = true;
try {
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
} finally { tickInFlight = false; }
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
      // Shares the Image Studio's identical mount-time request rather than
      // firing a second copy of it.
      const lj: any = await fetchDrafts(50, 0).catch(() => null);
      if (!lj) return;
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
if (!r.ok) { setLoadError(await friendlyErrorFromResponse(r, 'We could not load your numbers just now.')); return; }
const j = await r.json().catch(() => null);
if (j) { setStats(j); setLoadError(null); }
} catch (e) { setLoadError(friendlyError(e, 'We could not reach the server. Check your connection.')); }
}

async function refreshDrafts(offset = 0, append = false) {
try {
if (append) setLoadingMore(true);
const r = await fetch('/api/drafts?limit=' + PAGE_SIZE + '&offset=' + offset);
// A lapsed session now answers 401 instead of quietly handing back the
// sign-in page, so say so rather than rendering an empty list.
if (!r.ok) { setLoadError(await friendlyErrorFromResponse(r, 'We could not load your drafts.')); return; }
const ct = r.headers.get('content-type') || '';
if (!ct.includes('application/json')) { setLoadError('We got an unexpected answer from the server. Try reloading the page.'); return; }
setLoadError(null);
const j = await r.json().catch(() => null);
const rows = toArray(j);
if (j && typeof j.total === 'number') setDraftsTotal(j.total);
setDraftsOffset(offset);
setDrafts((prev: any) => append ? [...(Array.isArray(prev) ? prev : []), ...rows] : rows);
} catch (e) { setLoadError(friendlyError(e, 'We could not reach the server. Check your connection.')); } finally { setLoadingMore(false); }
}

// Pull the current user's scheduled posts (GET /api/posts). Ordered soonest
// first by the API; we keep that order for the queue.
async function refreshPosts() {
setPostsLoading(true);
try {
const r = await fetch('/api/posts');
if (!r.ok) { setLoadError(await friendlyErrorFromResponse(r, 'We could not load your publishing queue.')); return; }
const j = await r.json().catch(() => null);
const rows = (j && Array.isArray(j.posts)) ? j.posts : toArray(j);
setPosts(Array.isArray(rows) ? rows : []);
setLoadError(null);
} catch (e) { setLoadError(friendlyError(e, 'We could not reach the server. Check your connection.')); } finally { setPostsLoading(false); }
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
if (!r.ok) {
// The server refuses the local move when it could not move the post in
// Metricool, so the two can never drift apart. Say which it was.
setActionMsg(await friendlyErrorFromResponse(r, 'We could not move that post.'));
return;
}
setActionMsg(null);
setRescheduleId(null); setRescheduleAt(''); refreshPosts(); announce('posts', 'stats', 'insights');
} catch (e) { setActionMsg(friendlyError(e, 'We could not move that post.')); }
}

// Remove a queued post — from Metricool first, then from here.
async function deletePost(id: string) {
if (!id) return;
if (typeof window !== 'undefined' && !window.confirm('Delete this scheduled post? It will be removed from Metricool too. This cannot be undone.')) return;
try {
const r = await fetch('/api/posts?id=' + encodeURIComponent(id), { method: 'DELETE' });
if (!r.ok) { setActionMsg(await friendlyErrorFromResponse(r, 'We could not delete that post.')); return; }
setActionMsg(null);
refreshPosts(); announce('posts', 'stats', 'insights');
} catch (e) { setActionMsg(friendlyError(e, 'We could not delete that post.')); }
}

async function deleteDraft(id: string) {
if (!id) return;
if (typeof window !== 'undefined' && !window.confirm('Delete this draft? This cannot be undone.')) return;
try {
const r = await fetch('/api/drafts?id=' + encodeURIComponent(id), { method: 'DELETE' });
if (!r.ok) { setActionMsg(await friendlyErrorFromResponse(r, 'We could not delete that draft.')); return; }
setActionMsg(null);
announce('drafts', 'stats', 'images');
} catch (e) { setActionMsg(friendlyError(e, 'We could not delete that draft.')); }
}

function cleanCaption(s: string): string {
    return String(s || "").replace(/__\w+/g, " ").replace(/\s+/g, " ").trim();
  }
  // Delegates to the shared mapper so every panel says the same thing about the
  // same failure. The old local copy tested /unauthor/, which does NOT match
  // the "unauthenticated" the middleware returns - so an expired session was
  // reported to the user as a rejected AI API key.
  function friendlyGenError(msg: string): string {
    return friendlyError(msg, "We could not finish that. Try again in a moment.");
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
if (r.ok) announce('drafts', 'images');
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
if (pack && pack.kind === 'image') return (pack._image && typeof pack._image.alt === 'string') ? pack._image.alt : 'AI image';
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
if (!r.ok) {
// Staying in edit mode with no message looked exactly like "nothing
// happened", so the edits appeared to save and had not.
setActionMsg(await friendlyErrorFromResponse(r, 'We could not save those changes.'));
return;
}
const j = await r.json().catch(() => null);
const updated = (j && j.draft) ? j.draft : { ...d, topic: topic || d.topic, pack: basePack };
setSelectedDraft(updated);
setEditingDraft(false);
setActionMsg(null);
announce('drafts', 'images');
} catch (e) { setActionMsg(friendlyError(e, 'We could not save those changes.')); } finally { setSavingEdit(false); }
}

async function generate() {
const runId = ++genRun.current;
setLoading(true); setErr(null); setOutput(''); setGenImage(null); setLastDraftId(null);
// Light up the live pipeline: research → draft → save → image → verify.
clearProcTimers();
setProc(stepActive(makeSteps(GEN_STEPS), 'research'));
procAdvanceLater('draft', 4000); // research + drafting happen inside one call; pace the display
try {
const r = await fetch('/api/generate', {
method: 'POST', headers: { 'content-type': 'application/json' },
body: JSON.stringify({ topic: prompt, provider, model, type }),
});
const data = await r.json().catch(() => ({}));
if (!r.ok) throw new Error(data?.error || ('Generation failed ('+r.status+')'));
const pack = data.pack || {};
setKeywordsApplied(Array.isArray(data.keywordsApplied) ? data.keywordsApplied : []);
setKeywordSource(typeof data.keywordSource === 'string' ? data.keywordSource : 'none');
setKeywordReason(typeof data.keywordReason === 'string' ? data.keywordReason : undefined);
setOutput(formatOutputString({ ...pack, format: type }));
clearProcTimers();
setProc((p) => (p ? stepActive(p, 'save') : p));
let draftId: string | null = null;
try {
const dr = await fetch('/api/drafts', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ topic: prompt, pack: { ...pack, format: type }, provider }),
});
const dj = await dr.json().catch(() => ({}));
draftId = dj?.draft?.id || null;
} catch {}
setLastDraftId(draftId);
announce('drafts', 'stats');
// Visual pack: generate the AI hero image in the background so the text
// shows instantly and the image fills in when ready (fail-soft).
if (draftId) {
setGenImageLoading(true);
setProc((p) => (p ? stepActive(p, 'image') : p));
procAdvanceLater('verify', 20000); // generation ~20s, then the vision check
fetch('/api/drafts/image', {
method: 'POST',
headers: { 'content-type': 'application/json', 'x-chi-progress-scope': 'create' },
body: JSON.stringify({ id: draftId }),
})
.then(async (ir) => {
const ij = await ir.json().catch(() => ({}));
if (genRun.current !== runId) return; // superseded by a newer Generate
clearProcTimers();
if (ir.ok && ij?.image?.url) {
setGenImage(ij.image);
setProc((p) => (p ? stepsDone(p) : p));
} else {
setProc((p) => (p ? stepError(stepActive(p, 'image'), 'image') : p));
}
})
.catch(() => {
if (genRun.current !== runId) return;
clearProcTimers();
setProc((p) => (p ? stepError(stepActive(p, 'image'), 'image') : p));
})
.finally(() => {
if (genRun.current === runId) setGenImageLoading(false);
announce('drafts', 'images');
});
} else {
setProc((p) => (p ? stepsDone(stepSkip(p, ['image', 'verify'])) : p));
}
} catch (e: any) {
clearProcTimers();
setProc((p) => (p ? stepError(p) : p));
setErr(friendlyGenError(e?.message || 'Generation failed'));
} finally { setLoading(false); }
}

// Reject the current hero image and get a fresh proposition (the server
// advances the composition variant so every regenerate looks different).
async function regenGenImage() {
if (!lastDraftId || genImageLoading) return;
setGenImageLoading(true);
try {
const ir = await fetch('/api/drafts/image', {
method: 'POST',
headers: { 'content-type': 'application/json', 'x-chi-progress-scope': 'create' },
body: JSON.stringify({ id: lastDraftId, regenerate: true }),
});
const ij = await ir.json().catch(() => ({}));
if (!ir.ok || !ij?.image?.url) { setActionMsg(friendlyError(ij, 'We could not make a new image. The previous one is still here.')); }
else { setGenImage(ij.image); setActionMsg(null); }
} catch (e) { setActionMsg(friendlyError(e, 'We could not make a new image. The previous one is still here.')); } finally { setGenImageLoading(false); announce('drafts', 'images'); }
}

// Same, from the draft detail modal (works for any saved draft).
async function regenDraftImage(d: any) {
const id = d && (d.id || d._id);
if (!id || modalImgBusy) return;
setModalImgBusy(true);
try {
const r = await fetch('/api/drafts/image', {
method: 'POST',
headers: { 'content-type': 'application/json', 'x-chi-progress-scope': 'draft-modal' },
body: JSON.stringify({ id, regenerate: true }),
});
const j = await r.json().catch(() => ({}));
if (!r.ok || !j?.image?.url) { setActionMsg(friendlyError(j, 'We could not make a new image. The previous one is still here.')); }
else {
const updated = { ...d, pack: { ...((d && d.pack) || {}), _image: j.image } };
setSelectedDraft(updated);
setActionMsg(null);
announce('drafts', 'images');
}
} catch (e) { setActionMsg(friendlyError(e, 'We could not make a new image. The previous one is still here.')); } finally { setModalImgBusy(false); }
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
body: JSON.stringify({ network, text: mText, publishAt: mDate, blogId: activeBlogId || METRICOOL_BLOG_ID, mediaUrl: mMedia || undefined }),
});
const data = await r.json().catch(() => ({}));
return { network, ok: r.ok, status: r.status, data };
})
);
const ok = results.filter((x) => x.ok).map((x) => x.network);
const failed = results.filter((x) => !x.ok).map((x) => x.network);
if (failed.length === 0) {
setMStatus('Saved to Metricool as a draft on ' + ok.join(', ') + ' — approve it there to publish.');
setMText('');
} else if (ok.length === 0) {
setMStatus('Error: failed on ' + failed.join(', ') + '.');
} else {
setMStatus('Saved on ' + ok.join(', ') + '; failed on ' + failed.join(', ') + '.');
}
announce('posts', 'stats', 'insights');
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
announce('drafts', 'stats');
} catch (e: any) { setOpStatus('Error: ' + (e?.message || 'failed')); } finally { setOpBusy(false); }
}

async function copyOutput() {
try { await navigator.clipboard.writeText(output); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
}

const currentModels = PROVIDERS.find(p => p.id === provider)!.models;
const safeDrafts = Array.isArray(drafts) ? drafts : [];
const safePosts = Array.isArray(posts) ? posts : [];
const pendingReviewCount = safePosts.filter((p: any) => postStatusMeta(p?.status).label === 'Waiting for your approval').length;
const activeType = CONTENT_TYPES.find(t => t.id === type)!;

// metricoolMetrics() was computed and thrown away for months while the README
// advertised these as extra counter cards. They are appended, not substituted,
// so the four counts above never move position when analytics arrive.
const statCards = [
{ label: 'Drafts', value: (stats && (stats.drafts ?? stats.draftsCount)) ?? safeDrafts.length ?? 0 },
{ label: 'Scheduled posts', value: (stats && (stats.scheduled ?? stats.scheduledCount)) ?? safePosts.length ?? 0 },
{ label: 'Awaiting approval', value: pendingReviewCount },
{ label: 'Clip jobs', value: (stats && (stats.clips ?? stats.clipJobs)) ?? 0 },
...metricoolMetrics(mAnalytics).map((m) => ({ label: m.label, value: m.value })),
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

{/* One place that says a load failed, and one that says an action failed.
    Both used to be silence: a 401 or a dropped connection left every panel in
    its empty state, which reads as "you have nothing" rather than "we could
    not check". */}
{loadError && (
<div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-amber-50 px-5 py-4 text-[14px] text-amber-900 ring-1 ring-amber-200" role="status">
<span>{loadError}</span>
<button type="button" onClick={() => { setLoadError(null); refreshStats(); refreshDrafts(0, false); refreshPosts(); }} className="rounded-full bg-amber-900 px-3.5 py-1.5 text-[13px] font-medium text-white">Try again</button>
</div>
)}
{actionMsg && (
<div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-red-50 px-5 py-4 text-[14px] text-red-900 ring-1 ring-red-200" role="alert">
<span>{actionMsg}</span>
<button type="button" onClick={() => setActionMsg(null)} className="rounded-full px-3.5 py-1.5 text-[13px] font-medium text-red-900 underline">Dismiss</button>
</div>
)}

{/* One plain-English line when the app is running degraded, so a blank
    Site Audit dial or a missing keyword note has a stated cause instead of
    looking like three unrelated glitches. Silent when all is well. */}
<SystemStatus />

{/* Onboarding "How this works" strip — dismissible, remembered per browser */}
      {(
        <section className="mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
          <div className="flex items-center justify-between border-b border-line px-6 py-4 sm:px-8">
            <div>
              <h2 className="text-[15px] font-semibold text-ink">How this works</h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">A quick tour of the create → images → repurpose → schedule flow.</p>
            </div>
            <button type="button" onClick={toggleOnboard} aria-expanded={onboardOpen}
              className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">
              {onboardOpen ? 'Hide guide' : 'Show guide'}
            </button>
          </div>
          {onboardOpen && (
            <div className="grid gap-3 p-6 sm:grid-cols-2 sm:p-8 lg:grid-cols-5">
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
<div className="text-[28px] font-semibold leading-none tracking-tight tabular-nums">{s.value}</div>
<div className="mt-2 text-[13px] text-ink-muted">{s.label}</div>
</div>
))}
</section>


{/* Generator */}
<section id="section-create" className="relative mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
<PanelLoader scope="create" />
<div className="border-b border-line px-6 py-5 sm:px-8">
<div className="flex items-center gap-2">
<span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Step 1 · Create</span>
<h2 className="text-headline font-semibold">Content Generator</h2>
</div>
<p className="mt-1 text-[13px] text-ink-muted">Describe your idea, pick what you want it to be, then Generate.</p>
</div>
<div className="grid gap-0 lg:grid-cols-2">
{/* Controls */}
<div id="content-generator" className="space-y-5 p-6 sm:p-8">
{/* Which AI wrote it is a preference, not a decision most people need to
    make — and a dropdown of raw model identifiers ("gpt-4o-mini") is not
    something a coordinator can choose between. The good default stays
    selected; anyone who does care opens this. */}
<details className="group">
<summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-ink-muted transition hover:text-ink">
<span aria-hidden className="transition-transform group-open:rotate-90">›</span>
Writing with {PROVIDERS.find(p => p.id === provider)?.label.replace(/\s*\(.*\)$/, '')} · change
</summary>
<div className="mt-3">
<label htmlFor="gen-model" className="mb-2 block text-[12px] font-medium uppercase tracking-wide text-ink-muted">Model</label>
<div className="flex flex-wrap items-center gap-2">
{PROVIDERS.map(p => (
<button key={p.id} onClick={() => setProvider(p.id)}
className={'rounded-full px-4 py-2 text-[13px] font-medium transition-all ' + (provider === p.id ? 'bg-ink text-white shadow-soft' : 'bg-subtle text-ink-muted ring-1 ring-line hover:text-ink')}>
{p.label}
</button>
))}
<select id="gen-model" value={model} onChange={e => setModel(e.target.value)}
className="rounded-full bg-subtle px-4 py-2 text-[13px] font-medium text-ink ring-1 ring-line focus:ring-accent">
{currentModels.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
</select>
</div>
</div>
</details>

<div>
<p id="gen-format-label" className="mb-2 block text-[12px] font-medium uppercase tracking-wide text-ink-muted">Format</p>
<div className="flex flex-wrap gap-2" role="group" aria-labelledby="gen-format-label">
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
<label htmlFor="trend-input" className="block text-[12px] font-medium uppercase tracking-wide text-ink-muted">Trending in stem cell therapy</label>
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
<input id="trend-input" value={newTrend} onChange={(e) => setNewTrend(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTrend(); } }}
placeholder="Add a trending topic to track…"
className="min-w-0 flex-1 rounded-full bg-subtle px-3 py-1.5 text-[12px] text-ink ring-1 ring-line placeholder:text-ink-faint focus:ring-accent" />
<button type="button" onClick={addTrend} className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90">Add</button>
</div>
</div>

<div>
<label htmlFor="gen-idea" className="mb-2 block text-[12px] font-medium uppercase tracking-wide text-ink-muted">Your idea</label>
<textarea id="gen-idea" value={prompt} onChange={e => setPrompt(e.target.value)} onBlur={e => publishTopic(e.target.value)} rows={5}
placeholder="e.g. 3 Instagram captions about exosome therapy benefits for athletes"
className="w-full resize-none rounded-2xl bg-subtle p-4 text-[14px] text-ink ring-1 ring-line placeholder:text-ink-faint focus:ring-accent" />
</div>

<div className="flex flex-wrap items-center gap-3">
<button onClick={generate} disabled={loading || !prompt.trim()}
className="inline-flex items-center gap-2 rounded-full bg-accent px-6 py-2.5 text-[14px] font-semibold text-white shadow-soft transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">
{loading ? (<><span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />Generating…</>) : 'Generate'}
</button>
{err && <span className="text-[13px] text-danger">{err}</span>}
<a
href={semrushUrl(prompt)}
target="_blank"
rel="noopener noreferrer"
className="inline-flex items-center gap-1 rounded-full px-4 py-2.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">
🔑 Keyword research
</a>
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
{proc && (
  <div className="mb-3">
    <ProcessTracker title="Creating your content pack" steps={proc} onClose={() => setProc(null)} />
  </div>
)}
{keywordSource === 'semrush' && keywordsApplied.length > 0 && (
  <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-xl bg-emerald-50 p-2.5 ring-1 ring-emerald-100">
    <span className="mr-1 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">🔑 Keywords applied</span>
    {keywordsApplied.map((k, i) => (
      <span key={k + i} className="rounded-full bg-white px-2 py-0.5 text-[11px] text-emerald-800 ring-1 ring-emerald-200">{k}</span>
    ))}
  </div>
)}
{keywordSource === 'none' && output && (
  <p className="mb-3 text-[11px] text-ink-faint">{semrushDraftNote(keywordReason as any)}</p>
)}
{output && genImage?.url ? (
  <div className="mb-3 overflow-hidden rounded-2xl ring-1 ring-line">
    <a href={genImage.url} target="_blank" rel="noopener noreferrer" title="Open full size">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={genImage.url} alt={genImage.alt || 'AI hero image'} className={"max-h-96 w-full object-cover transition hover:opacity-95 " + (genImageLoading ? 'opacity-50' : '')} />
    </a>
    <div className="flex flex-wrap items-center gap-2 bg-white px-3 py-1.5">
      {genImage.verification?.textDetected ? (
        <span className="rounded-full bg-red-600/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(genImage.verification?.issues || []).join(' · ') || 'Text detected — content images must be text-free'}>✗ text in image — reroll</span>
      ) : genImage.verification?.status === 'approved' ? (
        <span className="rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white" title={'Machine-verified text-free' + (genImage.verification?.score != null ? ' · ' + genImage.verification.score + '/100' : '')}>✓ verified</span>
      ) : genImage.verification?.status === 'flagged' ? (
        <span className="rounded-full bg-amber-500/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(genImage.verification?.issues || []).join(' · ')}>⚠ flagged — reroll recommended</span>
      ) : null}
      <span className="text-[11px] text-ink-faint">🖼 AI hero image ({genImage.model || 'OpenAI'}) — saved on the draft, attaches when you schedule. Click to view full size.</span>
      <button type="button" onClick={regenGenImage} disabled={genImageLoading}
        className="ml-auto rounded-full px-3 py-1 text-[12px] font-medium text-accent ring-1 ring-line transition hover:bg-subtle disabled:opacity-50">
        {genImageLoading ? 'Regenerating…' : '↻ New image'}
      </button>
    </div>
  </div>
) : output && genImageLoading ? (
  <div className="mb-3 flex items-center gap-2 rounded-2xl border border-dashed border-line bg-white px-4 py-3 text-[12px] text-ink-muted">
    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
    Generating hero image…
  </div>
) : null}
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


{/* Step 2 · Images — every generated + verified visual, right after Create.
    Folded by default: a hero image is already generated and attached with
    every content pack, so opening this is for making EXTRA visuals. */}
<CollapsibleSection
  id="section-images"
  eyebrow="Step 2 · Images"
  title="AI Image Studio"
  summary="Every pack already comes with a verified hero image. Open this to make more, or to look through the ones you have."
>
<ImageStudio />
</CollapsibleSection>

{/* OpusClip — long-form to Shorts (video repurposing workspace) */}
<CollapsibleSection
  id="section-repurpose"
  eyebrow="Step 3 · Repurpose"
  title="Long-form to Shorts"
  summary="Turn one long YouTube or Vimeo video into a set of captioned vertical clips."
>
<div>
<div className="border-b border-line px-6 py-5 sm:px-8">
<div className="flex flex-wrap items-center justify-between gap-3">
<div className="flex items-center gap-2">
<span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Step 3 · Repurpose</span>
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
<label htmlFor="opus-source-url" className="mb-2 block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Source video</label>
<input
id="opus-source-url"
type="url"
value={opUrl}
onChange={e => setOpUrl(e.target.value)}
placeholder="https://youtube.com/watch?v=…  or  https://vimeo.com/…"
aria-invalid={Boolean(opError) || undefined}
aria-describedby="opus-source-help"
className={"w-full rounded-xl bg-white px-4 py-3 text-[14px] text-ink shadow-soft ring-1 transition placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent " + (opError ? "ring-danger" : "ring-line")}
/>
<p id="opus-source-help" className="mt-1.5 text-[12px]" role="status">
{opError ? (
<span className="font-medium text-danger">{opError}</span>
) : opParsed.ok ? (
<span className="font-medium text-success">{opParsed.source} video {opParsed.id} — ready to clip.</span>
) : (
<span className="text-ink-muted">Paste a YouTube or Vimeo link. Opus cannot fetch anything else.</span>
)}
</p>
<div className="mt-4 grid gap-3 sm:grid-cols-2">
<div>
<label htmlFor="opus-project-title" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Project title <span className="text-ink-muted normal-case">(optional)</span></label>
<input
id="opus-project-title"
type="text"
value={opTitle}
onChange={e => setOpTitle(e.target.value)}
placeholder="e.g. Ben Rothwell — Recovery"
className="w-full rounded-xl bg-white px-3 py-2.5 text-[13px] text-ink shadow-soft ring-1 ring-line transition placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent"
/>
</div>
<div>
<label htmlFor="opus-caption-language" className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Caption language</label>
<select
id="opus-caption-language"
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
<div className="mt-5 flex flex-wrap items-center gap-3">
<button
type="button"
onClick={clipVideo}
disabled={opBusy || !opValid}
title={opValid ? undefined : 'Paste a valid YouTube or Vimeo link first'}
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
</div>
</CollapsibleSection>

{/* Publishing (Metricool) — compose, review flow, and live queue */}
<section id="section-publish" className="relative mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
<PanelLoader scope="publish" />
<div className="border-b border-line px-6 py-5 sm:px-8">
<div className="flex flex-wrap items-center justify-between gap-3">
<div className="flex items-center gap-3">
<span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-2xl bg-accent/10 text-accent text-[18px]">📣</span>
<div>
<span className="mb-1 inline-block rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">Step 4 · Schedule</span><h2 className="text-[18px] font-semibold text-ink">Publishing</h2>
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
<h3 className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Schedule a post</h3>
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
<label htmlFor="composer-datetime" className="text-[12px] font-medium text-ink-muted">When should it go out?</label>
<span className="text-[11px] text-ink-faint">All times {scheduleTzLabel()} time</span>
</div>
<div className="mt-1 flex flex-wrap gap-2">
{/* Computed on the schedule clock: setHours() on a browser Date made
    "Tomorrow" mean tomorrow *there*, so an evening press west of Cancun
    picked the wrong day. */}
{[{ label: 'Tomorrow 9 AM', h: 9, d: 1 }, { label: 'Tomorrow 6 PM', h: 18, d: 1 }, { label: 'In 2 days, 12 PM', h: 12, d: 2 }].map((preset) => (
<button type="button" key={preset.label} onClick={() => setMDate(schedulePresetValue(preset.d, preset.h))}
className="rounded-full bg-subtle px-3 py-1 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:ring-accent">{preset.label}</button>
))}
</div>
<input
id="composer-datetime"
type="datetime-local"
value={mDate}
min={mMinDateTime}
onChange={(e) => setMDate(e.target.value)}
aria-invalid={mDateInPast || undefined}
className={"mt-2 w-full rounded-xl bg-subtle px-3 py-2 text-[14px] text-ink ring-1 focus:ring-accent " + (mDateInPast ? "ring-danger" : "ring-line")}
/>
{mDateInPast && (
<p className="mt-1.5 text-[12px] font-medium text-danger">That time has already passed. Pick a future time.</p>
)}
<label htmlFor="composer-text" className="mt-4 block text-[12px] font-medium text-ink-muted">What should it say?</label>
<textarea id="composer-text" value={mText} onChange={(e) => setMText(e.target.value)} rows={4} placeholder="Write your post… you can paste anything you generated above." aria-invalid={mTooLong || undefined} className={"mt-1 w-full resize-none rounded-2xl bg-subtle p-4 text-[14px] text-ink ring-1 placeholder:text-ink-faint focus:ring-accent " + (mTooLong ? "ring-danger" : "ring-line")} />
{mMedia ? ((() => { const isImage = /image/i.test(mMediaLabel) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(mMedia); return (<div className="mt-2 flex items-center justify-between gap-2 rounded-2xl bg-subtle p-2.5 ring-1 ring-line"><div className="flex min-w-0 items-center gap-2"><span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">{isImage ? '\uD83D\uDDBC' : '\uD83C\uDFAC'}</span><div className="min-w-0"><div className="truncate text-[13px] font-medium text-ink">{mMediaLabel || (isImage ? "Image attached" : "Video attached")}</div><div className="text-[11px] text-ink-faint">{isImage ? 'This image will be attached to the post.' : 'This video will be attached to the post.'}</div></div></div><button type="button" onClick={() => { setMMedia(""); setMMediaLabel(""); }} className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-white">Remove</button></div>); })()) : null}
<div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
<span className={mTooLong ? 'font-semibold text-danger' : 'text-ink-muted'}>
{mLimit
? mChars.toLocaleString() + ' / ' + mLimit.limit.toLocaleString() + ' characters · ' + networkLabel(mLimit.network) + ' is the tightest limit'
: mChars.toLocaleString() + ' characters'}
</span>
<span className="text-ink-muted">{mDate ? 'Goes out ' + fmtDateTime(mDate) : 'Pick a date and time — Metricool needs one'}</span>
</div>
{mTooLong && mLimit && (
<p className="mt-1.5 text-[12px] font-medium text-danger">
Too long for {networkLabel(mLimit.network)} by {mOverBy.toLocaleString()} character{mOverBy === 1 ? '' : 's'}. Trim it, or unselect that channel.
</p>
)}
<p className="mt-3 text-[12px] text-ink-muted">Every post lands in Metricool as a draft. You approve it there to publish.</p>
<div className="mt-4 flex flex-wrap items-center gap-3">
<button onClick={schedulePost} disabled={!mCanSend} title={mProblem || undefined} className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-semibold text-white shadow-soft transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">{mBusy ? 'Sending…' : 'Send to Metricool for review'}</button>
<a href={metricoolPlannerUrl(activeBlogId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2.5 text-[13px] font-medium text-ink ring-1 ring-line transition hover:ring-accent">Open in Metricool ↗</a>
</div>
{mStatus && <p className="mt-3 rounded-xl bg-subtle px-3 py-2 text-[13px] text-ink-muted ring-1 ring-line">{mStatus}</p>}
{mProblem && !mBusy && (
<p className="mt-3 text-[12px] font-medium text-ink-muted" role="status">{mProblem}</p>
)}
<p className="mt-3 text-[11px] text-ink-muted">Nothing publishes automatically — it lands in Metricool as a draft for you to approve.</p>
</div>
<div className="p-6 sm:p-8 lg:col-span-2">
<div className="mb-3 flex items-center justify-between gap-2">
<h3 className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Connection health</h3>
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
<div className="flex items-center justify-between gap-2">
<label className="text-[12px] font-medium uppercase tracking-wide text-ink-muted">Your publishing queue</label>
{postsLoading && <span className="text-[11px] text-ink-faint">Refreshing…</span>}
</div>
{loadError && (
<div className="mt-2 rounded-2xl bg-amber-50 p-4 text-[12px] text-amber-800 ring-1 ring-amber-200" role="status">{loadError}</div>
)}
{safePosts.length === 0 && !postsLoading && !loadError && (
<div className="mt-2 rounded-2xl bg-subtle p-4 text-center text-[12px] text-ink-faint ring-1 ring-line">Nothing in the queue yet. Anything you schedule here, on the calendar or from a template lands in this list.</div>
)}
{safePosts.length > 0 && (
<ul className="mt-2 space-y-2">
{safePosts.slice(0, 6).map((p: any, i: number) => {
const meta = postStatusMeta(p?.status);
const tone = meta.tone === 'amber' ? 'bg-amber-50 text-amber-700 ring-amber-100' : meta.tone === 'green' ? 'bg-emerald-50 text-emerald-700 ring-emerald-100' : 'bg-blue-50 text-blue-700 ring-blue-100';
const id = String(p?.id || '');
return (
<li key={id || i} className="rounded-2xl bg-white p-3 ring-1 ring-line">
<div className="flex items-center justify-between gap-2">
<span className={'rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ' + tone}>{meta.label}</span>
<span className="text-[11px] tabular-nums text-ink-faint">{fmtDateTime(p?.publication_date)}</span>
</div>
<p className="mt-1.5 line-clamp-2 text-[13px] text-ink">{p?.text || 'Scheduled post'}</p>
<div className="mt-2 flex flex-wrap items-center gap-2">
{(p?.providers || []).map((n: string) => (
<span key={n} className="rounded-full bg-subtle px-2 py-0.5 text-[11px] text-ink-muted ring-1 ring-line">{n}</span>
))}
{id && rescheduleId !== id && (
<span className="ml-auto flex items-center gap-3">
<button type="button" onClick={() => { setRescheduleId(id); setRescheduleAt(''); }} className="text-[11px] font-medium text-accent hover:underline">Reschedule</button>
<button type="button" onClick={() => deletePost(id)} className="text-[11px] font-medium text-danger hover:underline">Delete</button>
</span>
)}
</div>
{id && rescheduleId === id && (
<div className="mt-2 flex flex-wrap items-center gap-2">
<input type="datetime-local" value={rescheduleAt} onChange={(e) => setRescheduleAt(e.target.value)} className="rounded-xl bg-subtle px-2.5 py-1.5 text-[12px] text-ink ring-1 ring-line" />
<button type="button" disabled={!rescheduleAt} onClick={() => saveReschedule(id)} className="rounded-full bg-accent px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-50">Save</button>
<button type="button" onClick={() => { setRescheduleId(null); setRescheduleAt(''); }} className="text-[12px] text-ink-muted hover:text-ink">Cancel</button>
</div>
)}
</li>
);
})}
</ul>
)}
</div>
<div className="mt-6 flex flex-wrap gap-3 border-t border-line pt-5 text-[12px]">
<a href={'https://app.metricool.com/inbox'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">💬 Open Inbox ↗</a>
<a href={'https://app.metricool.com/smartlink?blogId=' + encodeURIComponent(activeBlogId) + '&userId=3377431'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">🔗 Smartlinks ↗</a>
<a href={'https://app.metricool.com/planner/calendar?blogId=' + encodeURIComponent(activeBlogId) + '&userId=3377431'} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">📅 Full planner ↗</a>
</div>
</div>
</div>
              {/* Semrush Intelligence — the full SEO command center (domain
                  overview, rankings, competitors, backlinks, site health) plus
                  the keyword brain that pre-filters every draft */}
<CollapsibleSection
  id="section-semrush"
  title="SEO intelligence"
  summary="Rankings, competitors, backlinks and site health for cellularhopeinstitute.com. Keyword research already runs on every draft — this is for looking deeper."
>
              <div className="border-t border-line p-6 sm:p-8">
                <SemrushPanel
                  initialTopic={researchTopicText || prompt}
                  onUseTopic={(t) => {
                    setPrompt(t);
                    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { /* noop */ }
                  }}
                />
              </div>
</CollapsibleSection>

              {/* AI Research & Draft Copilot — full-width band below the two columns */}
<CollapsibleSection
  id="section-research"
  title="Research a topic first"
  summary="Angles, keywords, hashtags and hooks for a topic before you write. Open when you want the legwork done for you."
>
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
                      id="research-topic"
                      aria-label="Topic to research"
                      type="text"
                      value={researchTopicText}
                      onChange={(e) => setResearchTopicText(e.target.value)}
                      onBlur={(e) => publishTopic(e.target.value, "research")}
                      onKeyDown={(e) => { if (e.key === "Enter") runResearch(); }}
                      placeholder="e.g. stem cell therapy for knee pain"
                      className="flex-1 rounded-xl bg-white px-3.5 py-2.5 text-[13px] text-ink ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    />
                    <select
                      id="research-network"
                      aria-label="Network to draft for"
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
                  <div className="mt-3 flex items-center gap-2">
                    <a
                      href={semrushUrl(researchTopicText)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-indigo-600 transition hover:text-indigo-700">
                      🔑 Research keywords in Semrush
                    </a>
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
                                <li key={i}>
                                  <button type="button" onClick={() => applyIdea(a)} title="Draft this angle"
                                    className="w-full rounded-lg px-1.5 py-1 text-left text-[13px] text-ink transition hover:bg-indigo-50 hover:text-indigo-900">
                                    &bull; {a}
                                  </button>
                                </li>
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
                              <button key={i} type="button" onClick={() => applyIdea(String(k?.term || ''), 'research-keyword')}
                                title={(k?.why ? k.why + ' — ' : '') + 'Draft with this keyword'}
                                className="rounded-full bg-indigo-50 px-3 py-1 text-[12px] text-indigo-800 ring-1 ring-indigo-100 transition hover:bg-indigo-100">{k.term}</button>
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
                              <li key={i}>
                                <button type="button" onClick={() => applyIdea(h, 'research-hook')} title="Draft from this hook"
                                  className="w-full rounded-lg px-1.5 py-1 text-left text-[13px] text-ink transition hover:bg-indigo-50 hover:text-indigo-900">
                                  &bull; {h}
                                </button>
                              </li>
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
</CollapsibleSection>

</section>


{/* Autopilot: dynamic-template runs waiting for review — everything but publish */}
<AutopilotQueue />

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
<div className="truncate px-3 py-2 text-[12px] font-medium text-ink">{draftLabel(d?.topic || d?.title, 'Clip')}</div>
</button>
);
})}
</div>
</div>
);
})()}
{safeDrafts.length === 0 ? (
<div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-line py-12 text-center">
{loadError ? (
<>
<div className="text-[14px] font-medium text-ink-muted">We could not load your drafts</div>
<div className="mt-1 max-w-sm text-[12px] text-ink-faint">{loadError}</div>
</>
) : (
<>
<div className="text-[14px] font-medium text-ink-muted">No drafts yet</div>
<div className="mt-1 text-[12px] text-ink-faint">Generate something above to get started.</div>
</>
)}
</div>
) : (
<>
<ul className="divide-y divide-line">
{safeDrafts.map((d, i) => {
const title = draftLabel(d && (d.title || d.topic || d.name));
const body = (d && (d.body || d.instagram || d.text || d.content)) || '';
return (
<li onClick={() => openDraft(d)} role="button" tabIndex={0} key={(d && (d.id || d._id)) || i} className="cursor-pointer rounded-xl transition hover:bg-subtle/60 flex items-start gap-4 py-4">
{d?.pack?.kind === 'clip' && d?.pack?.thumb ? (
<div className="mb-2 overflow-hidden rounded-lg ring-1 ring-black/10">
{/* eslint-disable-next-line @next/next/no-img-element */}
<img src={d.pack.thumb} alt="Video still" className="h-32 w-full object-cover" />
</div>
) : null}
{d?.pack?._image?.url && d?.pack?.kind !== 'clip' ? (
// eslint-disable-next-line @next/next/no-img-element
<img src={d.pack._image.url} alt={d.pack._image.alt || ''} className="mt-0.5 h-14 w-14 shrink-0 rounded-xl object-cover ring-1 ring-line" />
) : (
<div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-subtle text-[13px] font-semibold text-ink-muted ring-1 ring-line">{i + 1}</div>
)}
<div className="min-w-0">
<div className="flex min-w-0 items-center gap-2">
<span className="truncate text-[14px] font-medium text-ink">{String(title)}</span>
{d?.pack?._semrush?.source === 'semrush' && (
<span title={'Semrush keyword research applied — primary: ' + (d.pack._semrush.primary || 'n/a')} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">🔑 Semrush ✓</span>
)}
</div>
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
<div className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7" onClick={(e) => e.stopPropagation()}>
<PanelLoader scope="draft-modal" />
<div className="mb-4 flex items-start justify-between gap-4">
{editingDraft ? (
<input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} aria-label="Draft title" placeholder="Draft title"
className="min-w-0 flex-1 rounded-xl bg-subtle px-3 py-2 text-[16px] font-semibold text-ink ring-1 ring-line focus:ring-accent" />
) : (
<h3 className="text-headline font-semibold text-ink">{draftLabel(selectedDraft?.title || selectedDraft?.topic || selectedDraft?.name, 'Draft')}</h3>
)}
<div className="flex shrink-0 items-center gap-2">
{!editingDraft ? (
<button onClick={() => startEditDraft(selectedDraft)} className="rounded-xl px-3 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">Edit</button>
) : null}
{!editingDraft && !(selectedDraft && selectedDraft.pack && selectedDraft.pack.kind === "clip") ? (<button onClick={() => prefillComposerFromDraft(selectedDraft)} className="rounded-xl bg-accent px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-accent-hover">Schedule / Publish</button>) : null}
<button onClick={() => { setSelectedDraft(null); setEditingDraft(false); }} className="rounded-xl px-3 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">Close</button>
</div>
</div>
{/* Semrush provenance: proof that keyword research ran before this draft was written */}
{selectedDraft?.pack?._semrush?.source === 'semrush' && !editingDraft ? (
<div className="mb-4 rounded-2xl bg-emerald-50/70 p-3.5 ring-1 ring-emerald-100">
<div className="flex flex-wrap items-center gap-2">
<span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2.5 py-0.5 text-[11px] font-semibold text-white">🔑 Semrush keyword research applied</span>
{selectedDraft.pack._semrush.fromCache ? <span className="text-[11px] text-emerald-700">cached · 0 units</span> : null}
{selectedDraft.pack._semrush.checkedAt ? <span className="ml-auto text-[11px] text-emerald-700/70">{new Date(selectedDraft.pack._semrush.checkedAt).toLocaleString()}</span> : null}
</div>
<div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px]">
{selectedDraft.pack._semrush.primary ? (
<span className="rounded-full bg-white px-2.5 py-0.5 font-semibold text-emerald-800 ring-1 ring-emerald-200">
{selectedDraft.pack._semrush.primary}
{selectedDraft.pack._semrush.volume != null ? ' · ' + Number(selectedDraft.pack._semrush.volume).toLocaleString() + '/mo' : ''}
{selectedDraft.pack._semrush.difficulty != null ? ' · KD ' + selectedDraft.pack._semrush.difficulty : ''}
</span>
) : null}
{(Array.isArray(selectedDraft.pack._semrush.keywords) ? selectedDraft.pack._semrush.keywords.slice(1, 7) : []).map((k: string, ki: number) => (
<span key={k + ki} className="rounded-full bg-white px-2 py-0.5 text-emerald-800 ring-1 ring-emerald-200">{k}</span>
))}
{selectedDraft.pack._semrush.intent ? <span className="text-[11px] text-emerald-700">intent: {selectedDraft.pack._semrush.intent}</span> : null}
</div>
</div>
) : null}
{selectedDraft?.pack && selectedDraft.pack.kind !== 'clip' && selectedDraft.pack._semrush && selectedDraft.pack._semrush.source !== 'semrush' && !editingDraft ? (
<p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800 ring-1 ring-amber-200">{semrushDraftNote(selectedDraft.pack._semrush.reason)}</p>
) : null}
{selectedDraft?.pack?._image?.url && selectedDraft?.pack?.kind !== 'clip' && !editingDraft ? (
<div className="mb-4 overflow-hidden rounded-2xl ring-1 ring-line/60">
<a href={selectedDraft.pack._image.url} target="_blank" rel="noopener noreferrer" title="Open full size">
{/* eslint-disable-next-line @next/next/no-img-element */}
<img src={selectedDraft.pack._image.url} alt={selectedDraft.pack._image.alt || 'AI hero image'} className={"w-full object-cover transition hover:opacity-95 " + (modalImgBusy ? 'opacity-50' : '')} />
</a>
<div className="flex flex-wrap items-center gap-2 bg-subtle/60 px-3 py-2">
{selectedDraft.pack._image.verification?.textDetected ? (
<span className="rounded-full bg-red-600/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(selectedDraft.pack._image.verification?.issues || []).join(' · ') || 'Text detected — content images must be text-free'}>✗ text in image — reroll</span>
) : selectedDraft.pack._image.verification?.status === 'approved' ? (
<span className="rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white" title={'Machine-verified text-free' + (selectedDraft.pack._image.verification?.score != null ? ' · ' + selectedDraft.pack._image.verification.score + '/100' : '')}>✓ verified</span>
) : selectedDraft.pack._image.verification?.status === 'flagged' ? (
<span className="rounded-full bg-amber-500/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(selectedDraft.pack._image.verification?.issues || []).join(' · ')}>⚠ flagged: {(selectedDraft.pack._image.verification?.issues || []).slice(0, 2).join('; ')}</span>
) : null}
<span className="text-[11px] text-ink-faint">🖼 AI hero image ({String(selectedDraft.pack._image.model || 'OpenAI')}) — attaches automatically when you schedule or approve. Click to view full size.</span>
<button type="button" onClick={() => regenDraftImage(selectedDraft)} disabled={modalImgBusy}
className="ml-auto rounded-full px-3 py-1 text-[12px] font-medium text-accent ring-1 ring-line transition hover:bg-white disabled:opacity-50">
{modalImgBusy ? 'Regenerating…' : '↻ New image'}
</button>
</div>
</div>
) : null}
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
<textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={14} aria-label="Draft content" placeholder="Draft content..."
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
  if (selectedDraft?.pack?.kind === 'image') {
    return (
      <p className="rounded-2xl bg-subtle/50 p-4 text-[13px] text-ink-muted ring-1 ring-line/60">
        Standalone AI image created in the Image Studio — schedule it, or reroll it with &ldquo;New image&rdquo; above.
      </p>
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
