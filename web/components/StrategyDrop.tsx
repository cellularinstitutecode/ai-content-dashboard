'use client';

// components/StrategyDrop.tsx
// "Drop weekly strategy": drop a strategy PDF, see its week laid out day by
// day, press "Create schedules". The slots become Autopilot templates
// (app/api/templates/strategy-upload/route.ts, lib/strategy-upload.ts): each
// post is written the way the built-in weekly strategy is (the document's
// angle, its voice, no promotion), verified, and waits in the review queue —
// approved posts go to the calendar and Metricool as they already do. Nothing
// here deletes or changes anything.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { announce } from '@/components/refreshBus';
import { PanelLoader } from '@/components/LoadingScreen';
import LibraryPicker from '@/components/LibraryPicker';
import { beginQueue, isPaused, setPaused, subscribePause, whenResumed } from '@/components/pauseBus';
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

/** One post of the week, as a compact card. "Preview & edit" opens it in the panel. */
function SlotCard({ slot, tone, writing, written, held, onChange, onOpen }: { slot: EditableSlot; tone: string; writing?: Writing; written?: boolean; held?: boolean; onChange: (next: EditableSlot) => void; onOpen: () => void }) {
  return (
    <div className={'min-w-0 break-words hyphens-auto rounded-2xl p-3.5 text-[12px] ring-1 transition ' + tone + (slot.on ? '' : ' opacity-40')}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[13px] font-semibold tabular-nums">{slot.time}</span>
        <input type="checkbox" checked={slot.on} onChange={() => onChange({ ...slot, on: !slot.on })} aria-label={'Include ' + slot.pillar + ' on ' + DAY_LABELS[slot.weekday]} className="mt-0.5" />
      </div>
      <button type="button" onClick={onOpen} className="mt-2 text-left text-[14px] font-semibold leading-snug hover:underline">{slot.pillar}</button>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {slot.format === 'blog' && <span className="rounded-md bg-white/70 px-1.5 py-0.5 font-medium">Article</span>}
        {slot.providers.map((p) => <span key={p} className="rounded-md bg-white/70 px-1.5 py-0.5">{NETWORK_LABEL[p] || p}</span>)}
      </div>
      <div className="mt-3 leading-relaxed opacity-80" title={slot.angles.join('\n')}>
        {slot.angles.length} angle{slot.angles.length === 1 ? '' : 's'}{slot.angles[0] ? ' · e.g. “' + slot.angles[0] + '”' : ''}
      </div>
      {/* The document's note for this post, shown so the team can see it was read. */}
      {slot.rule && <div className="mt-2 rounded-lg bg-white/70 px-2 py-1.5 text-[11px] leading-snug"><span className="font-semibold">Note:</span> {slot.rule}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={onOpen} className="rounded-md bg-white/80 px-2 py-1 text-[11px] font-medium ring-1 ring-black/10 hover:bg-white">Preview &amp; edit</button>
        {writing && <span className="inline-flex items-center gap-1 text-[11px] font-medium text-accent"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />{writing === 'picture' ? 'Making the picture…' : 'Writing the post…'}</span>}
        {!writing && written && !held && <span className="text-[11px] font-medium text-emerald-700">Post written</span>}
        {!writing && written && held && <span className="text-[11px] font-medium text-amber-700">Written, citation held</span>}
      </div>
    </div>
  );
}

/**
 * The post, opened: the same preview panel the calendar uses for a post,
 * with every angle in full and everything editable at full width — the
 * pillar, day and time, channels (or Article), the angles (add, edit,
 * remove), the writer's note. Changes apply as they are typed; "Done"
 * closes. The server normalises whatever comes back
 * (lib/strategy-upload.ts normalizeUpload), so nothing typed here can reach
 * a template unchecked.
 */
type PreviewChecks = { keywords: string[]; keywordSource: string; citation: string; held: string | null };
type PreviewDraft = { draftId: string | null; pack: Record<string, unknown>; image: { url: string; alt?: string | null } | null; note?: string; /** Keywords and the citation verdict, as every other post has them at the door. */ checks?: PreviewChecks; /** Why there is no picture, when the picture step said. */ imageNote?: string; /** What the last Verify / fix concluded. */ fixNote?: string; /** The quality the picture was made at ('medium' for a preview's first take). */ imageQuality?: string };
/** Remembered per browser: whether pictures are made while the week is written. */
const PICTURES_KEY = 'strategy:pictures:v1';
/** Which half of the work a slot is on. The work runs above the panel, so the panel can be closed and reopened. */
type Writing = 'text' | 'picture' | 'fix' | 'saving' | null;
const scopeFor = (k: string) => 'strategy-' + k;
const CHANNEL_KEYS: { key: string; label: string }[] = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'blog', label: 'Article' },
];

