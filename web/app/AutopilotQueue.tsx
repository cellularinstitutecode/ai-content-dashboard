'use client';

// Autopilot review queue: every dynamic-template occurrence the engine has
// researched, drafted and scored, waiting for the ONE thing it never does
// itself — your approval. Approve pushes a Metricool DRAFT (never a live
// publish); Skip discards the occurrence.

import { useCallback, useEffect, useRef, useState } from 'react';
import ProcessTracker, { makeSteps, stepActive, stepError, stepsDone, type ProcessStep } from '@/components/ProcessTracker';
import { announce, onRefresh } from '@/components/refreshBus';
import { PanelLoader } from '@/components/LoadingScreen';
import { friendlyError, friendlyErrorFromResponse, friendlyImageError } from '@/lib/friendly-error';
import { fmtScheduleSlot } from '@/lib/schedule-clock';
import { describeFailure, historyForDisplay, type RunLogEntry } from '@/lib/run-failure';
import { MAX_ATTEMPTS } from '@/lib/planner-constants';
import { plannerImageFor } from '@/lib/planner-image';
import { imageUnshippable } from '@/lib/image-verdict';
import { citationLabel, type CitationCheck } from '@/lib/citation';
import { varietyLabels } from '@/lib/strategy-variety';
import { claimSupportNote, type ClaimSupportStamp } from '@/lib/claim-support';
import { fixPlan, fixRunning, fixStepsLabel, runFixInput, type FixStatus } from '@/lib/fix-plan';
import FixStatusLine from '@/components/FixStatusLine';
import ImageEditPanel, { okToSpend, type ImageAction } from '@/components/ImageEditPanel';
import LibraryPicker from '@/components/LibraryPicker';
import { creditLabel } from '@/lib/cover-edit';

// The visible pipeline an engine run walks through. The tick call does all of
// this server-side in one request; the tracker paces the display so the viewer
// can follow the process live.
const ENGINE_STEPS = [
  { id: 'plan', label: 'Planning occurrences', detail: 'Reading templates and upcoming slots…' },
  { id: 'research', label: 'Researching angles', detail: 'Keyword briefs, ranking defense, real searcher questions…' },
  { id: 'draft', label: 'Drafting content', detail: 'Writing each occurrence with the full research brief…' },
  { id: 'score', label: 'Scoring & queueing', detail: 'Quality-scoring drafts and lining them up for your review…' },
];

// Per-run mini pipeline, mapped from the run.state the engine reports.
const RUN_STAGES = [
  { id: 'research', label: 'Research' },
  { id: 'draft', label: 'Draft' },
  { id: 'score', label: 'Score' },
  { id: 'review', label: 'Review' },
];
function runStageSteps(state: string): ProcessStep[] {
  const activeId = state === 'planned' ? 'research' : state === 'researched' ? 'draft' : state === 'drafted' ? 'score' : 'review';
  const base = makeSteps(RUN_STAGES);
  return state === 'ready_for_review' ? stepsDone(base) : stepActive(base, activeId);
}

type Angle = {
  type: 'answer' | 'commercial' | 'defense' | 'opportunity';
  query: string;
  seedTopic: string;
  rationale: string;
  volume: number | null;
  difficulty: number | null;
  strategistNote?: string;
  provenPerformer?: boolean;
  media?: { url: string; title: string } | null;
  // Weekly-strategy occurrences: the shape and reader dealt for this week.
  format?: string;
  audience?: string;
  /** The FIX button's progress and result (lib/fix-plan.ts fixView). */
  fix?: FixStatus | null;
};

type RunScore = {
  total: number;
  breakdown: Record<string, number>;
  safetyFlags: { code: string; message: string }[];
  critique: string[];
  promotionFlags?: string[];
  openingRepeat?: boolean;
};

type PackImage = {
  url: string;
  alt?: string;
  model?: string;
  variant?: number;
  verification?: { status?: 'approved' | 'flagged' | 'unchecked'; score?: number | null; issues?: string[]; textDetected?: boolean; bannedProp?: boolean; headTopPct?: number | null };
  /** Titled covers: the photo with its title set on top (lib/title-cover.ts). */
  titled?: { title: string; photoUrl: string; custom?: boolean };
  /** The team's notes the last take was made with (lib/cover-edit.ts). */
  direction?: string;
  /** Image generations on this draft so far. */
  takes?: number;
  source?: string;
  /** A library photo that went through the brand's colour filter (lib/library-cover.ts). */
  brandGraded?: boolean;
  libraryName?: string;
};

/** A weekly-planner draft whose picture predates the title cover — it is refreshed once. */
function needsPlannerCover(pack: Run['pack']): boolean {
  if (!pack || !pack._image?.url || pack._image.titled) return false;
  if (['library', 'upload'].includes(String(pack._image.source || ''))) return false;
  return Boolean(plannerImageFor(pack));
}

type Run = {
  id: string;
  draft_id: string | null;
  template_name: string;
  /** The template's channels. */
  template_providers?: string[];
  /** The run writes the WordPress article (the server's wantsBlog rule). */
  writes_article?: boolean;
  scheduled_for: string;
  state: string;
  angle: Angle | null;
  score: RunScore | null;
  pack: (Record<string, string> & { _image?: PackImage; _imageOptions?: PackImage[]; _compliance?: { citation?: CitationCheck | null }; _claimSupport?: ClaimSupportStamp | null }) | null;
  recent_angles?: { query: string; type: string }[];
  // The engine's own record of what happened to this run, and how many tries it
  // has spent. Both were already fetched by /api/autopilot/runs (log) or
  // trivially available (attempts) and neither reached the screen — so a failed
  // run showed a hardcoded "check API keys" while the real reason sat unread in
  // the payload. See lib/run-failure.ts.
  log?: RunLogEntry[] | null;
  attempts?: number | null;
  // A finished post whose time has already passed (lib/review-queue.ts). It
  // can only go out at a new time, which the reviewer asks for explicitly.
  missed?: boolean;
};

