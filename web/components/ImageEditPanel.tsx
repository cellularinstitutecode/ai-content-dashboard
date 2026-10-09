'use client';

// components/ImageEditPanel.tsx
// "Edit image" — OPEN BY DEFAULT under a draft's picture, on the Dashboard
// card and in the Calendar preview, so the free edits are the first thing on
// offer and nobody rerolls a picture just to change its words.
//
//   Title on the image     the words on the cover, re-rendered from the clean
//                          photograph kept beside it. No image model, no
//                          credits (POST /api/drafts/image { retitle }).
//   No title on the image  the clean photograph becomes the hero ({ retitle: '' }).
//   Title suggestions      three other short titles from the text model
//                          ({ suggestTitles }); clicking one fills the field.
//   Notes for the picture  what the next take should show, kept on the draft
//                          and reused by every later "New image" until cleared.
//   Edit this picture      the one button here that spends a credit, and it
//                          says so ({ regenerate, direction }). It EDITS the
//                          photograph that is already on the draft — the notes
//                          are applied to it, and everything they do not
//                          mention stays — unless "Start from a new picture"
//                          is ticked ({ fresh: true }), which makes one from
//                          the post's text as before. The field used to sit
//                          beside the picture and have nothing to do with it:
//                          every note produced a different, unrelated photo.
//
// The panel draws and decides; the host does the request and whatever follows
// it (reload, sync the Metricool post) through `onAction`, so the Calendar's
// confirm and the Dashboard's refresh stay where they are.
import { useState } from 'react';
import {
  cleanCoverTitle, creditConfirmText, creditLabel, currentCoverTitle, needsCreditConfirm, notesOf,
  retitleDecision, takesOf, titleApplyable, titleOff, type EditableImage,
} from '@/lib/cover-edit';
import { MAX_COVER_TITLE } from '@/lib/planner-image';
import { friendlyError } from '@/lib/friendly-error';

export type ImageAction = { label: string; credits: number; fallback: string };

/**
 * Ask before a credit-spending action only once this draft has had a few
 * generations already; a first or second take asks nothing. Hosts call it for
 * their own "New image" / "Show me 3 options" buttons too.
 */
export function okToSpend(image: EditableImage | null | undefined, credits: number): boolean {
  const takes = takesOf(image);
  if (!needsCreditConfirm(takes)) return true;
  return typeof window === 'undefined' ? true : window.confirm(creditConfirmText(credits, takes));
}