function SlotPanel({ slot, draft, writing, draftErr, onWrite, onPicture, onFix, onLibraryPicked, onSave, onChange, onRemove, onClose }: {
  slot: EditableSlot;
  draft: PreviewDraft | null;
  writing: Writing;
  draftErr: string | null;
  onWrite: (angle: string) => void;
  /** Make (or remake) the post's picture. */
  onPicture: (again: boolean) => void;
  /** "Verify / fix": check the cited study against the copy; swap it when it does not back it. */
  onFix: () => void;
  /** A library photograph was made the picture (components/LibraryPicker.tsx). */
  onLibraryPicked: (image: { url: string; alt?: string | null }, notes: string[]) => void;
  /** Save the copy as edited, per channel. Resolves true when saved. */
  onSave: (edits: Record<string, string>) => Promise<boolean>;
  onChange: (next: EditableSlot) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [newAngle, setNewAngle] = useState('');
  // THE EDITOR, like every other preview's: the copy of each channel in a box
  // you can type in, saved to the same draft the post was written to.
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const startEditing = () => {
    if (!draft) return;
    const next: Record<string, string> = {};
    for (const c of CHANNEL_KEYS) if (typeof draft.pack[c.key] === 'string' && String(draft.pack[c.key]).trim()) next[c.key] = String(draft.pack[c.key]);
    setEdits(next); setEditing(true);
  };
  const saveEditing = async () => { if (await onSave(edits)) setEditing(false); };
  /** "Pick image from library": the grid, open under the buttons. */
  const [picking, setPicking] = useState(false);
  const [angleChoice, setAngleChoice] = useState<string>('');
  const drafting = Boolean(writing);
  const set = (patch: Partial<EditableSlot>) => onChange({ ...slot, ...patch });
  const setAngle = (i: number, v: string) => set({ angles: slot.angles.map((a, j) => (j === i ? v : a)) });
  const removeAngle = (i: number) => set({ angles: slot.angles.filter((_, j) => j !== i) });
  const addAngle = () => { const t = newAngle.trim(); if (!t) return; set({ angles: [...slot.angles, t] }); setNewAngle(''); };
  const toggleNetwork = (n: string) => {
    const has = slot.providers.includes(n);
    const next = has ? slot.providers.filter((p) => p !== n) : [...slot.providers, n];
    set({ providers: next.length ? next : slot.providers });
  };
  const field = 'w-full rounded-xl bg-canvas px-3 py-2 text-[13px] text-ink ring-1 ring-black/10 focus:outline-none focus:ring-accent/40';
  const label = 'mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink/50';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl ring-1 ring-black/10" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Post preview">
        <div className="flex items-start justify-between gap-3 border-b border-black/5 px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-ink">{slot.pillar || 'New post'}</h3>
            <p className="mt-0.5 text-[12px] text-ink/50">{DAY_LABELS[slot.weekday]} · {slot.time} · {slot.format === 'blog' ? 'Article' : slot.providers.map((p) => NETWORK_LABEL[p] || p).join(', ')} · one post a week, drawing on one of the angles below</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close preview" className="shrink-0 rounded-full px-2 text-lg leading-none text-ink/50 hover:bg-black/5">×</button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_140px_110px]">
            <div>
              <span className={label}>Pillar</span>
              <input aria-label="Pillar" value={slot.pillar} onChange={(e) => set({ pillar: e.target.value })} className={field + ' text-[15px] font-semibold'} />
            </div>
            <div>
              <span className={label}>Day</span>
              <select aria-label="Day" value={slot.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })} className={field}>
                {WEEK_ORDER.map((d) => <option key={d} value={d}>{DAY_LABELS[d]}</option>)}
              </select>
            </div>
            <div>
              <span className={label}>Time</span>
              <input aria-label="Time" value={slot.time} onChange={(e) => set({ time: e.target.value })} placeholder="09:00" className={field + ' tabular-nums'} />
            </div>
          </div>
          {slot.theme && <p className="mt-2 text-[12px] italic text-ink/60">Day theme: {slot.theme}</p>}

          <div className="mt-4">
            <span className={label}>Where it goes</span>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" onClick={() => set(slot.format === 'blog' ? { format: 'social', providers: [...SOCIAL_NETWORKS] } : { format: 'blog', providers: ['blog'] })}
                className={'rounded-full px-3 py-1 text-[12px] font-medium ring-1 ' + (slot.format === 'blog' ? 'bg-ink text-white ring-ink' : 'bg-white ring-black/10')}>Article</button>
              {slot.format !== 'blog' && SOCIAL_NETWORKS.map((n) => (
                <button key={n} type="button" onClick={() => toggleNetwork(n)} className={'rounded-full px-3 py-1 text-[12px] font-medium ring-1 ' + (slot.providers.includes(n) ? 'bg-ink text-white ring-ink' : 'bg-white ring-black/10')}>{NETWORK_LABEL[n] || n}</button>
              ))}
            </div>
          </div>

          <div className="mt-5">
            <span className={label}>Angles — every week’s post draws on one of these, in turn</span>
            <ol className="space-y-2">
              {slot.angles.map((a, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="mt-2 w-5 shrink-0 text-right text-[12px] tabular-nums text-ink/40">{i + 1}.</span>
                  <textarea aria-label={'Angle ' + (i + 1)} value={a} onChange={(e) => setAngle(i, e.target.value)} rows={2} className={field + ' resize-y leading-relaxed'} />
                  <button type="button" onClick={() => removeAngle(i)} aria-label="Remove angle" className="mt-1.5 shrink-0 rounded-md px-2 py-1 text-[12px] text-red-600 ring-1 ring-red-200 hover:bg-red-50">Remove</button>
                </li>
              ))}
              {!slot.angles.length && <li className="text-[12px] text-ink/50">No angles yet — add the first one below.</li>}
            </ol>
            <div className="mt-2 flex items-center gap-2 pl-7">
              <input aria-label="New angle" value={newAngle} onChange={(e) => setNewAngle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addAngle(); } }} placeholder="Add an angle…" className={field} />
              <button type="button" onClick={addAngle} disabled={!newAngle.trim()} className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-[12px] font-semibold text-white disabled:opacity-40">Add</button>
            </div>
          </div>

          <div className="mt-5">
            <span className={label}>Note for the writer</span>
            <textarea aria-label="Note" value={slot.rule} onChange={(e) => set({ rule: e.target.value })} rows={3} placeholder="e.g. mention the recovery lounge without promoting it" className={field + ' resize-y leading-relaxed'} />
          </div>

          {/* THE POST ITSELF. Written the way the Autopilot will write it, saved
              under Recent Drafts like any other draft, with its picture. */}
          <div className="relative mt-6 rounded-2xl bg-canvas/70 p-4 ring-1 ring-line/60">
            {/* The loader covers THIS box and nothing else: the page, the week
                and the rest of the panel stay usable while it works. */}
            {writing === 'text' && <PanelLoader scope={scopeFor(slot._k)} rounded="rounded-2xl" />}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] font-semibold text-ink">The post, written</span>
              <span className="flex-1" />
              {slot.angles.length > 1 && (
                <select aria-label="Angle to write" value={angleChoice || slot.angles[0]} onChange={(e) => setAngleChoice(e.target.value)} disabled={drafting} className="max-w-[260px] rounded-xl bg-white px-2 py-1.5 text-[12px] text-ink ring-1 ring-black/10">
                  {slot.angles.map((a, i) => <option key={i} value={a}>{a.length > 60 ? a.slice(0, 59) + '…' : a}</option>)}
                </select>
              )}
              <button type="button" onClick={() => onWrite(angleChoice || slot.angles[0] || '')} disabled={drafting || !slot.pillar.trim()} className="rounded-full bg-accent px-4 py-1.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {writing === 'text' ? 'Writing…' : writing === 'picture' ? 'Making the picture…' : draft ? 'Write it again' : 'Write a preview post'}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-ink/50">One week&rsquo;s post for this slot, written as you open it, exactly as the Autopilot will write it &mdash; the strategy&rsquo;s voice, this note, keywords, the competition, a citation when it makes a health claim, checked by the judge and fixed when it fails &mdash; saved to Recent Drafts, with its picture following. You can close this and carry on; the card says when it is done. Nothing is scheduled.</p>
            {writing === 'text' && <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] text-accent">Writing the post (about half a minute). The picture follows once the copy is here.</div>}
            {writing === 'picture' && <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] text-accent">Copy is in; making the picture (up to two minutes).</div>}
            {writing === 'fix' && <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-[12px] text-accent">Checking the cited study against the post, and looking for a better one if it does not back it (up to two minutes).</div>}
            {draftErr && <p role="alert" className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-900 ring-1 ring-amber-200/60">{draftErr}</p>}
            {draft && (
              <div className="mt-4 space-y-4">
                {/* Edit, Verify / fix, the picture: the same controls every other preview has. */}
                <div className="flex flex-wrap items-center gap-2">
                  {editing ? (
                    <>
                      <button type="button" onClick={() => void saveEditing()} disabled={writing === 'saving'} className="rounded-full bg-accent px-3 py-1 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50">{writing === 'saving' ? 'Saving…' : 'Save changes'}</button>
                      <button type="button" onClick={() => setEditing(false)} disabled={writing === 'saving'} className="rounded-full px-3 py-1 text-[12px] font-medium text-ink/70 ring-1 ring-black/10 hover:bg-black/5">Cancel</button>
                    </>
                  ) : (
                    <button type="button" onClick={startEditing} disabled={drafting || !draft.draftId} className="rounded-full px-3 py-1 text-[12px] font-medium text-ink/70 ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50">Edit</button>
                  )}
                  <button type="button" onClick={onFix} disabled={drafting || editing || !draft.draftId} title="Check that the cited study supports this post; replace it with one that does if not" className="rounded-full px-3 py-1 text-[12px] font-medium text-ink/70 ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50">{writing === 'fix' ? 'Checking…' : 'Verify / fix'}</button>
                  <button type="button" onClick={() => setPicking((v) => !v)} disabled={drafting || editing || !draft.draftId} title="A real photo from the team's Drive folder, with the brand's colour filter — no AI, no credits" className={'rounded-full px-3 py-1 text-[12px] font-medium ring-1 disabled:opacity-50 ' + (picking ? 'bg-accent text-white ring-accent' : 'text-ink/70 ring-black/10 hover:bg-black/5')}>📁 Pick image from library</button>
                  <button type="button" onClick={() => onPicture(Boolean(draft.image?.url))} disabled={drafting || editing || !draft.draftId} title="A fresh AI picture, high quality. Spends a credit." className="rounded-full px-3 py-1 text-[12px] font-medium text-ink/70 ring-1 ring-black/10 hover:bg-black/5 disabled:opacity-50">{writing === 'picture' ? 'Making the picture…' : draft.image?.url ? 'Make an AI picture instead' : 'Make the picture'}</button>
                </div>
                {picking && draft.draftId && (
                  <LibraryPicker draftId={draft.draftId} scope={scopeFor(slot._k)} onChanged={(image, notes) => onLibraryPicked(image, notes)} onClose={() => setPicking(false)} />
                )}
                {draft.image?.url ? (
                  <div>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={draft.image.url} alt={draft.image.alt || 'Post picture'} className="max-h-80 w-full rounded-xl object-cover ring-1 ring-black/10" />
                    {draft.imageQuality === 'medium' && <p className="mt-1 text-[11px] text-ink/50">No library photograph fit this post, so a preview picture was made at medium quality (about a quarter of the cost). &ldquo;Make an AI picture instead&rdquo; makes a high-quality one.</p>}
                    {draft.imageQuality === 'library' && <p className="mt-1 text-[11px] text-emerald-800">📁 The clinic&rsquo;s own photograph, from the Image Library, with the brand&rsquo;s colour filter &mdash; no AI, no credits.{draft.imageNote ? ' ' + draft.imageNote : ''}</p>}
                  </div>
                ) : writing === 'picture' ? (
                  <div className="flex h-40 items-center justify-center rounded-xl bg-white/60 text-[12px] text-accent ring-1 ring-accent/20"><span className="mr-2 h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />Making the picture…</div>
                ) : (
                  <p role={draft.imageNote ? 'alert' : undefined} className={'rounded-xl px-3 py-2 text-[12px] ' + (draft.imageNote ? 'bg-amber-50 text-amber-900 ring-1 ring-amber-200/60' : 'text-ink/50')}>
                    {draft.imageNote || 'No picture yet.'} Press &ldquo;Make the picture&rdquo; to try again.
                  </p>
                )}
                {CHANNEL_KEYS.filter((c) => typeof draft.pack[c.key] === 'string' && String(draft.pack[c.key]).trim()).map((c) => (
                  <div key={c.key}>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink/50">{c.label}</div>
                    {editing ? (
                      <textarea aria-label={c.label + ' copy'} value={edits[c.key] ?? ''} onChange={(e) => setEdits((cur) => ({ ...cur, [c.key]: e.target.value }))} rows={Math.min(24, Math.max(6, (edits[c.key] ?? '').split('\n').length + 2))} className="w-full resize-y rounded-xl bg-white px-3.5 py-3 text-[13px] leading-relaxed text-ink ring-1 ring-accent/40 focus:outline-none focus:ring-2 focus:ring-accent" />
                    ) : (
                      <div className="whitespace-pre-wrap rounded-xl bg-white px-3.5 py-3 text-[13px] leading-relaxed text-ink ring-1 ring-black/5">{String(draft.pack[c.key])}</div>
                    )}
                  </div>
                ))}
                {/* APPROVED AND FIXED, like every other post: the keywords it was
                    written around and the judge's verdict on its citation, as
                    stamped on the draft — the same two things the door reads. */}
                {draft.checks && (
                  <div className={'rounded-xl px-3.5 py-3 text-[12px] leading-relaxed ring-1 ' + (draft.checks.held ? 'bg-amber-50 text-amber-900 ring-amber-200/60' : 'bg-emerald-50/70 text-emerald-900 ring-emerald-200/60')}>
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-70">Checked</div>
                    <div>
                      <span className="font-medium">Keywords{draft.checks.keywordSource && draft.checks.keywordSource !== 'semrush' ? ' (estimated, no Semrush data)' : ''}:</span>{' '}
                      {draft.checks.keywords.length ? draft.checks.keywords.slice(0, 8).join(', ') : 'none could be researched'}
                    </div>
                    <div className="mt-1">{draft.checks.citation}</div>
                    {draft.fixNote && <div className="mt-1" role="status">{draft.fixNote}</div>}
                    {draft.checks.held && <div role="alert" className="mt-1.5 font-medium">{draft.checks.held}</div>}
                  </div>
                )}
                <p className="text-[12px] text-ink/60">
                  {draft.note || ''}{' '}
                  {draft.draftId && <a href={'/?draft=' + draft.draftId} className="font-medium text-accent hover:underline">Open in Recent Drafts to send it</a>}
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-black/5 bg-canvas px-5 py-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink/70">
            <input type="checkbox" checked={slot.on} onChange={() => set({ on: !slot.on })} className="h-3.5 w-3.5" /> Include this post
          </label>
          <span className="flex-1" />
          <button type="button" onClick={onRemove} className="rounded-full px-3 py-1 text-[12px] font-medium text-red-600 ring-1 ring-red-200 hover:bg-red-50">Remove post</button>
          <button type="button" onClick={onClose} className="rounded-full bg-accent px-4 py-1 text-[12px] font-semibold text-white hover:opacity-90">Done</button>
        </div>
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
  /** The slot open in the preview panel, by key. */
  const [openKey, setOpenKey] = useState<string | null>(null);
  /** Posts written for real, by slot key — kept here so the panel can be closed while they are written. */
  const [previews, setPreviews] = useState<Record<string, PreviewDraft>>({});
  const [writing, setWriting] = useState<Record<string, Writing>>({});
  const [writeErr, setWriteErr] = useState<Record<string, string | null>>({});
  /** Slots whose post has been started, so nothing is written twice. */
  const autoStarted = useRef<Set<string>>(new Set());
  // Mirrors for the queue below, which outlives any one render.
  const previewsRef = useRef(previews); previewsRef.current = previews;
  const writingRef = useRef(writing); writingRef.current = writing;
  const [weekWriting, setWeekWriting] = useState(false);
  // THE BRAKES. `paused` mirrors the page-wide pause (components/pauseBus.ts,
  // the button on the right-hand badge); `pictures` is the switch for making
  // pictures at all while the week is written — the expensive half, and the
  // half a person may not want until they have read the posts.
  const [paused, setPausedState] = useState(false);
  useEffect(() => subscribePause(() => setPausedState(isPaused())), []);
  const [pictures, setPictures] = useState(true);
  const picturesRef = useRef(pictures); picturesRef.current = pictures;
  useEffect(() => {
    try { const v = window.localStorage.getItem(PICTURES_KEY); if (v === 'off') setPictures(false); } catch { /* private mode */ }
  }, []);
  const togglePictures = () => {
    setPictures((v) => { try { window.localStorage.setItem(PICTURES_KEY, v ? 'off' : 'on'); } catch { /* private mode */ } return !v; });
  };

  /**
   * THE WEEK, WRITTEN AS SOON AS IT IS READ. Every post of the week is
   * drafted in the background, two at a time, the moment the PDF has been
   * read — so by the time a post is opened it is built or being built,
   * rather than starting then. Each one is the same work "Preview & edit"
   * does: the strategy's voice, keywords, the competition, a citation when
   * a health claim is made, saved to Recent Drafts, picture following.
   */
  async function writeWeek(list: EditableSlot[]) {
    const pending = list.filter((sl) => sl.on && sl.pillar.trim() && sl.pillar !== 'New post');
    if (!pending.length) return;
    setWeekWriting(true);
    const endQueue = beginQueue();
    let i = 0;
    const worker = async () => {
      while (i < pending.length) {
        // Paused: nothing new starts until Resume. What is in flight finishes.
        await whenResumed();
        const sl = pending[i++];
        if (!sl || previewsRef.current[sl._k] || writingRef.current[sl._k]) continue;
        autoStarted.current.add(sl._k);
        await writePreview(sl, sl.angles[0] || '');
      }
    };
    try { await Promise.all([worker(), worker()]); } finally { setWeekWriting(false); endQueue(); }
  }

  async function writePreview(sl: EditableSlot, angle: string) {
    const k = sl._k;
    const headers = { 'Content-Type': 'application/json', 'x-chi-progress': 'loud', 'x-chi-progress-scope': scopeFor(k) };
    setWriting((w) => ({ ...w, [k]: 'text' }));
    setWriteErr((e) => ({ ...e, [k]: null }));
    try {
      const { _k: _key, on: _on, ...plain } = sl;
      // 1) the copy — shown as soon as it is here
      const r = await fetch('/api/templates/strategy-upload', { method: 'POST', headers, body: JSON.stringify({ action: 'draft', slot: plain, direction: plan?.direction || '', angle }) });
      if (!r.ok) throw new Error(await friendlyErrorFromResponse(r, 'The post could not be written just now.'));
      const made = (await r.json()) as PreviewDraft;
      setPreviews((p) => ({ ...p, [k]: made }));
      announce('drafts', 'stats');
      // 2) the picture — a second, quieter request, while the copy is read.
      // Not when pictures are off, and not when the pause came on while the
      // copy was being written: the picture is the expensive half.
      // The id is passed, not read back: the state set a line above is not on the ref yet.
      if (made.draftId && picturesRef.current && !isPaused()) await makePicture(sl, false, { draftId: made.draftId, keepBusy: true });
      else if (made.draftId) setPreviews((p) => (p[k] ? { ...p, [k]: { ...p[k], imageNote: isPaused() ? 'Paused before the picture was started.' : 'Pictures are switched off while the week is written.' } } : p));
    } catch (e) {
      setWriteErr((er) => ({ ...er, [k]: friendlyError(e, 'The post could not be written just now.') }));
    } finally {
      setWriting((w) => ({ ...w, [k]: null }));
    }
  }

  /**
   * The post's picture, made (or made again) as its own request. A failure is
   * SAID on the post — "no picture was made this time" with no reason is what
   * the team saw for a whole week of previews — and the button offers a retry.
   */
  async function makePicture(sl: EditableSlot, again: boolean, opts: { draftId?: string | null; keepBusy?: boolean } = {}) {
    const k = sl._k;
    const draftId = opts.draftId || previewsRef.current[k]?.draftId;
    if (!draftId) return;
    const headers = { 'Content-Type': 'application/json', 'x-chi-progress': 'quiet', 'x-chi-progress-scope': scopeFor(k) };
    setWriting((w) => ({ ...w, [k]: 'picture' }));
    try {
      const pr = await fetch('/api/templates/strategy-upload', { method: 'POST', headers, body: JSON.stringify({ action: 'picture', draftId, again }) });
      if (!pr.ok) throw new Error(await friendlyErrorFromResponse(pr, 'The picture could not be made just now.'));
      const { image, reason, quality, notes } = (await pr.json()) as { image: PreviewDraft['image']; reason?: string; quality?: string; notes?: string[] };
      setPreviews((p) => {
        const cur = p[k]; if (!cur) return p;
        return image?.url
          ? { ...p, [k]: { ...cur, image, imageNote: (notes || []).join(' ') || undefined, imageQuality: quality, pack: { ...cur.pack, _image: image } } }
          : { ...p, [k]: { ...cur, imageNote: reason || 'The picture could not be made just now.' } };
      });
      if (image?.url) announce('drafts', 'images');
    } catch (e) {
      const note = friendlyError(e, 'The picture could not be made just now.');
      setPreviews((p) => (p[k] ? { ...p, [k]: { ...p[k], imageNote: note } } : p));
    } finally {
      if (!opts.keepBusy) setWriting((w) => ({ ...w, [k]: null }));
    }
  }

  /** "Verify / fix" on a previewed post: the same check the calendar's button runs, on the draft. */
  async function verifyFix(sl: EditableSlot) {
    const k = sl._k;
    const draftId = previewsRef.current[k]?.draftId;
    if (!draftId) return;
    setWriting((w) => ({ ...w, [k]: 'fix' }));
    setWriteErr((e) => ({ ...e, [k]: null }));
    try {
      const r = await fetch('/api/templates/strategy-upload', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-chi-progress': 'loud', 'x-chi-progress-scope': scopeFor(k) }, body: JSON.stringify({ action: 'fix', draftId }) });
      if (!r.ok) throw new Error(await friendlyErrorFromResponse(r, 'The citation could not be checked just now.'));
      const out = (await r.json()) as { pack: Record<string, unknown>; note: string; swapped: boolean; checks: PreviewChecks };
      setPreviews((p) => (p[k] ? { ...p, [k]: { ...p[k], pack: { ...p[k].pack, ...out.pack }, checks: out.checks, fixNote: out.note } } : p));
      announce('drafts', 'stats');
    } catch (e) {
      setWriteErr((er) => ({ ...er, [k]: friendlyError(e, 'The citation could not be checked just now.') }));
    } finally {
      setWriting((w) => ({ ...w, [k]: null }));
    }
  }

  /** The copy as edited in the panel, saved to the draft it was written to (PATCH /api/drafts, as Recent Drafts saves). */
  async function saveEdits(sl: EditableSlot, edits: Record<string, string>): Promise<boolean> {
    const k = sl._k;
    const cur = previewsRef.current[k];
    if (!cur?.draftId) return false;
    setWriting((w) => ({ ...w, [k]: 'saving' }));
    setWriteErr((e) => ({ ...e, [k]: null }));
    try {
      const pack = { ...cur.pack, ...edits };
      const r = await fetch('/api/drafts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cur.draftId, pack }) });
      if (!r.ok) throw new Error(await friendlyErrorFromResponse(r, 'We could not save those changes.'));
      const j = (await r.json().catch(() => null)) as { draft?: { pack?: Record<string, unknown> } } | null;
      setPreviews((p) => (p[k] ? { ...p, [k]: { ...p[k], pack: j?.draft?.pack || pack } } : p));
      announce('drafts', 'stats');
      return true;
    } catch (e) {
      setWriteErr((er) => ({ ...er, [k]: friendlyError(e, 'We could not save those changes.') }));
      return false;
    } finally {
      setWriting((w) => ({ ...w, [k]: null }));
    }
  }

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
      const laidOut = ((j.plan?.slots || []) as UploadSlot[]).map((sl) => ({ ...sl, _k: slotKey(), on: true }));
      setSlots(laidOut);
      setPreview(j.preview ?? null);
      setPreviews({}); setWriting({}); setWriteErr({}); autoStarted.current.clear();
      // The moment the week is on screen, its posts start being written.
      void writeWeek(laidOut);
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
  const addSlot = (weekday: number): string => {
    const k = slotKey();
    setSlots((prev) => {
      const sameDay = prev.filter((sl) => sl.weekday === weekday);
      const theme = sameDay.find((sl) => sl.theme)?.theme || '';
      const time = sameDay.some((sl) => sl.time === '09:00') ? (sameDay.some((sl) => sl.time === '18:00') ? '13:00' : '18:00') : '09:00';
      return [...prev, { _k: k, on: true, weekday, time, pillar: 'New post', theme, angles: [], format: 'social', providers: [...SOCIAL_NETWORKS], rule: '' }];
    });
    return k;
  };
  const openSlot = openKey ? slots.find((sl) => sl._k === openKey) || null : null;
  // Opening a post writes it, once: the panel is for reading the post, not
  // for pressing another button first. "Write it again" stays for a redo.
  useEffect(() => {
    if (!openSlot) return;
    const k = openSlot._k;
    if (autoStarted.current.has(k) || previews[k] || writing[k] || !openSlot.pillar.trim() || openSlot.pillar === 'New post') return;
    autoStarted.current.add(k);
    void writePreview(openSlot, openSlot.angles[0] || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);
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
          {(() => {
            const listed = slots.filter((sl) => sl.on);
            const done = listed.filter((sl) => previews[sl._k]).length;
            const busy = listed.filter((sl) => writing[sl._k]).length;
            if (!listed.length || (!done && !busy && !weekWriting)) return null;
            const all = done === listed.length;
            const tone = all ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : paused ? 'bg-amber-50 text-amber-900 ring-amber-200' : 'bg-accent/5 text-accent ring-accent/30';
            const line = all
              ? 'All ' + listed.length + ' posts are written — open any to read it.'
              : paused
                ? 'Paused — ' + done + ' of ' + listed.length + ' ready' + (busy ? ', ' + busy + ' finishing' : '') + '. Nothing new is started until you resume.'
                : 'Writing the week’s posts: ' + done + ' of ' + listed.length + ' ready' + (busy ? ', ' + busy + ' being written' : '') + '.';
            return (
              <div className={'mt-3 rounded-xl px-3 py-2 text-[12px] ring-1 ' + tone} role="status" aria-live="polite">
                <div className="flex flex-wrap items-center gap-2">
                  {!all && !paused && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
                  <span className="font-medium">{line}</span>
                  <span className="flex-1" />
                  {/* The brakes, beside the progress and on the right-hand badge alike. */}
                  {weekWriting && (
                    <button type="button" onClick={() => setPaused(!paused)} className={'rounded-full px-3 py-0.5 text-[11px] font-semibold ring-1 ' + (paused ? 'bg-accent text-white ring-accent' : 'bg-white text-ink ring-black/10 hover:bg-black/5')}>{paused ? 'Resume' : 'Pause'}</button>
                  )}
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-medium text-ink/70" title="Pictures are the expensive half: about a quarter of a dollar each at high quality, a few cents at the preview quality used here. Off, the posts are still written and any picture can be made from its panel.">
                    <input type="checkbox" checked={pictures} onChange={togglePictures} className="h-3.5 w-3.5" /> Pictures while writing
                  </label>
                </div>
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-black/5">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: Math.round((done / listed.length) * 100) + '%' }} />
                </div>
              </div>
            );
          })()}
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
                        writing={writing[sl._k] || null}
                        written={Boolean(previews[sl._k])}
                        held={Boolean(previews[sl._k]?.checks?.held)}
                        onChange={(next) => updateSlot(sl._k, next)}
                        onOpen={() => setOpenKey(sl._k)}
                      />
                    )) : <div className="text-[11px] text-ink-faint">No posts</div>}
                    {/* Add to the week: a new post on this day, edited in place. */}
                    <button type="button" onClick={() => setOpenKey(addSlot(d))} className="rounded-xl border border-dashed border-line px-2 py-2 text-[12px] font-medium text-ink-muted transition hover:border-accent/60 hover:text-accent">
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
            <span className="text-[12px] text-ink-faint">Open any post to see and edit every angle, or add a post to a day. Every post waits for your approval before it is scheduled or published.</span>
          </div>
        </div>
      )}

      {/* At the document root, like the dashboard's own draft modal: the
          dashboard's panels animate in with a transform, and a fixed dialog
          inside a transformed ancestor is positioned against THAT box — it
          was centred far down the page, leaving only the grey backdrop in
          view (the "grey screen that lasts forever"). */}
      {openSlot && typeof document !== 'undefined' ? createPortal(
        <SlotPanel
          slot={openSlot}
          draft={previews[openSlot._k] || null}
          writing={writing[openSlot._k] || null}
          draftErr={writeErr[openSlot._k] || null}
          onWrite={(angle) => void writePreview(openSlot, angle)}
          onPicture={(again) => void makePicture(openSlot, again)}
          onFix={() => void verifyFix(openSlot)}
          onLibraryPicked={(image, notes) => {
            const k = openSlot._k;
            setPreviews((p) => (p[k] ? { ...p, [k]: { ...p[k], image, imageQuality: 'library', imageNote: notes.join(' ') || undefined, pack: { ...p[k].pack, _image: image } } } : p));
            announce('drafts', 'images');
          }}
          onSave={(edits) => saveEdits(openSlot, edits)}
          onChange={(next) => updateSlot(openSlot._k, next)}
          onRemove={() => { removeSlot(openSlot._k); setOpenKey(null); }}
          onClose={() => setOpenKey(null)}
        />,
        document.body,
      ) : null}
    </section>
  );
}
