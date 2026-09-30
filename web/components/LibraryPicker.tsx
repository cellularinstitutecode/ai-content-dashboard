'use client';

// components/LibraryPicker.tsx
// "Pick image from library": the team's Drive photographs in a grid, one
// click to make one the post's picture — copied into the app's own store
// (a network cannot fetch a Drive link), given the brand's colour filter and,
// for a planner post, the post's title (lib/library-hero.ts). No image model,
// no credits. Used by the Autopilot card and the strategy preview; the
// Publishing list's controls (HeroImageControls) have the same grid.

import { useState } from 'react';
import { friendlyError, friendlyImageError } from '@/lib/friendly-error';
import ImportingLabel from '@/components/ImportingLabel';
import { sizeLabel, tileNote, tooLargeToImport } from '@/lib/library-import';

type DriveImage = { id: string; name: string; thumbUrl?: string; viewUrl?: string; size?: number | null };

export default function LibraryPicker({ draftId, title, scope, onChanged, onClose }: {
  draftId: string;
  /** Put the post's title on the photograph (planner covers) or leave it clean. */
  title?: boolean;
  /** The progress scope of the panel this sits in. */
  scope?: string;
  onChanged: (image: { url: string; alt?: string | null }, notes: string[]) => void | Promise<void>;
  onClose?: () => void;
}) {
  const [images, setImages] = useState<DriveImage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [copying, setCopying] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (images === null && !loading) {
    setLoading(true);
    fetch('/api/sources?kind=images')
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await r.text().catch(() => '')))))
      .then((j) => setImages(Array.isArray(j?.images) ? j.images : []))
      .catch((e) => { setErr(friendlyError(e, 'The Image Library could not be read just now.')); setImages([]); })
      .finally(() => setLoading(false));
  }

  async function pick(img: DriveImage) {
    setBusy(img.id); setErr(null);
    const headers = { 'content-type': 'application/json', ...(scope ? { 'x-chi-progress-scope': scope } : {}) };
    let url = '';
    try {
      setCopying(img.id);
      const r = await fetch('/api/sources', { method: 'POST', headers, body: JSON.stringify({ action: 'import_image', fileId: img.id }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.url) throw new Error(friendlyError(j, 'That photo could not be copied from the library.'));
      url = String(j.url);
    } catch (e) {
      setErr(friendlyError(e, 'That photo could not be copied from the library.'));
      setBusy(null); setCopying(null);
      return;
    }
    setCopying(null);
    try {
      const body = title ? { id: draftId, brandPhotoUrl: url, alt: img.name, libraryFileId: img.id } : { id: draftId, useUrl: url, alt: img.name, libraryFileId: img.id };
      const r = await fetch('/api/drafts/image', { method: 'POST', headers, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.image?.url) throw new Error(friendlyImageError(j, 'That photo could not be attached.', { provider: 'openai' }));
      await onChanged(j.image, Array.isArray(j?.notes) ? j.notes.map(String) : []);
      onClose?.();
    } catch (e) {
      setErr(friendlyImageError(e, 'That photo could not be attached.', { provider: 'openai' }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 rounded-xl bg-white p-2 ring-1 ring-black/10">
      <div className="flex items-center gap-2 px-1">
        <p className="text-[11px] text-ink/60">Click a photo. It gets the brand&rsquo;s colour filter{title ? ' and the post title' : ''} &mdash; no AI, no credits.</p>
        <span className="flex-1" />
        {onClose && <button type="button" onClick={onClose} className="rounded-full px-2 py-0.5 text-[11px] text-ink/60 ring-1 ring-black/10 hover:bg-black/5">Close</button>}
      </div>
      {loading && <p className="mt-1 px-1 text-[11px] text-ink/50">Reading the library&hellip;</p>}
      {images && images.length === 0 && !loading && !err && <p className="mt-1 px-1 text-[11px] text-ink/50">The Drive folder has no photos in it yet.</p>}
      {images && images.length > 0 && (
        <div className="mt-2 grid max-h-64 grid-cols-4 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-6">
          {images.map((img) => (
            <button key={img.id} type="button" disabled={Boolean(busy) || tooLargeToImport(img.size)} onClick={() => void pick(img)} title={img.name + (sizeLabel(img.size) ? ' · ' + sizeLabel(img.size) : '')} className="overflow-hidden rounded-lg ring-1 ring-black/10 transition hover:ring-accent disabled:opacity-50">
              {img.thumbUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={img.thumbUrl} alt={img.name} loading="lazy" className="h-16 w-full object-cover" />
                : <span className="block p-2 text-[10px] text-ink/60">{img.name}</span>}
              <span className="block truncate px-1 py-0.5 text-[9px] text-ink/50">{copying === img.id ? <ImportingLabel verb="Copying" size={img.size} /> : busy === img.id ? 'Working…' : tileNote(img.size) || img.name}</span>
            </button>
          ))}
        </div>
      )}
      {err && <p role="alert" className="mt-2 px-1 text-[11px] font-medium text-red-600">{err}</p>}
    </div>
  );
}