export default function ImageEditPanel({
  draftId,
  image,
  plannerTitle,
  busy,
  onAction,
}: {
  draftId: string | null;
  /** The draft's current picture (`_image`), or null when it has none yet. */
  image: EditableImage | null | undefined;
  /** The words the cover carries when nobody has set any (GET /api/drafts/image → title). */
  plannerTitle?: string | null;
  /** The host is already working on this draft's picture. */
  busy?: boolean;
  /** Send `body` to POST /api/drafts/image and do what follows. `meta.credits` is 0 for the free edits. */
  onAction: (body: Record<string, unknown>, meta: ImageAction) => Promise<void> | void;
}) {
  const shown = currentCoverTitle(image, plannerTitle);
  const off = titleOff(image);
  const can = retitleDecision(image);
  // What is typed, once somebody has typed; until then the field shows the
  // cover's own words. The host keys this panel by the picture's URL, so a new
  // take starts the fields afresh.
  const [typedTitle, setTypedTitle] = useState<string | null>(null);
  const [typedNotes, setTypedNotes] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // "Start from a new picture instead": off by default, so the notes edit the
  // picture that is there. A draft with no picture, or one whose picture has
  // no clean photograph behind it (the same rule as retitling), can only be
  // given a new one — the box is ticked for it and cannot be unticked.
  const [wantFresh, setWantFresh] = useState(false);
  const title = typedTitle ?? shown;
  const notes = typedNotes ?? notesOf(image);
  // "Apply title" has something to do when the words differ from the ones
  // painted — or when nothing is painted yet (a library photo, an upload).
  const titleChanged = titleApplyable(image, title, shown);
  const notesChanged = notes.trim() !== notesOf(image);
  const editable = Boolean(image?.url) && can.ok;
  const fresh = wantFresh || !editable;
  const idBase = 'img-edit-' + (draftId || 'none');

  async function suggest() {
    if (!draftId || suggesting) return;
    setSuggesting(true);
    setNote(null);
    try {
      const r = await fetch('/api/drafts/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: draftId, suggestTitles: true }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(friendlyError(j, 'No suggestions could be made just now.'));
      const list = Array.isArray(j?.titles) ? j.titles.map(String).filter(Boolean) : [];
      setSuggestions(list);
      if (!list.length) setNote('No suggestions could be made just now.');
    } catch (e) {
      setNote(friendlyError(e, 'No suggestions could be made just now.'));
    } finally {
      setSuggesting(false);
    }
  }

  function applyTitle() {
    const words = cleanCoverTitle(title);
    if (!words) return;
    void onAction({ retitle: words }, { label: 'retitle', credits: 0, fallback: 'The title could not be set on this picture.' });
  }

  function toggleTitle(checked: boolean) {
    if (checked) {
      void onAction({ retitle: '' }, { label: 'retitle', credits: 0, fallback: 'The title could not be taken off this picture.' });
    } else {
      const words = cleanCoverTitle(typedTitle || plannerTitle || image?.titled?.title || '');
      if (!words) { setTypedTitle(''); return; }
      void onAction({ retitle: words }, { label: 'retitle', credits: 0, fallback: 'The title could not be set on this picture.' });
    }
  }

  function regenerate() {
    if (!okToSpend(image, 1)) return;
    void onAction({ regenerate: true, direction: notes.trim(), fresh }, { label: 'notes', credits: 1, fallback: fresh ? 'The new image could not be made.' : 'The picture could not be edited.' });
  }

  const chip = 'rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition disabled:opacity-50 ';
  const plain = chip + 'bg-surface text-ink/70 ring-black/10 hover:bg-black/5';
  const disabled = Boolean(busy) || !draftId;

  return (
    <div className="mt-2 rounded-xl bg-white/70 p-3 ring-1 ring-black/5" aria-label="Edit image">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-[12px] font-semibold text-ink">Edit image</span>
        <span className="text-[11px] text-ink/50">Changing the title is free · a new picture costs credits</span>
      </div>

      {/* THE TITLE — free. */}
      <label htmlFor={idBase + '-title'} className="mt-2 block text-[11px] font-medium text-ink/70">Title on the image</label>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <input
          id={idBase + '-title'}
          type="text"
          value={title}
          maxLength={MAX_COVER_TITLE}
          disabled={disabled || off || !can.ok}
          onChange={(e) => setTypedTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && titleChanged && can.ok && !off) { e.preventDefault(); applyTitle(); } }}
          placeholder="A few words, set in the brand's serif"
          className="min-w-0 flex-1 rounded-lg bg-surface px-2.5 py-1 text-[12px] text-ink ring-1 ring-black/10 focus:ring-accent disabled:opacity-50"
        />
        <button
          type="button"
          disabled={disabled || off || !can.ok || !cleanCoverTitle(title) || !titleChanged}
          onClick={applyTitle}
          title={can.ok ? 'Re-sets the words on this same picture. No credits.' : can.reason}
          className={chip + 'bg-ink text-white ring-ink hover:opacity-90'}
        >{busy === true ? 'Working…' : 'Apply title'}</button>
        <label className={'flex items-center gap-1 text-[11px] text-ink/70 ' + (can.ok ? 'cursor-pointer' : 'opacity-50')} title={can.ok ? 'The clean photograph becomes the picture. No credits.' : can.reason}>
          <input type="checkbox" checked={off} disabled={disabled || !can.ok} onChange={(e) => toggleTitle(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
          No title on the image
        </label>
      </div>
      {!can.ok && image?.url && <p className="mt-1 text-[11px] text-amber-700">{can.reason}</p>}
      <p className="mt-0.5 text-[10px] text-ink/40">{title.length}/{MAX_COVER_TITLE}</p>

      {/* SUGGESTIONS — a text call, not an image one. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-ink/70">Title suggestions:</span>
        {suggestions.map((s) => (
          <button key={s} type="button" disabled={disabled || off || !can.ok} onClick={() => setTypedTitle(s)} className={plain} title="Put these words in the field">{s}</button>
        ))}
        <button type="button" disabled={disabled || suggesting || !can.ok} onClick={() => void suggest()} className={chip + 'bg-surface text-accent ring-black/10 hover:bg-black/5'} title="Three other short titles written from this post — no image is made">
          {suggesting ? 'Thinking…' : suggestions.length ? '↻ Three more' : '✨ Suggest 3 titles'}
        </button>
      </div>

      {/* NOTES — kept on the draft; the one credit-spending button here is last and says so. */}
      <label htmlFor={idBase + '-notes'} className="mt-3 block text-[11px] font-medium text-ink/70">Notes for the picture</label>
      <textarea
        id={idBase + '-notes'}
        value={notes}
        rows={2}
        maxLength={600}
        disabled={disabled}
        onChange={(e) => setTypedNotes(e.target.value)}
        placeholder={fresh ? 'e.g. two women at a table, no lab coat, warmer light, show fresh vegetables' : 'e.g. warmer light, take the glasses off the table, add fresh vegetables — the rest of the picture stays'}
        className="mt-1 w-full resize-none rounded-lg bg-surface px-2.5 py-1.5 text-[12px] text-ink ring-1 ring-black/10 focus:ring-accent disabled:opacity-50"
      />
      <label className={'mt-1.5 flex items-center gap-1 text-[11px] text-ink/70 ' + (editable ? 'cursor-pointer' : 'opacity-50')} title={editable ? 'Unticked, the notes change the picture that is here. Ticked, a new picture is made from the post instead.' : (image?.url && !can.ok ? can.reason : 'There is no picture to edit yet, so a new one is made.')}>
        <input type="checkbox" checked={fresh} disabled={disabled || !editable} onChange={(e) => setWantFresh(e.target.checked)} className="h-3.5 w-3.5 accent-accent" />
        Start from a new picture instead
      </label>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {image?.url && notesChanged && (
          <button type="button" disabled={disabled} onClick={() => void onAction({ saveNotes: notes.trim() }, { label: 'save-notes', credits: 0, fallback: 'The notes could not be saved.' })} className={plain} title="Keeps the notes for the next picture without making one. No credits.">
            {notes.trim() ? 'Save notes only' : 'Clear saved notes'}
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          disabled={disabled || (!fresh && !notes.trim())}
          onClick={regenerate}
          title={fresh
            ? 'Makes a new picture from the post and these notes, verified like any other. Spends one image credit.'
            : 'Applies these notes to the picture that is here — what they do not mention stays. Verified like any other take. Spends one image credit.'}
          className={chip + 'bg-accent text-white ring-accent hover:opacity-90'}
        >{busy ? 'Making…' : (fresh ? 'Make a new picture with these notes ' : 'Edit this picture with these notes ') + creditLabel(1)}</button>
      </div>
      <p className="mt-1 text-[10px] text-ink/40">{fresh ? 'The notes stay on the draft: every later new picture follows them until you clear them.' : 'The notes are applied to this picture; the title on it is set again afterwards. They stay on the draft until you clear them.'}</p>
      {note && <p role="status" className="mt-1 text-[11px] font-medium text-red-600">{note}</p>}
    </div>
  );
}
