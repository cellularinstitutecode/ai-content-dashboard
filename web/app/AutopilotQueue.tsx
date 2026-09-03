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
};

type RunScore = {
  total: number;
  breakdown: Record<string, number>;
  safetyFlags: { code: string; message: string }[];
  critique: string[];
};

type PackImage = {
  url: string;
  alt?: string;
  model?: string;
  variant?: number;
  verification?: { status?: 'approved' | 'flagged' | 'unchecked'; score?: number | null; issues?: string[]; textDetected?: boolean };
};

type Run = {
  id: string;
  draft_id: string | null;
  template_name: string;
  scheduled_for: string;
  state: string;
  angle: Angle | null;
  score: RunScore | null;
  pack: (Record<string, string> & { _image?: PackImage }) | null;
  recent_angles?: { query: string; type: string }[];
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

export default function AutopilotQueue() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openChannel, setOpenChannel] = useState<Record<string, string>>({});
  const [imagingIds, setImagingIds] = useState<Set<string>>(new Set());
  const [regenId, setRegenId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Draft ids we already asked an image for this session — avoids re-requesting
  // on every poll while a generation is in flight or after it failed.
  const imageAsked = useRef<Set<string>>(new Set());

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
      (r) => r.state === 'ready_for_review' && r.draft_id && r.pack && !r.pack._image?.url && !imageAsked.current.has(r.draft_id)
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

  async function act(id: string, action: 'approve' | 'skip' | 'run_now' | 'regenerate', extraNote?: string) {
    setBusyId(id);
    setErr(null);
    setNote(null);
    try {
      const r = await fetch('/api/autopilot/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, action, note: extraNote }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Action failed (' + r.status + ')');
      if (j?.note) setNote(String(j.note));
      await load();
      // Interconnection: approving queues a Metricool draft (posts row) and
      // every action can touch drafts — update the rest of the dashboard.
      // 'autopilot' was declared as a scope but nothing ever announced it, so
      // the queue's own subscription could never fire. It does now.
      if (action === 'approve') announce('posts', 'stats', 'drafts', 'autopilot', 'insights');
      else announce('drafts', 'autopilot');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  // Reject a hallucinated/off-brand image and get a fresh proposition: the
  // server advances the composition variant so every regenerate is a visibly
  // different take (hero shot → macro lab → lifestyle → still-life → …).
  async function regenImage(r: Run) {
    if (!r.draft_id || regenId) return;
    setRegenId(r.id);
    setErr(null);
    try {
      const res = await fetch('/api/drafts/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chi-progress-scope': 'autopilot' },
        body: JSON.stringify({ id: r.draft_id, regenerate: true }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error || 'Image regeneration failed');
      await load();
      announce('images', 'drafts', 'autopilot'); // fresh hero image → Image Studio + library update live
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Image regeneration failed');
    } finally {
      setRegenId(null);
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
                <article key={r.id} className="overflow-hidden rounded-2xl ring-1 ring-line">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-subtle/40 px-5 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-[13px]">
                      <span className={'rounded-full px-2.5 py-0.5 text-[11px] font-semibold ' + meta.cls}>{meta.label}</span>
                      <span className="font-semibold text-ink">{r.angle?.query || 'Draft'}</span>
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

                  {r.pack?._image?.url ? (
                    <div className="border-b border-line px-5 py-4">
                      <button
                        type="button"
                        onClick={() => setLightbox({ url: r.pack!._image!.url, alt: r.pack!._image!.alt || 'AI hero image' })}
                        className="group/img relative block w-full overflow-hidden rounded-xl ring-1 ring-line"
                        title="Click to view full size"
                      >
                        {regenId === r.id && (
                          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/70 text-[13px] font-medium text-ink backdrop-blur-sm">
                            <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
                            Generating a new proposition…
                          </div>
                        )}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={r.pack._image.url}
                          alt={r.pack._image.alt || 'AI hero image'}
                          className="max-h-[480px] w-full object-cover transition group-hover/img:scale-[1.01]"
                        />
                        <span className="absolute bottom-2 right-2 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white opacity-0 transition group-hover/img:opacity-100">
                          ⤢ View full size
                        </span>
                      </button>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {r.pack._image.verification?.textDetected ? (
                          <span className="rounded-full bg-red-600/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(r.pack._image.verification?.issues || []).join(' · ') || 'Text detected — content images must be text-free'}>✗ text in image — reroll before approving</span>
                        ) : r.pack._image.verification?.status === 'approved' ? (
                          <span className="rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white" title={'Machine-verified clean' + (r.pack._image.verification?.score != null ? ' · ' + r.pack._image.verification.score + '/100' : '')}>✓ verified</span>
                        ) : r.pack._image.verification?.status === 'flagged' ? (
                          <span className="rounded-full bg-amber-500/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(r.pack._image.verification?.issues || []).join(' · ')}>⚠ flagged: {(r.pack._image.verification?.issues || []).slice(0, 2).join('; ') || 'check before approving'}</span>
                        ) : (
                          <span className="rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white" title="Generated before machine verification existed — reroll to get a verified image">review manually</span>
                        )}
                        <p className="text-[11px] text-ink-faint">
                          🖼 AI hero image ({r.pack._image.model || 'OpenAI'}) — generated fresh from THIS article&apos;s text; attaches to the Metricool draft on approve.
                        </p>
                        <button
                          type="button"
                          onClick={() => regenImage(r)}
                          disabled={regenId === r.id || busyId === r.id}
                          className="ml-auto rounded-full px-3 py-1 text-[12px] font-medium text-accent ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                        >
                          {regenId === r.id ? 'Regenerating…' : '↻ New image'}
                        </button>
                      </div>
                    </div>
                  ) : imagingIds.has(r.id) || regenId === r.id ? (
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
                        disabled={Boolean(regenId) || busyId === r.id}
                        className="rounded-full px-3 py-1 text-[12px] font-medium text-accent ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                      >
                        Generate image
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
                    <button
                      type="button"
                      onClick={() => act(r.id, 'approve')}
                      disabled={busyId === r.id}
                      className="rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                    >
                      {busyId === r.id ? 'Working…' : 'Approve → Metricool draft'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const feedback = window.prompt('What should change? The engine redrafts and must address your note.', '');
                        if (feedback !== null) void act(r.id, 'regenerate', feedback);
                      }}
                      disabled={busyId === r.id}
                      className="rounded-full px-4 py-1.5 text-[13px] font-medium text-ink ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                    >
                      {busyId === r.id ? 'Redrafting…' : 'Ask for changes'}
                    </button>
                    <button
                      type="button"
                      onClick={() => act(r.id, 'skip')}
                      disabled={busyId === r.id}
                      className="rounded-full px-4 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                    >
                      {busyId === r.id ? 'Working…' : 'Skip this one'}
                    </button>
                    <span className="ml-auto text-[11px] text-ink-muted">Publishing stays manual, always.</span>
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
                  disabled={busyId === r.id}
                  className="rounded-full px-3 py-1 text-[12px] font-medium text-accent ring-1 ring-line transition hover:bg-white disabled:opacity-50"
                >
                  {busyId === r.id ? 'Preparing…' : 'Prepare now'}
                </button>
              </div>
            ))}
          </div>
        )}

        {failed.length > 0 && (
          <div className="mt-6 space-y-2">
            <div className="text-[12px] font-semibold uppercase tracking-wide text-ink-muted">Needs attention</div>
            {failed.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 px-4 py-2.5 text-[13px] ring-1 ring-red-100">
                <div className="text-red-700">
                  <span className="font-medium">{r.template_name}</span> · {fmtSlot(r.scheduled_for)} — repeated errors; check API keys, then retry.
                </div>
                <button
                  type="button"
                  onClick={() => act(r.id, 'run_now')}
                  disabled={busyId === r.id}
                  className="rounded-full px-3 py-1 text-[12px] font-medium text-red-700 ring-1 ring-red-200 transition hover:bg-white disabled:opacity-50"
                >
                  Retry
                </button>
              </div>
            ))}
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
