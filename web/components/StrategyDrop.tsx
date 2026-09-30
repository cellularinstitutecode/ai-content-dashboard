'use client';

// components/StrategyDrop.tsx
// "Drop weekly strategy": drop a strategy PDF, see its week laid out day by
// day, press "Create schedules". The slots become Autopilot templates
// (app/api/templates/strategy-upload/route.ts, lib/strategy-upload.ts): each
// post is written the way the built-in weekly strategy is (the document's
// angle, its voice, no promotion), verified, and waits in the review queue —
// approved posts go to the calendar and Metricool as they already do. Nothing
// here deletes or changes anything.

import { useRef, useState } from 'react';
import { announce } from '@/components/refreshBus';
import { friendlyError, friendlyErrorFromResponse } from '@/lib/friendly-error';
import { supabaseBrowser } from '@/lib/supabase';
import { DAY_LABELS, DIRECT_MAX_BYTES, STRATEGY_BUCKET, UPLOAD_MAX_BYTES, mbLabel, type UploadPlan, type UploadSlot } from '@/lib/strategy-upload';

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

/** A slot as the editor holds it: the document's slot plus a stable key and an on/off. */
type EditableSlot = UploadSlot & { _k: string; on: boolean };
let __slotSeq = 0;
const slotKey = () => 's_' + Date.now().toString(36) + '_' + (__slotSeq++).toString(36);
const SOCIAL_NETWORKS = ['instagram', 'facebook', 'linkedin'] as const;

/**
 * One post of the week, previewable and editable like any other draft.
 *
 * Collapsed, it is the card the document produced. Open, every angle is
 * listed and editable, angles can be added or removed, and the pillar, time,
 * channels, article-or-post and the document's note can all be changed —
 * before "Create schedules" turns it into a template. The server normalises
 * whatever comes back (lib/strategy-upload.ts normalizeUpload), so nothing
 * typed here can reach a template unchecked.
 */
