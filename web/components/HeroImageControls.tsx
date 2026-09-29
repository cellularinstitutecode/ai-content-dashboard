'use client';

// components/HeroImageControls.tsx
// The "Image" section of the Publishing list's preview: the ways to change
// the picture on a draft, all through the endpoints the Dashboard already uses.
// The free ones come first; the one that spends a credit is last and says so.
//
//   Choose from library import_image (the Image Library's "Use as hero image")
//                       then { useUrl } — the photo with the brand's colour
//                       filter, no title, no generation
//   Library + brand     import_image, then { brandPhotoUrl } — the SAME photo
//                       with the brand filter and the post's title on it
//                       (lib/library-hero.ts). No AI image is made.
//   Edit image          the panel, open by default (components/ImageEditPanel.tsx):
//                       the title re-set on the same picture for free, other
//                       titles suggested, and notes for the next take.
//   New AI image        POST /api/drafts/image { regenerate }  (the "↻ New image")
//
// Every generated take goes through the same verification as any other. What
// happens AFTER the draft changed (reload, sync the Metricool post) belongs to
// the caller.

import { useEffect, useState } from 'react';
import { PanelLoader } from '@/components/LoadingScreen';
import ImageEditPanel, { okToSpend, type ImageAction } from '@/components/ImageEditPanel';
import { friendlyError, friendlyImageError } from '@/lib/friendly-error';
import ImportingLabel from '@/components/ImportingLabel';
import { creditLabel, type EditableImage } from '@/lib/cover-edit';
import { sizeLabel, tileNote, tooLargeToImport } from '@/lib/library-import';

type DriveImage = { id: string; name: string; thumbUrl?: string; viewUrl?: string; size?: number | null };
type Mode = 'use' | 'brand';
/** What GET /api/drafts/image returns for the panel. */
type PictureState = { image: EditableImage | null; title: string };

