'use client';

// components/HeroImagePicker.tsx
// Where the picture comes from — the clinic's own library, a file dropped on
// the panel, or a generated one with a direction somebody actually wrote.
//
// "Honestly the photos look too AI… this is information that will be posted,
//  we're promoting. If we could put a drop box like if we were talking to GPT,
//  dropping pictures, but it takes it from our library and it creates a prompt
//  around the post, that would be the most accurate way to do it."
//
// Until now there was one control — "New image" — which rolled the next
// composition variant and hoped. The prompt was built entirely from the post
// and a rotating style list, and nothing on the screen could say "this one, or
// something like this". So:
//
//   Our library   a real photograph from the team's Drive folder, used as it
//                 is. Nothing generated, nothing that looks generated.
//   Drop a file   the photo on your desk, downscaled in the browser and stored
//                 beside the generated ones.
//   Describe it   the prompt, prefilled from the post and yours to edit.
import { useEffect, useMemo, useRef, useState } from 'react';

import { friendlyError } from '@/lib/friendly-error';

type DriveImage = { id: string; name: string; thumbUrl?: string; viewUrl?: string };
type Tab = 'library' | 'upload' | 'prompt';

/** The longest edge we upload. Bigger than any feed shows, small enough to send. */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.86;

/**
 * Shrink a picture in the browser before it is sent.
 *
 * A phone photograph is 4-12 MB and the request body has a ceiling well under
 * that, so without this the drop box would refuse exactly the pictures somebody
 * most wants to use — the ones taken at the clinic that morning.
 */
async function downscale(file: File): Promise<string> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
  // A GIF may be animated, and drawing it to a canvas would keep one frame.
  if (/^data:image\/gif/i.test(dataUrl)) return dataUrl;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('That file is not an image this browser can read.'));
    el.src = dataUrl;
  });
  const longest = Math.max(img.width, img.height);
  if (longest <= MAX_EDGE && dataUrl.length < 6_000_000) return dataUrl;
  const scale = Math.min(1, MAX_EDGE / longest);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