const ANGLE_META: Record<Angle['type'], { label: string; cls: string }> = {
  answer: { label: 'Answer a searcher', cls: 'bg-sky-100 text-sky-700' },
  commercial: { label: 'Commercial intent', cls: 'bg-emerald-100 text-emerald-700' },
  defense: { label: 'Ranking defense', cls: 'bg-amber-100 text-amber-700' },
  opportunity: { label: 'Opportunity', cls: 'bg-indigo-100 text-indigo-700' },
};

const CHANNEL_KEYS = ['instagram', 'facebook', 'linkedin', 'blog'] as const;

// On the schedule clock, like every other time in the app — an Autopilot slot
// planned for 09:00 Cancun must not read as 07:00 to a viewer in Tijuana.
const fmtSlot = fmtScheduleSlot;

/**
 * One row under "Needs attention".
 *
 * This card used to render a single hardcoded sentence — "repeated errors;
 * check API keys, then retry" — for every failed run, whatever had actually
 * happened. Three unrelated things reach state 'failed' and only one of them is
 * ever plausibly a key; an expired run, which errored at nothing, was told to go
 * check its credentials. Meanwhile the engine's own account of the failure was
 * already in the payload and was being discarded one line before display.
 *
 * The decision and the wording live in lib/run-failure.ts, which is pure and
 * tested. This component only draws them.
 */