function SlotCard({ slot, tone, onChange, onRemove }: { slot: EditableSlot; tone: string; onChange: (next: EditableSlot) => void; onRemove: () => void }) {
  const [openCard, setOpenCard] = useState(false);
  const [newAngle, setNewAngle] = useState('');
  const set = (patch: Partial<EditableSlot>) => onChange({ ...slot, ...patch });
  const setAngle = (i: number, v: string) => set({ angles: slot.angles.map((a, j) => (j === i ? v : a)) });
  const removeAngle = (i: number) => set({ angles: slot.angles.filter((_, j) => j !== i) });
  const addAngle = () => { const t = newAngle.trim(); if (!t) return; set({ angles: [...slot.angles, t] }); setNewAngle(''); };
  const toggleNetwork = (n: string) => {
    const has = slot.providers.includes(n);
    const next = has ? slot.providers.filter((p) => p !== n) : [...slot.providers, n];
    set({ providers: next.length ? next : slot.providers });
  };
  const field = 'w-full rounded-lg bg-white/80 px-2 py-1 text-[12px] text-ink ring-1 ring-black/10 focus:outline-none focus:ring-accent/40';
  return (
    <div className={'min-w-0 break-words hyphens-auto rounded-2xl p-3.5 text-[12px] ring-1 transition ' + tone + (slot.on ? '' : ' opacity-40')}>
      <div className="flex items-start justify-between gap-2">
        {openCard
          ? <input aria-label="Time" value={slot.time} onChange={(e) => set({ time: e.target.value })} placeholder="09:00" className={field + ' max-w-[80px] tabular-nums'} />
          : <span className="text-[13px] font-semibold tabular-nums">{slot.time}</span>}
        <input type="checkbox" checked={slot.on} onChange={() => set({ on: !slot.on })} aria-label={'Include ' + slot.pillar + ' on ' + DAY_LABELS[slot.weekday]} className="mt-0.5" />
      </div>
      {openCard
        ? <input aria-label="Pillar" value={slot.pillar} onChange={(e) => set({ pillar: e.target.value })} className={field + ' mt-2 text-[14px] font-semibold'} />
        : <div className="mt-2 text-[14px] font-semibold leading-snug">{slot.pillar}</div>}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {openCard ? (
          <>
            <button type="button" onClick={() => set(slot.format === 'blog' ? { format: 'social', providers: [...SOCIAL_NETWORKS] } : { format: 'blog', providers: ['blog'] })}
              className={'rounded-md px-1.5 py-0.5 font-medium ring-1 ' + (slot.format === 'blog' ? 'bg-ink text-white ring-ink' : 'bg-white/70 ring-black/10')}>Article</button>
            {slot.format !== 'blog' && SOCIAL_NETWORKS.map((n) => (
              <button key={n} type="button" onClick={() => toggleNetwork(n)} className={'rounded-md px-1.5 py-0.5 ring-1 ' + (slot.providers.includes(n) ? 'bg-ink text-white ring-ink' : 'bg-white/70 ring-black/10')}>{NETWORK_LABEL[n] || n}</button>
            ))}
          </>
        ) : (
          <>
            {slot.format === 'blog' && <span className="rounded-md bg-white/70 px-1.5 py-0.5 font-medium">Article</span>}
            {slot.providers.map((p) => <span key={p} className="rounded-md bg-white/70 px-1.5 py-0.5">{NETWORK_LABEL[p] || p}</span>)}
          </>
        )}
      </div>
      {openCard ? (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">Angles — one post each week draws on one of these</div>
          <ul className="space-y-1.5">
            {slot.angles.map((a, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <textarea aria-label={'Angle ' + (i + 1)} value={a} onChange={(e) => setAngle(i, e.target.value)} rows={2} className={field + ' resize-y leading-snug'} />
                <button type="button" onClick={() => removeAngle(i)} aria-label="Remove angle" className="mt-1 shrink-0 rounded-md px-1.5 text-[12px] text-red-600 ring-1 ring-red-200 hover:bg-red-50">×</button>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-1.5">
            <input aria-label="New angle" value={newAngle} onChange={(e) => setNewAngle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAngle(); } }} placeholder="Add an angle…" className={field} />
            <button type="button" onClick={addAngle} disabled={!newAngle.trim()} className="shrink-0 rounded-md bg-accent px-2 py-1 text-[12px] font-semibold text-white disabled:opacity-40">Add</button>
          </div>
          <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide opacity-70">Note for the writer</div>
          <textarea aria-label="Note" value={slot.rule} onChange={(e) => set({ rule: e.target.value })} rows={2} placeholder="e.g. mention the recovery lounge without promoting it" className={field + ' mt-1 resize-y leading-snug'} />
        </div>
      ) : (
        <div className="mt-3 leading-relaxed opacity-80" title={slot.angles.join('\n')}>
          {slot.angles.length} angle{slot.angles.length === 1 ? '' : 's'} · e.g. \u201c{slot.angles[0]}\u201d
        </div>
      )}
      {/* The document's note for this post, shown so the team can see it was read. */}
      {!openCard && slot.rule && <div className="mt-2 rounded-lg bg-white/70 px-2 py-1.5 text-[11px] leading-snug"><span className="font-semibold">Note:</span> {slot.rule}</div>}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" onClick={() => setOpenCard((v) => !v)} className="rounded-md bg-white/80 px-2 py-1 text-[11px] font-medium ring-1 ring-black/10 hover:bg-white">
          {openCard ? 'Done' : 'Preview & edit'}
        </button>
        {openCard && <button type="button" onClick={onRemove} className="rounded-md px-2 py-1 text-[11px] font-medium text-red-600 ring-1 ring-red-200 hover:bg-red-50">Remove post</button>}
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
  /** The week as the editor holds it: every slot previewable, editable, addable and removable. */
  const [slots, setSlots] = useState<EditableSlot[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function read(file: File) {
    setErr(null); setDone(null); setPlan(null); setPreview(null); setSlots([]);
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { setErr('Drop a PDF file — the strategy document.'); return; }
    if (file.size > UPLOAD_MAX_BYTES) { setErr('That PDF is over ' + mbLabel(UPLOAD_MAX_BYTES) + '. Export a smaller copy and drop it again.'); return; }
    setFileName(file.name);
    setReading(true);
    try {
      let r: Response;
      if (file.size > DIRECT_MAX_BYTES) {
        // Too big for the request itself (Vercel's 4.5 MB): straight to
        // storage on a signed URL, then the route reads it from there.
        const signed = await fetch('/api/templates/strategy-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sign' }) });
        if (!signed.ok) { setErr(await friendlyErrorFromResponse(signed, 'The upload could not be prepared just now.')); return; }
        const { path, token, bucket } = await signed.json();
        const up = await supabaseBrowser().storage.from(bucket || STRATEGY_BUCKET).uploadToSignedUrl(path, token, file, { contentType: 'application/pdf', upsert: true });
        if (up.error) { setErr('The PDF could not be uploaded: ' + up.error.message + '. Try again in a moment.'); return; }
        r = await fetch('/api/templates/strategy-upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read', path, size: file.size }) });
      } else {
        const form = new FormData();
        form.append('file', file);
        r = await fetch('/api/templates/strategy-upload', { method: 'POST', body: form });
      }
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'The strategy could not be read just now.')); return; }
      const j = await r.json();
      setPlan(j.plan);
      setSlots(((j.plan?.slots || []) as UploadSlot[]).map((sl) => ({ ...sl, _k: slotKey(), on: true })));
      setPreview(j.preview ?? null);
    } catch (e) {
      setErr(friendlyError(e, 'The strategy could not be read just now.'));
    } finally {
      setReading(false);
    }
  }

  async function create() {
    if (!plan) return;
    // What was edited is what is created; the server normalises it again.
    const chosen = slots.filter((sl) => sl.on).map(({ _k: _key, on: _on, ...rest }) => rest);
    if (!chosen.length) { setErr('Tick at least one slot to create.'); return; }
    setErr(null);
    setCreating(true);
    try {
      const r = await fetch('/api/templates/strategy-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply', plan: { ...plan, slots: chosen } }),
      });
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'The schedules could not be created just now.')); return; }
      const j = await r.json();
      setDone(j.message || 'Schedules created.');
      setPlan(null);
      setSlots([]);
      setPreview(null);
      announce('templates', 'autopilot');
      onCreated?.();
    } catch (e) {
      setErr(friendlyError(e, 'The schedules could not be created just now.'));
    } finally {
      setCreating(false);
    }
  }

  const pillars = plan ? [...new Set(slots.map((sl) => sl.pillar.toLowerCase()))] : [];
  const chosen = slots.filter((sl) => sl.on).length;
  const updateSlot = (k: string, next: EditableSlot) => setSlots((prev) => prev.map((sl) => (sl._k === k ? next : sl)));
  const removeSlot = (k: string) => setSlots((prev) => prev.filter((sl) => sl._k !== k));
  const addSlot = (weekday: number) => setSlots((prev) => {
    const sameDay = prev.filter((sl) => sl.weekday === weekday);
    const theme = sameDay.find((sl) => sl.theme)?.theme || '';
    const time = sameDay.some((sl) => sl.time === '09:00') ? (sameDay.some((sl) => sl.time === '18:00') ? '13:00' : '18:00') : '09:00';
    return [...prev, { _k: slotKey(), on: true, weekday, time, pillar: 'New post', theme, angles: [], format: 'social', providers: [...SOCIAL_NETWORKS], rule: '' }];
  });
  // Every slot is already there from an earlier upload: nothing to press.
  const nothingNew = Boolean(preview && preview.create === 0);

  return (
    <section id="section-strategy-drop" className="mb-10 rounded-3xl bg-surface p-6 shadow-card ring-2 ring-accent/30 sm:p-10" aria-label="Drop weekly strategy">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[24px] font-semibold tracking-tight text-ink">Drop weekly strategy</h2>
        <span className="text-[13px] text-ink-faint">PDF → the week → Autopilot</span>
      </div>
      <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-ink-muted">
        Drop a strategy document like the clinic&rsquo;s weekly plan. Each post it lists becomes a weekly slot, written the way the weekly strategy is: always the document&rsquo;s angle (keywords only as a supporting phrase), its educational voice with no promotion, a new format and reader each week, no repeats across the week, and a single image. Every post is verified and put in the review queue. Approved posts go to the calendar and publish through Metricool as they do today. Nothing existing is changed.
      </p>

      <div
        role="button"
        tabIndex={0}
        onClick={() => !reading && input.current?.click()}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !reading) { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f && !reading) void read(f); }}
        className={'mt-8 flex cursor-pointer flex-col items-center justify-center rounded-3xl border-2 border-dashed px-6 py-14 text-center transition ' +
          (drag ? 'border-accent bg-accent/5' : 'border-line hover:border-accent/60')}
      >
        <div className="text-[40px]" aria-hidden>📄</div>
        <div className="mt-3 text-[16px] font-medium text-ink">
          {reading ? 'Reading ' + (fileName || 'the strategy') + '…' : 'Drop the strategy PDF here, or click to choose'}
        </div>
        <div className="mt-1.5 text-[13px] text-ink-faint">{reading ? 'This takes up to a minute.' : 'PDF, up to ' + mbLabel(UPLOAD_MAX_BYTES)}</div>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }}
        />
      </div>

      {err && <p role="alert" className="mt-5 rounded-xl bg-amber-50 px-4 py-3 text-[13px] text-amber-900 ring-1 ring-amber-200/60">{err}</p>}
      {done && <p role="status" className="mt-5 rounded-xl bg-emerald-50 px-4 py-3 text-[13px] text-emerald-900 ring-1 ring-emerald-200/60">{done} <a href="/templates" className="font-medium underline">See them on Templates</a></p>}

      {plan && (
        <div className="mt-10">
          <div className="text-[18px] font-semibold text-ink">{plan.title}</div>
          {plan.summary && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{plan.summary}</p>}
          {plan.direction && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted"><span className="font-medium">Editorial direction:</span> {plan.direction}</p>}
          {plan.mix && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted"><span className="font-medium">Weekly mix:</span> {plan.mix}</p>}

          <div className="mt-6 grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {WEEK_ORDER.map((d) => {
              const day = slots.filter((sl) => sl.weekday === d);
              return (
                <div key={d} className="min-w-0 rounded-2xl bg-canvas/60 p-3 ring-1 ring-line/50">
                  <div className="mb-3 px-1 text-[12px] font-semibold uppercase tracking-wider text-ink-faint">{DAY_LABELS[d].slice(0, 3)}</div>
                  {day.find((sl) => sl.theme) && <div className="-mt-2 mb-3 px-1 text-[12px] italic text-ink-muted">{day.find((sl) => sl.theme)!.theme}</div>}
                  <div className="grid gap-3">
                    {day.length ? day.map((sl) => (
                      <SlotCard
                        key={sl._k}
                        slot={sl}
                        tone={toneFor(sl.pillar, pillars)}
                        onChange={(next) => updateSlot(sl._k, next)}
                        onRemove={() => removeSlot(sl._k)}
                      />
                    )) : <div className="text-[11px] text-ink-faint">No posts</div>}
                    {/* Add to the week: a new post on this day, edited in place. */}
                    <button type="button" onClick={() => addSlot(d)} className="rounded-xl border border-dashed border-line px-2 py-2 text-[12px] font-medium text-ink-muted transition hover:border-accent/60 hover:text-accent">
                      + Add a post
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {(plan.notes.length > 0 || (preview && (preview.already > 0 || preview.clashes.length > 0))) && (
            <ul className="mt-5 list-disc space-y-1 pl-5 text-[13px] text-ink-muted">
              {plan.notes.map((n, i) => <li key={'n' + i}>{n}</li>)}
              {preview && preview.already > 0 && <li>{preview.already} of these already exist from an earlier upload and will be left as they are.</li>}
              {preview && preview.clashes.slice(0, 5).map((c, i) => <li key={'c' + i}>{c.slot} shares its time with &ldquo;{c.with}&rdquo; — both will post.</li>)}
              {preview && preview.clashes.length > 5 && <li>…and {preview.clashes.length - 5} more at a shared time.</li>}
            </ul>
          )}

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <button
              type="button"
              onClick={() => void create()}
              disabled={creating || chosen === 0 || nothingNew}
              className="rounded-full bg-accent px-7 py-3 text-[15px] font-semibold text-white shadow-sm transition hover:opacity-90 disabled:opacity-50"
            >
              {creating ? 'Creating…' : nothingNew ? 'Already created' : 'Create ' + chosen + ' schedule' + (chosen === 1 ? '' : 's')}
            </button>
            <button type="button" onClick={() => { setPlan(null); setSlots([]); setPreview(null); }} className="text-[12px] font-medium text-ink-muted hover:underline">Discard</button>
            <span className="text-[12px] text-ink-faint">Open any card to see and edit every angle, or add a post to a day. Every post waits for your approval before it is scheduled or published.</span>
          </div>
        </div>
      )}
    </section>
  );
}