export default function HeroImagePicker({
  draftId,
  topic,
  currentPrompt,
  onPicked,
}: {
  draftId: string | null;
  /** What the post is about, so the prompt box starts from something real. */
  topic: string;
  currentPrompt?: string | null;
  onPicked: (image: { url: string; alt?: string; model?: string; verification?: unknown }) => void;
}) {
  const [tab, setTab] = useState<Tab>('library');
  const [images, setImages] = useState<DriveImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const defaultPrompt = useMemo(
    () => currentPrompt?.trim() || 'A real treatment room at the clinic, photographed as it is: ' + topic,
    [currentPrompt, topic],
  );
  useEffect(() => { setPrompt(defaultPrompt); }, [defaultPrompt]);

  // The team's Drive folder, read once when the library tab is first opened.
  useEffect(() => {
    if (tab !== 'library' || images.length || loading) return;
    setLoading(true);
    fetch('/api/sources?kind=images')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setImages(Array.isArray(j?.images) ? j.images : []))
      .catch(() => setStatus('The image library could not be read just now.'))
      .finally(() => setLoading(false));
  }, [tab, images.length, loading]);

  async function send(body: Record<string, unknown>, label: string) {
    if (!draftId) { setStatus('Save the draft first — there is nothing to attach the picture to yet.'); return; }
    setBusy(label);
    setStatus(null);
    try {
      const r = await fetch('/api/drafts/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: draftId, ...body }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.image?.url) throw new Error(friendlyError(j, 'That picture could not be attached.'));
      onPicked(j.image);
      setStatus(null);
    } catch (e) {
      setStatus(friendlyError(e, 'That picture could not be attached.'));
    } finally {
      setBusy('');
    }
  }

  /** A Drive photo, copied into the dashboard's own store so a network can fetch it. */
  async function useFromLibrary(img: DriveImage) {
    setBusy(img.id);
    setStatus(null);
    try {
      const r = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'import_image', fileId: img.id }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.url) throw new Error(friendlyError(j, 'That photo could not be copied.'));
      await send({ useUrl: String(j.url), alt: img.name }, img.id);
    } catch (e) {
      setStatus(friendlyError(e, 'That photo could not be copied.'));
      setBusy('');
    }
  }

  async function takeFile(file: File | null | undefined) {
    if (!file) return;
    setBusy('upload');
    setStatus(null);
    try {
      const dataUrl = await downscale(file);
      await send({ dataUrl, alt: file.name }, 'upload');
    } catch (e) {
      setStatus(friendlyError(e, 'That file could not be used.'));
      setBusy('');
    }
  }

  const tabStyle = (t: Tab) =>
    'rounded-full px-3 py-1 text-[12px] font-medium ring-1 transition ' +
    (tab === t ? 'bg-accent text-white ring-accent' : 'bg-subtle text-ink-muted ring-line hover:ring-accent');

  return (
    <section className="mt-3 rounded-2xl border border-line bg-white p-4" aria-label="Choose the picture">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-semibold text-ink">The picture</span>
        <button type="button" className={tabStyle('library')} onClick={() => setTab('library')}>📁 Our library</button>
        <button type="button" className={tabStyle('upload')} onClick={() => setTab('upload')}>⬆ Drop a file</button>
        <button type="button" className={tabStyle('prompt')} onClick={() => setTab('prompt')}>✏️ Describe it</button>
      </div>

      {tab === 'library' && (
        <div className="mt-3">
          <p className="text-[12px] text-ink-muted">
            Real photographs from the team&rsquo;s Drive folder. Nothing is generated — which is the whole point when the post is a
            clinical one.
          </p>
          {loading && <p className="mt-2 text-[12px] text-ink-faint">Reading the library…</p>}
          <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {images.slice(0, 20).map((img) => (
              <button
                key={img.id}
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void useFromLibrary(img)}
                title={img.name}
                className="group overflow-hidden rounded-xl ring-1 ring-line transition hover:ring-accent disabled:opacity-50"
              >
                {img.thumbUrl
                  ? <img src={img.thumbUrl} alt={img.name} className="h-20 w-full object-cover" />
                  : <span className="block p-3 text-[11px] text-ink-muted">{img.name}</span>}
                <span className="block truncate px-1.5 py-1 text-[10px] text-ink-faint">{busy === img.id ? 'Attaching…' : img.name}</span>
              </button>
            ))}
          </div>
          {!loading && !images.length && <p className="mt-2 text-[12px] text-ink-muted">The Drive folder has no photographs in it yet.</p>}
        </div>
      )}

      {tab === 'upload' && (
        <div
          className={'mt-3 rounded-2xl border-2 border-dashed p-6 text-center transition ' + (dragging ? 'border-accent bg-accent/5' : 'border-line')}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); void takeFile(e.dataTransfer.files?.[0]); }}
        >
          <p className="text-[13px] font-medium text-ink">Drop a photograph here</p>
          <p className="mt-1 text-[12px] text-ink-muted">Or <button type="button" className="font-semibold text-accent underline" onClick={() => fileRef.current?.click()}>choose a file</button>. JPEG, PNG or WebP; it is resized here before it is sent.</p>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void takeFile(e.target.files?.[0])} />
          {busy === 'upload' && <p className="mt-2 text-[12px] text-ink-faint">Attaching…</p>}
        </div>
      )}

      {tab === 'prompt' && (
        <div className="mt-3">
          <label htmlFor="hero-prompt" className="text-[12px] font-medium text-ink-muted">What should the picture be?</label>
          <textarea
            id="hero-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="mt-1 w-full resize-none rounded-2xl bg-subtle p-3 text-[13px] text-ink ring-1 ring-line focus:ring-accent"
          />
          <p className="mt-1 text-[11px] text-ink-faint">
            Written from the post, and yours to change. The brand&rsquo;s palette and the no-text rule are added on top, so an image
            with writing in it is still refused.
          </p>
          <button
            type="button"
            disabled={busy === 'prompt' || !prompt.trim()}
            onClick={() => void send({ prompt, regenerate: true }, 'prompt')}
            className="mt-2 rounded-full bg-accent px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-accent-hover disabled:opacity-40"
          >{busy === 'prompt' ? 'Making it…' : 'Make this picture'}</button>
        </div>
      )}

      {status && <p className="mt-2 text-[12px] font-medium text-danger" role="status">{status}</p>}
    </section>
  );
}