function FailedRun({ run, busy, onRetry, onDismiss }: { run: Run; busy: boolean; onRetry: () => void; onDismiss: () => void }) {
  const [open, setOpen] = useState(false);
  const failure = describeFailure(run.log, run.attempts, MAX_ATTEMPTS);
  const history = historyForDisplay(run.log);

  return (
    <div className="rounded-xl bg-red-50 px-4 py-2.5 text-[13px] ring-1 ring-red-100">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-red-700">
          <div>
            <span className="font-medium">{run.template_name}</span>
            <span className="text-red-700/80"> · {fmtSlot(run.scheduled_for)}</span>
            <span className="text-red-700/80"> — {failure.headline}</span>
            {/* Which step it died at, taken from the engine's own log[].step.
                NOT ProcessTracker/runStageSteps: those map `state`, and a failed
                run's state is just 'failed', which falls through that ternary to
                activeId 'review' — so a run that died in research would be drawn
                as active at Review. A wrong stage is worse than no stage, and
                the log already records the right one. */}
            {failure.step && failure.step !== 'expired' && (
              <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-[1px] text-[11px] font-medium">
                at {failure.step}
              </span>
            )}
          </div>
          {/* The engine's own sentence, not ours. */}
          <p className="mt-1 break-words text-[12px] text-red-700/90">{failure.advice}</p>
        </div>
        {/* Retry is offered only where it can work. On an expired run it would
            restart the pipeline and hand Metricool a post dated in the past. */}
        {failure.retryable && (
          <button
            type="button"
            onClick={onRetry}
            disabled={busy}
            className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium text-red-700 ring-1 ring-red-200 transition hover:bg-white disabled:opacity-50"
          >
            {busy ? 'Retrying…' : 'Retry'}
          </button>
        )}
        {/* Always offered. A failure nobody can act on used to stay here for
            good and, in numbers, push the posts waiting for approval off the
            queue altogether. */}
        <button
          type="button"
          onClick={onDismiss}
          disabled={busy}
          className="shrink-0 rounded-full px-3 py-1 text-[12px] font-medium text-red-700/80 ring-1 ring-red-200 transition hover:bg-white disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>

      {/* The last entry says what broke. The thirty before it say whether it was
          always broken — which is the question you ask on the second failure. */}
      {history.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1.5 text-[11px] font-medium text-red-700/80 underline decoration-red-300 underline-offset-2 hover:text-red-800"
          >
            {open ? 'Hide history' : 'Show what happened'}
          </button>
          {open && (
            <ol className="mt-1.5 space-y-1 border-t border-red-100 pt-1.5">
              {history.map((e, i) => (
                <li key={i} className="flex gap-2 text-[11px] text-red-700/90">
                  <span className="shrink-0 font-medium">{e.step}</span>
                  <span className="shrink-0 tabular-nums text-red-700/60">{e.at ? fmtSlot(e.at) : '—'}</span>
                  <span className="min-w-0 break-words">{e.note}</span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

export default function AutopilotQueue() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  // Per-card work sets. Each card owns its own busy/image state, so one card
  // generating images or redrafting never locks the others — several posts
  // can be edited at the same time.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [engineBusy, setEngineBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openChannel, setOpenChannel] = useState<Record<string, string>>({});
  const [imagingIds, setImagingIds] = useState<Set<string>>(new Set());
  const [regenIds, setRegenIds] = useState<Set<string>>(new Set());
  // "Show me a few": how many propositions are still being made for this run.
  const [optionsIds, setOptionsIds] = useState<Set<string>>(new Set());
  const addTo = (set: typeof setBusyIds, id: string) => set((prev) => new Set(prev).add(id));
  const dropFrom = (set: typeof setBusyIds, id: string) => set((prev) => { const next = new Set(prev); next.delete(id); return next; });
  // Progress scopes for one card: its image block and the card as a whole.
  // Scoped per run so the loader covers that section only, not the panel.
  const imgScope = (id: string) => 'autopilot-img:' + id;
  const runScope = (id: string) => 'autopilot-run:' + id;
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Draft ids we already asked an image for this session — avoids re-requesting
  // on every poll while a generation is in flight or after it failed.
  const imageAsked = useRef<Set<string>>(new Set());

  /** The card whose library grid is open. */
  const [libraryFor, setLibraryFor] = useState<string | null>(null);
  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
    try {
      const r = await fetch('/api/autopilot/runs');
      // A failure here used to fall through to the first-run onboarding empty
      // state, so a dead engine and a brand-new install looked identical - and
      // the empty state sent the user off to fix a template that was fine.
      if (!r.ok) { setLoadError(await friendlyErrorFromResponse(r, 'We could not load the Autopilot queue.')); setLoading(false); return; }
      const j = await r.json().catch(() => ({}));
      if (Array.isArray(j.runs)) { setRuns(j.runs); setLoadError(null); }
    } catch (e) { setLoadError(friendlyError(e, 'We could not reach the server to load the Autopilot queue.')); }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Interconnection: reload the queue when another panel announces autopilot
  // changes, and gently poll while runs are mid-pipeline so server-side
  // progress (cron ticks, long engine steps) is visible without a reload.
  useEffect(() => {
    return onRefresh((scopes) => {
      // 'templates' matters too: applying or deleting a template changes what
      // the engine will queue next. 'images' too: rerolling a run's hero image
      // from the Image Studio (or anywhere else) must update the review card
      // here, live.
      if (scopes.includes('autopilot') || scopes.includes('templates') || scopes.includes('images')) void load({ quiet: true });
    });
  }, [load]);
  const hasInFlight = runs.some((r) => ['planned', 'researched', 'drafted'].includes(r.state));
  useEffect(() => {
    if (!hasInFlight) return;
    const t = setInterval(() => { void load({ quiet: true }); }, 20000);
    return () => clearInterval(t);
  }, [hasInFlight, load]);

  // Visual enrichment: every ready-for-review run gets its AI hero image
  // generated automatically (idempotent server-side), so the reviewer sees
  // exactly what will attach to the Metricool draft on approve.
  useEffect(() => {
    const needing = runs.filter(
      (r) => r.state === 'ready_for_review' && r.draft_id && r.pack && (!r.pack._image?.url || needsPlannerCover(r.pack)) && !imageAsked.current.has(r.draft_id)
    );
    if (!needing.length) return;
    let cancelled = false;
    (async () => {
      for (const r of needing.slice(0, 3)) {
        const draftId = r.draft_id as string;
        imageAsked.current.add(draftId);
        setImagingIds((prev) => new Set(prev).add(r.id));
        try {
          // Machine-initiated (poll) image request: the run's own progress
          // strip shows it — keep it off the panel overlay.
          await fetch('/api/drafts/image', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-chi-progress': 'quiet' },
            body: JSON.stringify({ id: draftId }),
          });
        } catch { /* best-effort */ }
        if (cancelled) return;
        setImagingIds((prev) => { const next = new Set(prev); next.delete(r.id); return next; });
      }
      if (!cancelled) { await load({ quiet: true }); announce('images', 'drafts', 'autopilot'); }
    })();
    return () => { cancelled = true; };
  }, [runs, load]);

  // While a FIX works in the background, re-read the queue every few seconds
  // so its progress and result show without a reload; when one finishes, the
  // rest of the app hears about the changed draft.
  const fixingIds = runs.filter((r) => fixRunning(r.angle)).map((r) => r.id).join(',');
  const wasFixing = useRef('');
  useEffect(() => {
    if (wasFixing.current && wasFixing.current !== fixingIds) {
      announce('drafts', 'images');
      // The run's own stamp now says what FIX did (FixStatusLine); the panel
      // banner saying it is working would be stale from here on.
      setNote((n) => (n && /^FIX is working/.test(n) ? null : n));
    }
    wasFixing.current = fixingIds;
    if (!fixingIds) return;
    const t = window.setInterval(() => { void load({ quiet: true }); }, 5000);
    return () => window.clearInterval(t);
  }, [fixingIds, load]);

  async function act(id: string, action: 'approve' | 'skip' | 'run_now' | 'regenerate' | 'fix', extraNote?: string, schedule = false, redate = false) {
    addTo(setBusyIds, id);
    setErr(null);
    setNote(null);
    try {
      const r = await fetch('/api/autopilot/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chi-progress-scope': runScope(id) },
        body: JSON.stringify({ id, action, note: extraNote, schedule, redate }),
      });
      const j = await r.json().catch(() => ({}));
      // `message` first, `error` second. `error` is the machine code — the
      // route answers { error: 'not_advanced', message: 'The template “X” is
      // switched off…' } — so reading `error` alone showed a reviewer the bare
      // token `not_advanced` and threw away the sentence written for them.
      if (!r.ok) throw new Error(j?.message || j?.error || 'Action failed (' + r.status + ')');
      // FIX's progress lives on the card (angle.fix); its "working on it" note
      // would only sit in the banner after the card had already moved on.
      if (j?.note && action !== 'fix') setNote(String(j.note));
      await load({ quiet: true });
      // Interconnection: approving queues a Metricool draft (posts row) and
      // every action can touch drafts — update the rest of the dashboard.
      // 'autopilot' was declared as a scope but nothing ever announced it, so
      // the queue's own subscription could never fire. It does now.
      if (action === 'approve') announce('posts', 'stats', 'drafts', 'autopilot', 'insights');
      else announce('drafts', 'autopilot');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      dropFrom(setBusyIds, id);
    }
  }

  // Reject a hallucinated/off-brand image and get a fresh proposition: the
  // server advances the composition variant so every regenerate is a visibly
  // different take (hero shot → macro lab → lifestyle → still-life → …).
  /**
   * Three propositions, one after another, kept side by side.
   *
   * A blind reroll replaced the picture and the previous one was gone. These
   * are generated in sequence (each takes a couple of minutes) and stay on the
   * card until somebody picks one.
   */
  async function proposeImages(r: Run, count = 3) {
    if (!r.draft_id || regenIds.has(r.id) || optionsIds.has(r.id)) return;
    if (!okToSpend(r.pack?._image, count)) return;
    setErr(null);
    // ONE request for the whole set: the three pictures are generated in
    // parallel on the server and written once. Three separate requests took
    // five minutes end to end and wrote the draft back three times, so a set
    // could half-apply; this takes about as long as the slowest single take.
    addTo(setOptionsIds, r.id);
    try {
      const res = await fetch('/api/drafts/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chi-progress-scope': imgScope(r.id) },
        body: JSON.stringify({ id: r.draft_id, options: count }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || 'Image generation failed');
      // Part of a set can fail while the rest succeed — say so, rather than
      // quietly handing back two pictures when three were asked for.
      const made = Number(j?.made ?? 0);
      if (made && made < count) setErr('Made ' + made + ' of ' + count + ' — ' + String(j?.failed?.[0] || 'one take failed'));
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Image generation failed');
    }
    dropFrom(setOptionsIds, r.id);
    await load({ quiet: true });
    announce('images', 'drafts', 'autopilot');
  }

  /** Promote one proposition to the picture that ships. */
  async function chooseImage(r: Run, url: string) {
    if (!r.draft_id) return;
    setErr(null);
    try {
      const res = await fetch('/api/drafts/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chi-progress-scope': imgScope(r.id) },
        body: JSON.stringify({ id: r.draft_id, choose: url }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || 'Could not choose that image');
      await load({ quiet: true });
      announce('images', 'drafts', 'autopilot');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not choose that image');
    }
  }

  async function regenImage(r: Run) {
    // The panel is open by default, so a reroll asks first only on a draft
    // that has already had a few takes (lib/cover-edit.ts).
    if (r.pack?._image?.url && !okToSpend(r.pack._image, 1)) return;
    await editImage(r, { regenerate: true }, { label: 'regenerate', credits: 1, fallback: 'Image regeneration failed' });
  }

  /**
   * One request from the Edit image panel (or the reroll above): retitle, no
   * title, notes, or a new take with notes. The free ones finish in seconds;
   * the card shows the same "working" state either way.
   */
  async function editImage(r: Run, body: Record<string, unknown>, meta: ImageAction) {
    if (!r.draft_id || regenIds.has(r.id) || optionsIds.has(r.id)) return;
    addTo(setRegenIds, r.id);
    setErr(null);
    try {
      const res = await fetch('/api/drafts/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chi-progress-scope': imgScope(r.id) },
        body: JSON.stringify({ id: r.draft_id, ...body }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.message || j?.error || meta.fallback);
      await load({ quiet: true });
      announce('images', 'drafts', 'autopilot'); // fresh hero image → Image Studio + library update live
    } catch (e) {
      setErr(e instanceof Error ? e.message : meta.fallback);
    } finally {
      dropFrom(setRegenIds, r.id);
    }
  }

  const [engineProc, setEngineProc] = useState<ProcessStep[] | null>(null);
  const engineTimers = useRef<any[]>([]);
  function clearEngineTimers() { engineTimers.current.forEach((t) => clearTimeout(t)); engineTimers.current = []; }
  useEffect(() => () => clearEngineTimers(), []);

  async function runEngine() {
    setEngineBusy(true);
    setErr(null);
    setNote(null);
    clearEngineTimers();
    setEngineProc(stepActive(makeSteps(ENGINE_STEPS), 'plan'));
    // One server call does everything; pace the display through the stages.
    ([['research', 3000], ['draft', 10000], ['score', 25000]] as [string, number][]).forEach(([id, ms]) => {
      engineTimers.current.push(setTimeout(() => setEngineProc((p) => (p ? stepActive(p, id) : p)), ms));
    });
    try {
      const r = await fetch('/api/autopilot/tick', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      clearEngineTimers();
      if (!r.ok) throw new Error(j?.error || 'Engine tick failed');
      setEngineProc((p) => (p ? stepsDone(p) : p));
      setNote(
        'Engine ran: ' + (j.planned ?? 0) + ' occurrence(s) planned, ' +
        (j.advanced ?? 0) + ' step(s) advanced, ' + (j.ready ?? 0) + ' ready for review.'
      );
      await load();
      announce('drafts', 'stats', 'images', 'autopilot', 'semrush'); // engine creates drafts + images and spends Semrush units → sync every panel
    } catch (e) {
      clearEngineTimers();
      // The engine runs Claude for the words and OpenAI for the picture in one
      // call, so we do not know which account failed unless the body says. No
      // provider hint here on purpose: OpenAI is named only when it is named.
      const why = friendlyImageError(e, 'The engine could not finish this tick. Nothing was lost — run it again in a moment.');
      setEngineProc((p) => (p ? stepError(p, undefined, why) : p));
      setErr(why);
    } finally {
      setEngineBusy(false);
    }
  }

  const ready = runs.filter((r) => r.state === 'ready_for_review');
  const inFlight = runs.filter((r) => ['planned', 'researched', 'drafted'].includes(r.state));
  const failed = runs.filter((r) => r.state === 'failed');

  return (
    <section id="section-autopilot" className="relative mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
      <PanelLoader scope="autopilot" />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-5 sm:px-8">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            Autopilot
            <span className="rounded-full bg-subtle px-2 py-0.5 text-[11px] font-medium text-ink-muted">
              drafts everything · you approve
            </span>
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-muted">
            Dynamic templates research a fresh angle for every occurrence — keyword brief, ranking
            defense, real searcher questions — then draft, score and wait here. Nothing publishes without you.
          </p>
        </div>
        <button
          type="button"
          onClick={runEngine}
          disabled={engineBusy}
          className="shrink-0 rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
        >
          {engineBusy ? 'Running engine…' : 'Run engine now'}
        </button>
      </div>

      <div className="p-6 sm:p-8">
        {engineProc && (
          <div className="mb-4">
            <ProcessTracker title="Autopilot engine is working" steps={engineProc} onClose={() => setEngineProc(null)} />
          </div>
        )}
        {note && <div role="status" className="mb-4 rounded-xl bg-emerald-50 px-4 py-2.5 text-[13px] text-emerald-700 ring-1 ring-emerald-100">{note}</div>}
        {err && <div role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-2.5 text-[13px] text-red-700 ring-1 ring-red-100">{err}</div>}

        {loading && <div className="text-[13px] text-ink-muted">Loading queue…</div>}

        {!loading && loadError && (
          <div role="status" className="rounded-2xl bg-amber-50 p-5 text-[13px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
            {loadError}{' '}
            <button type="button" onClick={() => { setLoadError(null); void load(); }} className="font-medium underline">Try again</button>
          </div>
        )}
        {!loading && !loadError && runs.length === 0 && (
          <div className="rounded-2xl bg-subtle/60 p-5 text-[13px] leading-relaxed text-ink-muted ring-1 ring-line">
            No Autopilot runs yet. Open <a href="/templates" className="font-medium text-accent hover:underline">Templates</a>,
            switch a template&apos;s Autopilot mode to <span className="font-medium text-ink">Pillars</span> or{' '}
            <span className="font-medium text-ink">Full auto</span>, then hit &ldquo;Run engine now&rdquo; — each upcoming
            slot gets its own researched, scored draft.
          </div>
        )}

        {ready.length > 0 && (
          <div className="space-y-4">
            {ready.map((r) => {
              const meta = r.angle ? ANGLE_META[r.angle.type] : ANGLE_META.opportunity;
              const channels = CHANNEL_KEYS.filter((k) => r.pack && typeof r.pack[k] === 'string' && r.pack[k].trim());
              const open = openChannel[r.id] || channels[0] || 'instagram';
              return (
                <article key={r.id} data-ai-target="run" data-ai-id={r.id} data-ai-label={r.angle?.query || 'Autopilot draft'} className="relative overflow-hidden rounded-2xl ring-1 ring-line">
                  <PanelLoader scope={runScope(r.id)} rounded="rounded-2xl" />
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-subtle/40 px-5 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className={'rounded-full px-2.5 py-0.5 text-[11px] font-semibold ' + meta.cls}>{meta.label}</span>
                      <span className="font-semibold text-ink">{r.angle?.query || 'Draft'}</span>
                      {varietyLabels(r.angle) && (
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-700" title="This week's format and reader, from the weekly strategy's rotation">
                          {varietyLabels(r.angle)!.format} · for {varietyLabels(r.angle)!.audience}
                        </span>
                      )}
                      {r.angle?.volume != null && (
                        <span className="text-[12px] text-ink-muted">
                          {r.angle.volume}/mo{r.angle.difficulty != null ? ' · KD ' + r.angle.difficulty : ''}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[12px] text-ink-muted">
                      <span>{r.template_name}</span>
                      <span aria-hidden>·</span>
                      <span>{fmtSlot(r.scheduled_for)}</span>
                      {r.missed && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700" title="Its time passed before it was approved">
                          Missed
                        </span>
                      )}
                      {r.score && (
                        <span className={'rounded-full px-2 py-0.5 text-[11px] font-semibold ' + (r.score.total >= 70 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700')}>
                          {r.score.total}/100
                        </span>
                      )}
                    </div>
                  </div>

                  {r.angle && (
                    <div className="border-b border-line px-5 py-3 text-[13px] leading-relaxed text-ink-muted">
                      <p>
                        <span className="font-medium text-ink">Why this angle: </span>{r.angle.rationale}
                        {r.angle.provenPerformer && (
                          <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">proven performer</span>
                        )}
                      </p>
                      {r.angle.strategistNote && (
                        <p className="mt-1.5 italic">
                          <span className="font-medium not-italic text-ink">Strategist: </span>{r.angle.strategistNote}
                        </p>
                      )}
                      {r.angle.media && (
                        <p className="mt-1.5">
                          🎬 <span className="font-medium text-ink">Clip attached on approve:</span> {r.angle.media.title}
                        </p>
                      )}
                      {Boolean(r.recent_angles?.length) && (
                        <p className="mt-1.5 text-[12px]">
                          <span className="font-medium text-ink">Previous occurrences targeted: </span>
                          {r.recent_angles!.map((h) => '"' + h.query + '"').join(' · ')}
                        </p>
                      )}
                    </div>
                  )}

                  {r.score && r.score.safetyFlags.length > 0 && (
                    <div className="border-b border-line bg-amber-50 px-5 py-2.5 text-[12px] text-amber-800">
                      ⚠ {r.score.safetyFlags.length} compliance flag(s):{' '}
                      {r.score.safetyFlags.map((f) => f.message).join(' ')}
                    </div>
                  )}

                  {/* The Crossref verdict on the study in the REF line. It was
                      stamped on every pack and shown nowhere on this card, so a
                      DOI Crossref had never heard of could be approved with
                      nobody told. A not-found citation is also refused at
                      Approve (lib/approve-plan.ts). */}
                  {r.pack?._compliance?.citation && r.pack._compliance.citation.status !== 'verified' && r.pack._compliance.citation.status !== 'not_required' && (
                    <div className={'border-b border-line px-5 py-2.5 text-[12px] ' + (r.pack._compliance.citation.status === 'not_found' || r.pack._compliance.citation.status === 'mismatch' || r.pack._compliance.citation.status === 'no_doi' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}>
                      {r.pack._compliance.citation.status === 'not_found' || r.pack._compliance.citation.status === 'mismatch' ? '✗ ' : '⚠ '}
                      {citationLabel(r.pack._compliance.citation)}
                      {r.pack._compliance.citation.status === 'not_found' || r.pack._compliance.citation.status === 'mismatch' ? ' — this post will not be sent until the REF line cites a real study.' : ''}
                    </div>
                  )}

                  {/* Whether the cited study backs what the post says — the
                      judge's verdict on a strategy post (lib/claim-support.ts).
                      An 'unsupported' also holds an auto-scheduled post. */}
                  {claimSupportNote(r.pack?._claimSupport) && (
                    <div className={'border-b border-line px-5 py-2.5 text-[12px] ' + (r.pack?._claimSupport?.status === 'unsupported' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}>
                      ⚠ {claimSupportNote(r.pack?._claimSupport)}
                    </div>
                  )}

                  {/* Weekly-strategy posts are education, not adverts. What the
                      rubric found is shown here, because it is also what holds
                      an auto-scheduled post. */}
                  {Boolean(r.score?.promotionFlags?.length) && (
                    <div className="border-b border-line bg-amber-50 px-5 py-2.5 text-[12px] text-amber-800">
                      ⚠ Reads as promotion: {r.score!.promotionFlags!.join(', ')}. The strategy asks for guidance, not a sales pitch — edit it or ask for changes.
                    </div>
                  )}
                  {r.score?.openingRepeat && (
                    <div className="border-b border-line bg-amber-50 px-5 py-2.5 text-[12px] text-amber-800">
                      ⚠ Opens the same way as a recent post. Give it a fresh first line — edit it or ask for changes.
                    </div>
                  )}

                  {/* ONE button for every warning above (and the picture's, below).
                      lib/fix-plan.ts decides from the same stamps the warnings
                      are drawn from; the server repairs exactly those and
                      re-checks (POST /api/autopilot/runs { action: 'fix' }). */}
                  {(() => {
                    const plan = fixPlan(runFixInput(r));
                    const fixing = fixRunning(r.angle);
                    return (
                      <>
                        {plan.steps.length > 0 && !fixing && (
                          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-amber-50/60 px-5 py-2.5 text-[12px] text-amber-900">
                            <span className="min-w-0">Fix the {fixStepsLabel(plan.steps)} automatically, then re-check.</span>
                            <button
                              type="button"
                              onClick={() => act(r.id, 'fix')}
                              disabled={busyIds.has(r.id) || regenIds.has(r.id) || optionsIds.has(r.id)}
                              title={'Resolves: ' + plan.reasons.join('; ')}
                              className="ml-auto rounded-full bg-accent px-4 py-1 text-[12px] font-semibold text-white shadow-soft transition hover:opacity-90 disabled:opacity-50"
                            >
                              FIX
                            </button>
                          </div>
                        )}
                        {/* FIX runs in the background; its progress and result are on the run. */}
                        <div className="border-b border-line px-5 py-2.5 empty:hidden">
                          <FixStatusLine angle={r.angle} steps={plan.steps} className="block" />
                        </div>
                      </>
                    );
                  })()}

                  {r.pack?._image?.url ? (
                    <div className="relative border-b border-line px-5 py-4">
                      <PanelLoader scope={imgScope(r.id)} rounded="rounded-none" />
                      <button
                        type="button"
                        onClick={() => setLightbox({ url: r.pack!._image!.url, alt: r.pack!._image!.alt || 'AI hero image' })}
                        className="group/img relative block w-full overflow-hidden rounded-xl ring-1 ring-line"
                        title="Click to view full size"
                      >
                        {regenIds.has(r.id) && (
                          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/70 text-[13px] font-medium text-ink backdrop-blur-sm">
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
                            Working on the picture…
                          </div>
                        )}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={r.pack._image.url}
                          alt={r.pack._image.alt || 'AI hero image'}
                          // A titled cover is shown whole (4:5) — cropping it to the card cut the title off.
                          className={r.pack._image.titled
                            ? 'mx-auto max-h-[560px] w-auto object-contain transition group-hover/img:scale-[1.01]'
                            : 'max-h-[480px] w-full object-cover transition group-hover/img:scale-[1.01]'}
                        />
                        <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white opacity-0 transition group-hover/img:opacity-100">
                          ⤢ View full size
                        </span>
                      </button>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {r.pack._image.verification?.textDetected ? (
                          <span className="rounded-full bg-red-600/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(r.pack._image.verification?.issues || []).join(' · ') || 'Text detected — content images must be text-free'}>✗ text in image — reroll before approving</span>
                        ) : imageUnshippable(r.pack._image.verification) ? (
                          <span className="rounded-full bg-red-600/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(r.pack._image.verification?.issues || []).join(' · ')}>✗ banned prop in frame — this image will not ship; choose another</span>
                        ) : r.pack._image.verification?.status === 'approved' ? (
                          <span className="rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white" title={'Machine-verified clean' + (r.pack._image.verification?.score != null ? ' · ' + r.pack._image.verification.score + '/100' : '')}>✓ verified</span>
                        ) : r.pack._image.verification?.status === 'flagged' ? (
                          <span className="rounded-full bg-amber-500/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(r.pack._image.verification?.issues || []).join(' · ')}>⚠ flagged: {(r.pack._image.verification?.issues || []).slice(0, 2).join('; ') || 'check before approving'}</span>
                        ) : (
                          <span className="rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white" title="Generated before machine verification existed — reroll to get a verified image">review manually</span>
                        )}
                        <p className="text-[11px] text-ink-faint">
                          {r.pack._image.source === 'library'
                            ? '📁 Library photo' + (r.pack._image.libraryName ? ' “' + r.pack._image.libraryName + '”' : '') + (r.pack._image.brandGraded ? ' with the brand filter' : '') + (r.pack._image.titled ? ' and the post title' : '') + ' — no AI; attaches to the Metricool draft on approve.'
                            : r.pack._image.source === 'upload'
                              ? '🖼 Photo the team dropped in — attaches to the Metricool draft on approve.'
                              : '🖼 AI hero image (' + (r.pack._image.model || 'OpenAI') + ') — generated fresh from THIS article’s text; attaches to the Metricool draft on approve.'}
                        </p>
                      </div>
                      {/* EDIT IMAGE, open by default: the free changes (title, no title, notes) come before anything that spends a credit. */}
                      {r.draft_id && (
                        <ImageEditPanel
                          key={r.pack._image.url}
                          draftId={r.draft_id}
                          image={r.pack._image}
                          plannerTitle={plannerImageFor(r.pack)?.title ?? ''}
                          busy={regenIds.has(r.id) || optionsIds.has(r.id) || busyIds.has(r.id)}
                          onAction={(body, meta) => editImage(r, body, meta)}
                        />
                      )}
                      {/* FREE FIRST: a real photograph from the team's Drive folder. */}
                      {r.draft_id && (
                        <div className="mt-2">
                          <button
                            type="button"
                            onClick={() => setLibraryFor((cur) => (cur === r.id ? null : r.id))}
                            disabled={regenIds.has(r.id) || optionsIds.has(r.id) || busyIds.has(r.id)}
                            title="A real photo from the team's Drive folder, with the brand's colour filter and the post title — no AI, no credits"
                            className={'rounded-full px-3 py-1 text-[12px] font-medium ring-1 transition disabled:opacity-50 ' + (libraryFor === r.id ? 'bg-accent text-white ring-accent' : 'text-accent ring-line hover:bg-subtle')}
                          >📁 Pick image from library · free</button>
                          {libraryFor === r.id && (
                            <LibraryPicker draftId={r.draft_id} title onChanged={async () => { setLibraryFor(null); await load({ quiet: true }); announce('images', 'drafts', 'autopilot'); }} onClose={() => setLibraryFor(null)} />
                          )}
                        </div>
                      )}
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-[11px] text-ink-faint">These spend credits:</span>
                        <button
                          type="button"
                          onClick={() => regenImage(r)}
                          disabled={regenIds.has(r.id) || optionsIds.has(r.id) || busyIds.has(r.id)}
                          title="A fresh take, following the notes above if any. Spends one image credit."
                          className="rounded-full px-3 py-1 text-[12px] font-medium text-accent ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                        >
                          {regenIds.has(r.id) ? 'Working…' : '↻ New image ' + creditLabel(1)}
                        </button>
                        <button
                          type="button"
                          onClick={() => proposeImages(r)}
                          disabled={regenIds.has(r.id) || optionsIds.has(r.id) || busyIds.has(r.id)}
                          title="Generates three propositions side by side, following the notes above if any. Your current picture stays as it is until you pick one. Spends three image credits."
                          className="rounded-full px-3 py-1 text-[12px] font-medium text-accent ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                        >
                          {optionsIds.has(r.id) ? 'Making 3 options…' : '⁝⁝ Show me 3 options ' + creditLabel(3)}
                        </button>
                      </div>
                      {(r.pack?._imageOptions?.length || 0) > 0 && (
                        <div className="mt-3">
                          <p className="mb-1.5 text-[11px] text-ink-faint">Other propositions — click one to use it instead:</p>
                          <div className="flex flex-wrap gap-2">
                            {(r.pack?._imageOptions || []).map((o) => (
                              <button
                                key={o.url}
                                type="button"
                                onClick={() => chooseImage(r, o.url)}
                                title="Use this one"
                                className="overflow-hidden rounded-lg ring-1 ring-line transition hover:ring-accent"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={o.url} alt={o.alt || 'Another proposition'} className="h-28 w-auto object-contain" />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : imagingIds.has(r.id) || regenIds.has(r.id) ? (
                    <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-[12px] text-ink-muted">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
                      Generating hero image…
                    </div>
                  ) : r.draft_id ? (
                    <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-[12px] text-ink-muted">
                      <span>No image yet.</span>
                      <button
                        type="button"
                        onClick={() => regenImage(r)}
                        disabled={regenIds.has(r.id) || busyIds.has(r.id)}
                        className="rounded-full px-3 py-1 text-[12px] font-medium text-accent ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                      >
                        {'Generate image ' + creditLabel(1)}
                      </button>
                    </div>
                  ) : null}

                  {channels.length > 0 && r.pack && (
                    <div className="px-5 py-4">
                      <div className="mb-2 flex gap-1.5">
                        {channels.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setOpenChannel((prev) => ({ ...prev, [r.id]: c }))}
                            className={'rounded-full px-3 py-1 text-[12px] font-medium transition ' + (open === c ? 'bg-ink text-white' : 'bg-subtle text-ink-muted hover:text-ink')}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                      <div className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-xl bg-subtle/50 p-4 text-[13px] leading-relaxed text-ink ring-1 ring-line">
                        {r.pack[open]}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2 border-t border-line bg-subtle/30 px-5 py-3">
                    {/* Two ways to say yes. "Approve & schedule" is the reviewer's
                        final word — Metricool publishes at the slot, nobody opens
                        it. "Approve as draft" keeps the older two-step for anyone
                        who wants a second look in the queue first. */}
                    {r.missed ? (
                      // Its time has gone by. The only way out is a NEW time,
                      // and that is said before anything is sent.
                      <button
                        type="button"
                        onClick={() => {
                          if (!window.confirm('This post was due ' + fmtSlot(r.scheduled_for) + ' and that time has passed.\n\nSchedule it at the next free slot (clinic posting hours, clear of anything else going out)?')) return;
                          void act(r.id, 'approve', undefined, true, true);
                        }}
                        disabled={busyIds.has(r.id) || fixRunning(r.angle)}
                        className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                      >
                        {busyIds.has(r.id) ? 'Working…' : 'Approve for next free slot'}
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            if (!window.confirm('Approve and schedule this post?\n\nIt will be published at ' + fmtSlot(r.scheduled_for) + ' (clinic time). Metricool does the publishing; you will not need to open it.')) return;
                            void act(r.id, 'approve', undefined, true);
                          }}
                          disabled={busyIds.has(r.id) || fixRunning(r.angle)}
                          className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                        >
                          {busyIds.has(r.id) ? 'Working…' : 'Approve & schedule'}
                        </button>
                        {/* Not for an article. A draft approval saves the WordPress
                            article as a draft and sends its promos without a
                            link — and nothing here can publish that draft later,
                            so the article would never go out. */}
                        {r.writes_article ? (
                          <span className="text-[11px] text-ink-muted">
                            Articles are approved and scheduled together, so the post and its link go out at the slot.
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => act(r.id, 'approve')}
                            disabled={busyIds.has(r.id) || fixRunning(r.angle)}
                            className="rounded-full px-3 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:text-ink disabled:opacity-50"
                          >
                            Approve as draft
                          </button>
                        )}
                      </>
                    )}
                    {/* Not on a missed card: redrafting restarts the pipeline for
                        a time that has already gone, and the run would expire
                        into a failure. Re-date it or skip it instead. */}
                    {!r.missed && <button
                      type="button"
                      onClick={() => {
                        const feedback = window.prompt('What should change? The engine redrafts and must address your note.', '');
                        if (feedback !== null) void act(r.id, 'regenerate', feedback);
                      }}
                      disabled={busyIds.has(r.id) || fixRunning(r.angle)}
                      className="rounded-full px-4 py-1.5 text-[13px] font-medium text-ink ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                    >
                      {busyIds.has(r.id) ? 'Redrafting…' : 'Ask for changes'}
                    </button>}
                    <button
                      type="button"
                      onClick={() => act(r.id, 'skip')}
                      disabled={busyIds.has(r.id) || fixRunning(r.angle)}
                      className="rounded-full px-4 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                    >
                      {busyIds.has(r.id) ? 'Working…' : 'Skip this one'}
                    </button>
                    <span className="ml-auto text-[11px] text-ink-muted">You approve every post — nothing goes out on its own.</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {inFlight.length > 0 && (
          <div className={'space-y-2 ' + (ready.length ? 'mt-6' : '')}>
            <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">In the pipeline</div>
            {inFlight.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl bg-subtle/50 px-4 py-2.5 text-[13px] ring-1 ring-line">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{r.template_name}</span>
                  <span className="text-ink-muted">{fmtSlot(r.scheduled_for)}</span>
                  {r.angle && <span className="min-w-0 truncate text-[12px] text-ink-muted">→ &ldquo;{r.angle.query}&rdquo;</span>}
                </div>
                <ProcessTracker compact steps={runStageSteps(r.state)} title={r.template_name + ' progress'} />
                <button
                  type="button"
                  onClick={() => act(r.id, 'run_now')}
                  disabled={busyIds.has(r.id)}
                  className="rounded-full px-3 py-1 text-[12px] font-medium text-accent ring-1 ring-line transition hover:bg-white disabled:opacity-50"
                >
                  {busyIds.has(r.id) ? 'Preparing…' : 'Prepare now'}
                </button>
              </div>
            ))}
          </div>
        )}

        {failed.length > 0 && (
          <div className="mt-6 space-y-2">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Needs attention</div>
            {failed.map((r) => <FailedRun key={r.id} run={r} busy={busyIds.has(r.id)} onRetry={() => act(r.id, 'run_now')} onDismiss={() => act(r.id, 'skip')} />)}
          </div>
        )}
      </div>

      {/* Full-size image lightbox: click anywhere (or Close) to dismiss. */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox.url}
            alt={lightbox.alt}
            className="max-h-full max-w-full rounded-2xl object-contain shadow-2xl"
          />
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 rounded-full bg-white/90 px-4 py-1.5 text-[13px] font-medium text-ink shadow-card transition hover:bg-white"
          >
            ✕ Close
          </button>
        </div>
      )}
    </section>
  );
}