export default function HeroImageControls({
  draftId,
  hasImage,
  note,
  beforeChange,
  onChanged,
}: {
  draftId: string | null;
  hasImage: boolean;
  /** One line under the buttons saying where the new picture goes. */
  note?: string;
  /** Asked once before anything starts; false cancels (the caller's confirm). */
  beforeChange?: () => boolean;
  /** The draft's picture changed. The caller reloads and, for a Metricool post, syncs. */
  onChanged: (image: { url: string }) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  /** The library photo being copied in, before the draft is changed with it. */
  const [copying, setCopying] = useState<string | null>(null);
  const [status, setStatus] = useState<{ text: string; bad: boolean } | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [images, setImages] = useState<DriveImage[] | null>(null);
  const [loadingLib, setLoadingLib] = useState(false);
  /** The picture as the server has it, for the Edit image panel. */
  const [picture, setPicture] = useState<PictureState | null>(null);
  const scope = 'publishing-img:' + (draftId || 'none');

  // The panel opens pre-filled with the cover's own words and the last notes,
  // which only the draft knows — the preview has a draft id and a URL.
  useEffect(() => {
    if (!draftId) return;
    let live = true;
    fetch('/api/drafts/image?id=' + encodeURIComponent(draftId))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setPicture({ image: j.image ?? null, title: String(j.title || '') }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [draftId]);

  async function send(body: Record<string, unknown>, label: string, fallback: string, opts: { confirmed?: boolean; credits?: number } = {}) {
    if (!draftId) { setStatus({ text: 'This post has no draft behind it, so its picture cannot be changed here.', bad: true }); return; }
    // A credit is asked about only on a draft that has already had a few takes.
    if (opts.credits && !okToSpend(picture?.image, opts.credits)) return;
    if (!opts.confirmed && beforeChange && !beforeChange()) return;
    setBusy(label);
    setStatus(null);
    try {
      const r = await fetch('/api/drafts/image', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chi-progress-scope': scope },
        body: JSON.stringify({ id: draftId, ...body }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.image?.url) throw new Error(friendlyImageError(j, fallback, { provider: 'openai' }));
      setMode(null);
      setPicture((p) => ({ image: j.image, title: p?.title ?? '' }));
      // Saving notes changes nothing the post shows, so nothing is re-sent.
      if (!j.saved) await onChanged(j.image);
      // The server says when the filter ran at its limit, or could not run.
      const notes = Array.isArray(j?.notes) ? j.notes.map(String).filter(Boolean) : [];
      setStatus({ text: (j.saved ? 'Notes saved for the next picture.' : j.retitled ? 'Title updated — same picture, no credits spent.' : 'Picture updated.') + (notes.length ? ' Note: ' + notes.join(' ') + '.' : ''), bad: false });
    } catch (e) {
      setStatus({ text: friendlyImageError(e, fallback, { provider: 'openai' }), bad: true });
    } finally {
      setBusy(null);
    }
  }

  /** The Edit image panel's requests. Saving notes changes no picture, so the caller's confirm is skipped for it. */
  function fromPanel(body: Record<string, unknown>, meta: ImageAction) {
    // okToSpend was already asked by the panel for its own credit button.
    return send(body, meta.label, meta.fallback, { credits: 0, confirmed: meta.label === 'save-notes' });
  }

  function openLibrary(m: Mode) {
    setMode((cur) => (cur === m ? null : m));
    setStatus(null);
    if (images || loadingLib) return;
    setLoadingLib(true);
    fetch('/api/sources?kind=images')
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await r.text().catch(() => '')))))
      .then((j) => setImages(Array.isArray(j?.images) ? j.images : []))
      .catch((e) => setStatus({ text: friendlyError(e, 'The Image Library could not be read just now.'), bad: true }))
      .finally(() => setLoadingLib(false));
  }

  /** Copy the Drive photo into the app's own store first — a network cannot fetch a Drive link. */
  async function pick(img: DriveImage) {
    if (!mode) return;
    if (beforeChange && !beforeChange()) return;
    setBusy(img.id);
    setCopying(img.id);
    setStatus(null);
    let url = '';
    try {
      const r = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-chi-progress-scope': scope },
        body: JSON.stringify({ action: 'import_image', fileId: img.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.url) throw new Error(friendlyError(j, 'That photo could not be copied from the library.'));
      url = String(j.url);
    } catch (e) {
      setStatus({ text: friendlyError(e, 'That photo could not be copied from the library.'), bad: true });
      setBusy(null);
      return;
    } finally {
      setCopying(null);
    }
    if (mode === 'use') await send({ useUrl: url, alt: img.name, libraryFileId: img.id }, img.id, 'That photo could not be attached.', { confirmed: true });
    else await send({ brandPhotoUrl: url, alt: img.name, libraryFileId: img.id }, img.id, 'That photo could not be prepared.', { confirmed: true });
  }

  const chip = 'rounded-full px-3 py-1 text-[12px] font-medium ring-1 transition disabled:opacity-50 ';
  const on = (m: Mode) => (mode === m ? 'bg-accent text-white ring-accent' : 'bg-surface text-ink/70 ring-black/10 hover:bg-black/5');

  return (
    <section className="relative mb-3 rounded-xl bg-canvas p-3 ring-1 ring-black/5" aria-label="Image">
      <PanelLoader scope={scope} rounded="rounded-xl" />
      {/* FREE FIRST: a real photograph, either way, spends nothing. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[12px] font-semibold text-ink">Image</span>
        <button type="button" disabled={Boolean(busy)} onClick={() => openLibrary('use')} className={chip + on('use')} title="A real photo from the team's Drive folder, with the brand's colour filter — no credits">📁 Choose from Image Library</button>
        <button type="button" disabled={Boolean(busy)} onClick={() => openLibrary('brand')} className={chip + on('brand')} title="The library photo itself, with the brand's colour filter and the post title — no AI, no credits">🎨 Use library photo with brand filter</button>
      </div>
      {note && <p className="mt-1.5 text-[11px] text-ink/50">{note}</p>}

      {mode && (
        <div className="mt-2">
          <p className="text-[11px] text-ink/60">
            {mode === 'use' ? 'Click a photo to use it as the picture, with the brand\'s colour filter. Nothing is generated.' : 'Click a photo. It gets the brand\'s colour filter and the post title — no AI.'}
          </p>
          {loadingLib && <p className="mt-1 text-[11px] text-ink/50">Reading the library…</p>}
          {images && images.length === 0 && !loadingLib && <p className="mt-1 text-[11px] text-ink/50">The Drive folder has no photos in it yet.</p>}
          {images && images.length > 0 && (
            <div className="mt-2 grid max-h-52 grid-cols-4 gap-1.5 overflow-y-auto pr-1">
              {images.map((img) => (
                <button key={img.id} type="button" disabled={Boolean(busy) || tooLargeToImport(img.size)} onClick={() => void pick(img)} title={img.name + (sizeLabel(img.size) ? ' · ' + sizeLabel(img.size) : '')} className="overflow-hidden rounded-lg ring-1 ring-black/10 transition hover:ring-accent disabled:opacity-50">
                  {img.thumbUrl
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={img.thumbUrl} alt={img.name} className="h-16 w-full object-cover" />
                    : <span className="block p-2 text-[10px] text-ink/60">{img.name}</span>}
                  <span className="block truncate px-1 py-0.5 text-[9px] text-ink/50">{copying === img.id ? <ImportingLabel verb="Copying" size={img.size} /> : busy === img.id ? 'Working…' : tileNote(img.size) || img.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* THE PANEL, open by default. Keyed by the picture, so a new take starts the fields afresh. */}
      {draftId && (
        <ImageEditPanel
          key={picture?.image?.url || 'none'}
          draftId={draftId}
          image={picture?.image ?? null}
          plannerTitle={picture?.title ?? ''}
          busy={Boolean(busy)}
          onAction={fromPanel}
        />
      )}

      {/* SPENDS A CREDIT: last, and labelled. */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button type="button" disabled={Boolean(busy)} onClick={() => void send({ regenerate: true }, 'ai', 'The new image could not be made.', { credits: 1 })} className={chip + 'bg-surface text-ink/70 ring-black/10 hover:bg-black/5'} title="A fresh AI picture, verified before it replaces this one. It follows the notes above, if any. Spends one image credit.">
          {busy === 'ai' ? 'Making…' : (hasImage ? '↻ New AI image ' : 'Make an AI image ') + creditLabel(1)}
        </button>
      </div>

      {status && <p role="status" className={'mt-2 text-[11px] font-medium ' + (status.bad ? 'text-red-600' : 'text-emerald-700')}>{status.text}</p>}
    </section>
  );
}
