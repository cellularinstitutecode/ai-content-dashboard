'use client';

// components/LibraryImagePicker.tsx
// "Attach an image": the team's Drive photographs in a grid, one click to
// hand back a URL a network can fetch.
//
// LibraryPicker does the same grid for a DRAFT — it copies the photo and
// then attaches it to a draft row through /api/drafts/image, with the brand
// filter and the post's title. The composer and the Calendar scheduler have
// no draft: they hold one media URL in state, exactly as the video picker
// does. So this copies the photo into the app's own public bucket (a network
// cannot fetch a Drive link) and returns that address, nothing more.

import { useState } from 'react';
import { friendlyError } from '@/lib/friendly-error';
import ImportingLabel from '@/components/ImportingLabel';
import { sizeLabel, tileNote, tooLargeToImport } from '@/lib/library-import';

export type LibraryImage = { id: string; name: string; thumbUrl?: string; viewUrl?: string; size?: number | null };

/** The Drive image folder. Exported so a caller can match a row against it. */
export async function fetchLibraryImages(): Promise<{ images: LibraryImage[]; error: string | null }> {
  try {
    const r = await fetch('/api/sources?kind=images', { cache: 'no-store' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      return { images: [], error: friendlyError(j, 'The Image Library could not be read just now.') };
    }
    const j = await r.json();
    return { images: Array.isArray(j?.images) ? (j.images as LibraryImage[]) : [], error: null };
  } catch {
    return { images: [], error: 'We could not reach the Image Library just now.' };
  }
}

/**
 * Copy one library photo into the app's public store and return its address.
 * The same call the draft picker makes; the draft step is the caller's, if any.
 */
export async function importLibraryImage(fileId: string): Promise<{ url: string; error: string | null }> {
  try {
    const r = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'import_image', fileId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.url) return { url: '', error: friendlyError(j, 'That photo could not be copied from the library.') };
    return { url: String(j.url), error: null };
  } catch {
    return { url: '', error: 'We could not reach the Image Library just now.' };
  }
}

export default function LibraryImagePicker({ onPick, onClose }: {
  /** The public URL of the copied photo, and the photo's name for the label. */
  onPick: (url: string, name: string) => void;
  onClose?: () => void;
}) {
  const [images, setImages] = useState<LibraryImage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function load() {
    setLoading(true);
    setErr(null);
    void fetchLibraryImages().then((out) => {
      setImages(out.images);
      setErr(out.error);
      setLoading(false);
    });
  }
  if (images === null && !loading && !err) load();

  async function pick(img: LibraryImage) {
    setBusy(img.id);
    setErr(null);
    const out = await importLibraryImage(img.id);
    setBusy(null);
    if (out.error) { setErr(out.error); return; }
    onPick(out.url, img.name);
    onClose?.();
  }

  return (
    <div className="mt-2 rounded-2xl bg-subtle p-2.5 ring-1 ring-line">
      <div className="flex items-center gap-2 px-1">
        <p className="text-[11px] text-ink-faint">Click a photo from the Image Library. It is copied as it is &mdash; no AI, no credits.</p>
        <span className="flex-1" />
        {onClose && <button type="button" onClick={onClose} className="rounded-full bg-white px-2.5 py-1 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:ring-accent">Close</button>}
      </div>
      {loading && <p className="px-1 py-2 text-[12px] text-ink-muted">Reading the Image Library…</p>}
      {err && (
        <div role="alert" className="px-1 py-2 text-[12px]">
          <p className="font-medium text-danger">{err}</p>
          <button type="button" onClick={() => { setImages(null); load(); }} className="mt-1.5 rounded-full bg-white px-3 py-1 text-[12px] font-medium text-ink ring-1 ring-line transition hover:ring-accent">Try again</button>
        </div>
      )}
      {!loading && !err && images && images.length === 0 && (
        <p className="px-1 py-2 text-[12px] text-ink-muted">The Image Library has no photos in it yet. Add some to the Drive folder and they appear here.</p>
      )}
      {!loading && images && images.length > 0 && (
        <div className="mt-2 grid max-h-[420px] grid-cols-3 gap-1.5 overflow-y-auto pr-1 sm:grid-cols-4">
          {images.map((img) => (
            <button
              key={img.id}
              type="button"
              disabled={Boolean(busy) || tooLargeToImport(img.size)}
              onClick={() => void pick(img)}
              title={img.name + (sizeLabel(img.size) ? ' · ' + sizeLabel(img.size) : '')}
              className="overflow-hidden rounded-xl bg-white ring-1 ring-line transition hover:ring-accent disabled:opacity-50"
            >
              {img.thumbUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={img.thumbUrl} alt={img.name} loading="lazy" className="aspect-square w-full object-cover" />
                : <span className="block p-2 text-[10px] text-ink-muted">{img.name}</span>}
              <span className="block truncate px-1 py-0.5 text-[10px] text-ink-faint">
                {busy === img.id ? <ImportingLabel verb="Copying" size={img.size} /> : tileNote(img.size) || img.name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
