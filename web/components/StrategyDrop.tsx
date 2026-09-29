'use client';

// components/StrategyDrop.tsx
// "Drop weekly strategy": drop a strategy PDF, see its week laid out day by
// day, press "Create schedules". The slots become Autopilot templates
// (app/api/templates/strategy-upload/route.ts, lib/strategy-upload.ts): each
// post is researched against keywords and competitors, written ahead of time,
// verified, and waits in the review queue — approved posts go to the calendar
// and Metricool as they already do. Nothing here deletes or changes anything.

import { useRef, useState } from 'react';
import { announce } from '@/components/refreshBus';
import { friendlyError, friendlyErrorFromResponse } from '@/lib/friendly-error';
import { DAY_LABELS, UPLOAD_MAX_BYTES, type UploadPlan, type UploadSlot } from '@/lib/strategy-upload';

type Preview = { create: number; already: number; clashes: { slot: string; with: string }[] } | null;

// Monday first, as a strategy week reads.
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const NETWORK_LABEL: Record<string, string> = { instagram: 'IG', facebook: 'FB', linkedin: 'LI', blog: 'Blog' };

const TONES = [
  'bg-indigo-50 text-indigo-900 ring-indigo-100',
  'bg-emerald-50 text-emerald-900 ring-emerald-100',
  'bg-amber-50 text-amber-900 ring-amber-100',
  'bg-sky-50 text-sky-900 ring-sky-100',
  'bg-rose-50 text-rose-900 ring-rose-100',
  'bg-violet-50 text-violet-900 ring-violet-100',
  'bg-teal-50 text-teal-900 ring-teal-100',
];

function toneFor(pillar: string, all: string[]): string {
  const i = all.indexOf(pillar.toLowerCase());
  return TONES[(i < 0 ? 0 : i) % TONES.length];
}

function SlotCard({ slot, tone, on, onToggle }: { slot: UploadSlot; tone: string; on: boolean; onToggle: () => void }) {
  return (
    <div className={'min-w-0 break-words hyphens-auto rounded-xl p-2 text-[11px] ring-1 transition ' + tone + (on ? '' : ' opacity-40')}>
      <div className="flex items-start justify-between gap-1">
        <span className="font-semibold tabular-nums">{slot.time}</span>
        <input type="checkbox" checked={on} onChange={onToggle} aria-label={'Include ' + slot.pillar + ' on ' + DAY_LABELS[slot.weekday]} className="mt-0.5" />
      </div>
      <div className="mt-1 text-[11.5px] font-semibold leading-snug">{slot.pillar}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {slot.format === 'blog' && <span className="rounded bg-white/70 px-1 font-medium">Article</span>}
        {slot.providers.map((p) => <span key={p} className="rounded bg-white/70 px-1">{NETWORK_LABEL[p] || p}</span>)}
      </div>
      <div className="mt-1.5 opacity-80" title={slot.angles.join('\n')}>
        {slot.angles.length} angle{slot.angles.length === 1 ? '' : 's'} · e.g. “{slot.angles[0]}”
      </div>
    </div>
  );
}

