'use client';

// Autopilot review queue: every dynamic-template occurrence the engine has
// researched, drafted and scored, waiting for the ONE thing it never does
// itself — your approval. Approve pushes a Metricool DRAFT (never a live
// publish); Skip discards the occurrence.

import { useCallback, useEffect, useState } from 'react';

type Angle = {
  type: 'answer' | 'commercial' | 'defense' | 'opportunity';
  query: string;
  seedTopic: string;
  rationale: string;
  volume: number | null;
  difficulty: number | null;
};

type RunScore = {
  total: number;
  breakdown: Record<string, number>;
  safetyFlags: { code: string; message: string }[];
  critique: string[];
};

type Run = {
  id: string;
  template_name: string;
  scheduled_for: string;
  state: string;
  angle: Angle | null;
  score: RunScore | null;
  pack: Record<string, string> | null;
};

const ANGLE_META: Record<Angle['type'], { label: string; cls: string }> = {
  answer: { label: 'Answer a searcher', cls: 'bg-sky-100 text-sky-700' },
  commercial: { label: 'Commercial intent', cls: 'bg-emerald-100 text-emerald-700' },
  defense: { label: 'Ranking defense', cls: 'bg-amber-100 text-amber-700' },
  opportunity: { label: 'Opportunity', cls: 'bg-indigo-100 text-indigo-700' },
};

const CHANNEL_KEYS = ['instagram', 'facebook', 'linkedin', 'blog'] as const;

function fmtSlot(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

export default function AutopilotQueue() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openChannel, setOpenChannel] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/autopilot/runs');
      const j = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(j.runs)) setRuns(j.runs);
    } catch { /* transient */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(id: string, action: 'approve' | 'skip' | 'run_now') {
    setBusyId(id);
    setErr(null);
    setNote(null);
    try {
      const r = await fetch('/api/autopilot/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Action failed (' + r.status + ')');
      if (j?.note) setNote(String(j.note));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusyId(null);
    }
  }

  async function runEngine() {
    setEngineBusy(true);
    setErr(null);
    setNote(null);
    try {
      const r = await fetch('/api/autopilot/tick', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || 'Engine tick failed');
      setNote(
        'Engine ran: ' + (j.planned ?? 0) + ' occurrence(s) planned, ' +
        (j.advanced ?? 0) + ' step(s) advanced, ' + (j.ready ?? 0) + ' ready for review.'
      );
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Engine tick failed');
    } finally {
      setEngineBusy(false);
    }
  }

  const ready = runs.filter((r) => r.state === 'ready_for_review');
  const inFlight = runs.filter((r) => ['planned', 'researched', 'drafted'].includes(r.state));
  const failed = runs.filter((r) => r.state === 'failed');

  return (
    <section id="section-autopilot" className="mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4 sm:px-8">
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
        {note && <div role="status" className="mb-4 rounded-xl bg-emerald-50 px-4 py-2.5 text-[13px] text-emerald-700 ring-1 ring-emerald-100">{note}</div>}
        {err && <div role="alert" className="mb-4 rounded-xl bg-red-50 px-4 py-2.5 text-[13px] text-red-700 ring-1 ring-red-100">{err}</div>}

        {loading && <div className="text-[13px] text-ink-muted">Loading queue…</div>}

        {!loading && runs.length === 0 && (
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
                    <p className="border-b border-line px-5 py-3 text-[13px] leading-relaxed text-ink-muted">
                      <span className="font-medium text-ink">Why this angle: </span>{r.angle.rationale}
                    </p>
                  )}

                  {r.score && r.score.safetyFlags.length > 0 && (
                    <div className="border-b border-line bg-amber-50 px-5 py-2.5 text-[12px] text-amber-800">
                      ⚠ {r.score.safetyFlags.length} compliance flag(s):{' '}
                      {r.score.safetyFlags.map((f) => f.message).join(' ')}
                    </div>
                  )}

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
                      <div className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-xl bg-subtle/50 p-4 text-[13px] leading-relaxed text-ink ring-1 ring-line">
                        {r.pack[open]}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 border-t border-line bg-subtle/30 px-5 py-3">
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
                      onClick={() => act(r.id, 'skip')}
                      disabled={busyId === r.id}
                      className="rounded-full px-4 py-1.5 text-[13px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle disabled:opacity-50"
                    >
                      Skip this one
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
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-subtle/50 px-4 py-2.5 text-[13px] ring-1 ring-line">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-ink">{r.template_name}</span>
                  <span className="text-ink-muted">{fmtSlot(r.scheduled_for)}</span>
                  <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-line">
                    {r.state === 'planned' ? 'queued' : r.state}
                  </span>
                  {r.angle && <span className="text-[12px] text-ink-muted">→ &ldquo;{r.angle.query}&rdquo;</span>}
                </div>
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
    </section>
  );
}