export default function StrategyDrop({ onCreated }: { onCreated?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [plan, setPlan] = useState<UploadPlan | null>(null);
  const [preview, setPreview] = useState<Preview>(null);
  const [off, setOff] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function read(file: File) {
    setErr(null); setDone(null); setPlan(null); setPreview(null); setOff(new Set());
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { setErr('Drop a PDF file — the strategy document.'); return; }
    if (file.size > UPLOAD_MAX_BYTES) { setErr('That PDF is over 4 MB. Export a smaller copy and drop it again.'); return; }
    setFileName(file.name);
    setReading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const r = await fetch('/api/templates/strategy-upload', { method: 'POST', body: form });
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'The strategy could not be read just now.')); return; }
      const j = await r.json();
      setPlan(j.plan);
      setPreview(j.preview ?? null);
    } catch (e) {
      setErr(friendlyError(e, 'The strategy could not be read just now.'));
    } finally {
      setReading(false);
    }
  }

  async function create() {
    if (!plan) return;
    const slots = plan.slots.filter((_, i) => !off.has(i));
    if (!slots.length) { setErr('Tick at least one slot to create.'); return; }
    setErr(null);
    setCreating(true);
    try {
      const r = await fetch('/api/templates/strategy-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply', plan: { ...plan, slots } }),
      });
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'The schedules could not be created just now.')); return; }
      const j = await r.json();
      setDone(j.message || 'Schedules created.');
      setPlan(null);
      setPreview(null);
      announce('templates', 'autopilot');
      onCreated?.();
    } catch (e) {
      setErr(friendlyError(e, 'The schedules could not be created just now.'));
    } finally {
      setCreating(false);
    }
  }

  const pillars = plan ? [...new Set(plan.slots.map((s) => s.pillar.toLowerCase()))] : [];
  const chosen = plan ? plan.slots.length - off.size : 0;
  // Every slot is already there from an earlier upload: nothing to press.
  const nothingNew = Boolean(preview && preview.create === 0);

  return (
    <section id="section-strategy-drop" className="mb-8 rounded-3xl bg-surface p-6 shadow-card ring-1 ring-line/60 sm:p-7 2xl:col-span-2 2xl:mb-0" aria-label="Drop weekly strategy">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[17px] font-semibold text-ink">Drop weekly strategy</h2>
        <span className="text-[12px] text-ink-faint">PDF → the week → Autopilot</span>
      </div>
      <p className="mt-1 text-[13px] text-ink-muted">
        Drop a strategy document like the clinic&rsquo;s weekly plan. Each post it lists becomes a weekly slot: Autopilot researches keywords and competitors, learns from what has performed, writes and verifies each post, and puts it in the review queue. Approved posts go to the calendar and publish through Metricool as they do today. Nothing existing is changed.
      </p>

      <div
        role="button"
        tabIndex={0}
        onClick={() => !reading && input.current?.click()}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !reading) { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f && !reading) void read(f); }}
        className={'mt-4 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-4 py-7 text-center transition ' +
          (drag ? 'border-accent bg-accent/5' : 'border-line hover:border-accent/60')}
      >
        <div className="text-[26px]" aria-hidden>📄</div>
        <div className="mt-1 text-[14px] font-medium text-ink">
          {reading ? 'Reading ' + (fileName || 'the strategy') + '…' : 'Drop the strategy PDF here, or click to choose'}
        </div>
        <div className="mt-0.5 text-[12px] text-ink-faint">{reading ? 'This takes up to a minute.' : 'PDF, up to 4 MB'}</div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }}
        />
      </div>

      {err && <p role="alert" className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-900 ring-1 ring-amber-200/60">{err}</p>}
      {done && <p role="status" className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900 ring-1 ring-emerald-200/60">{done} <a href="/templates" className="font-medium underline">See them on Templates</a></p>}

      {plan && (
        <div className="mt-5">
          <div className="text-[15px] font-semibold text-ink">{plan.title}</div>
          {plan.summary && <p className="mt-0.5 text-[12px] text-ink-muted">{plan.summary}</p>}
          {plan.direction && <p className="mt-1 text-[12px] text-ink-muted"><span className="font-medium">Editorial direction:</span> {plan.direction}</p>}

          <div className="mt-4 grid grid-cols-1 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
            {WEEK_ORDER.map((d) => {
              const day = plan.slots.map((s, i) => ({ s, i })).filter(({ s }) => s.weekday === d);
              return (
                <div key={d} className="min-w-0 rounded-2xl bg-canvas/60 p-1.5 ring-1 ring-line/50">
                  <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">{DAY_LABELS[d].slice(0, 3)}</div>
                  <div className="grid gap-2">
                    {day.length ? day.map(({ s, i }) => (
                      <SlotCard
                        key={i}
                        slot={s}
                        tone={toneFor(s.pillar, pillars)}
                        on={!off.has(i)}
                        onToggle={() => setOff((prev) => { const n = new Set(prev); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
                      />
                    )) : <div className="text-[11px] text-ink-faint">No posts</div>}
                  </div>
                </div>
              );
            })}
          </div>

          {(plan.notes.length > 0 || (preview && (preview.already > 0 || preview.clashes.length > 0))) && (
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[12px] text-ink-muted">
              {plan.notes.map((n, i) => <li key={'n' + i}>{n}</li>)}
              {preview && preview.already > 0 && <li>{preview.already} of these already exist from an earlier upload and will be left as they are.</li>}
              {preview && preview.clashes.slice(0, 5).map((c, i) => <li key={'c' + i}>{c.slot} shares its time with &ldquo;{c.with}&rdquo; — both will post.</li>)}
              {preview && preview.clashes.length > 5 && <li>…and {preview.clashes.length - 5} more at a shared time.</li>}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating || chosen === 0 || nothingNew}
              className="rounded-full bg-accent px-5 py-2 text-[13px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
            >
              {creating ? 'Creating…' : nothingNew ? 'Already created' : 'Create ' + chosen + ' schedule' + (chosen === 1 ? '' : 's')}
            </button>
            <button type="button" onClick={() => { setPlan(null); setPreview(null); }} className="text-[12px] font-medium text-ink-muted hover:underline">Discard</button>
            <span className="text-[11px] text-ink-faint">Every post waits for your approval before it is scheduled or published.</span>
          </div>
        </div>
      )}
    </section>
  );
}
