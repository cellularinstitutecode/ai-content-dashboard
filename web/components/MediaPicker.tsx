'use client';

// Attach a video (or show the image already attached) to a post being written
// by hand — in the dashboard composer and in the Calendar page's scheduler.
//
// Why it is a component and not markup in the composer: the Calendar page had
// the same four channel chips and NO way to attach media at all, so a video
// channel there could only ever produce a draft Metricool refuses. Both pages
// now mount this, so "what can I attach?" has one answer and one look.
//
// What it lists is deliberately narrow: videos that ALREADY have a public
// Drive copy (/api/media). Browsing must never create a world-readable copy of
// the clinic's footage — pressing Prepare on a row in the Video Library is the
// one action that does that, and this picker cannot.

import { useEffect, useState } from 'react';
import { friendlyErrorFromResponse } from '@/lib/friendly-error';

export type ShareableVideo = { videoId: string; title: string; url: string; source: string; updatedAt: string };

/** Videos with a shareable copy. Exported so callers can match a row against it. */
export async function fetchShareableVideos(): Promise<{ videos: ShareableVideo[]; error: string | null }> {
  try {
    const r = await fetch('/api/media', { cache: 'no-store' });
    if (!r.ok) return { videos: [], error: await friendlyErrorFromResponse(r, 'We could not read your video library.') };
    const j = await r.json();
    // `failed` is the library saying it could not READ, which is not the same
    // as having nothing — an empty picker must not stand in for an outage.
    if (j && j.failed) return { videos: [], error: 'Your video library could not be read just now. Try again in a moment.' };
    return { videos: Array.isArray(j?.videos) ? (j.videos as ShareableVideo[]) : [], error: null };
  } catch {
    return { videos: [], error: 'We could not reach the video library just now.' };
  }
}

/** Is this attachment a still image rather than a video? Label first, then the URL. */
export function looksLikeImage(url: string, label: string): boolean {
  return /image|photo|foto/i.test(label) || /\.(png|jpe?g|webp|gif)(\?|$)/i.test(url);
}

export default function MediaPicker({ value, label, onChange, hint }: {
  /** The media URL currently attached, or '' for none. */
  value: string;
  /** What to call it on screen. */
  label: string;
  onChange: (url: string, label: string) => void;
  /** An extra line under the button — e.g. which channels are waiting on this. */
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [videos, setVideos] = useState<ShareableVideo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Loaded when the list is opened, not on mount: most posts carry no video,
  // and a picker that never opens should cost nothing.
  useEffect(() => {
    if (!open || videos || loading) return;
    let alive = true;
    setLoading(true);
    void fetchShareableVideos().then((out) => {
      if (!alive) return;
      setVideos(out.videos);
      setErr(out.error);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [open, videos, loading]);

  if (value) {
    const isImage = looksLikeImage(value, label);
    return (
      <div className="mt-2 flex items-center justify-between gap-2 rounded-2xl bg-subtle p-2.5 ring-1 ring-line">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">{isImage ? '\u{1F5BC}' : '\u{1F3AC}'}</span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium text-ink">{label || (isImage ? 'Image attached' : 'Video attached')}</div>
            <div className="text-[11px] text-ink-faint">{isImage ? 'This image will be attached to the post.' : 'This video will be attached to the post.'}</div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => { onChange('', ''); setOpen(false); }}
          className="shrink-0 rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-white"
        >Remove</button>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1.5 text-[13px] font-medium text-ink ring-1 ring-line transition hover:ring-accent"
      >
        <span aria-hidden>{'\u{1F3AC}'}</span>{open ? 'Close' : 'Attach a video'}
      </button>
      {hint && <p className="mt-1.5 text-[11px] text-ink-faint">{hint}</p>}
      {open && (
        <div className="mt-2 rounded-2xl bg-subtle p-2.5 ring-1 ring-line">
          {loading && <p className="px-1 py-2 text-[12px] text-ink-muted">Reading your video library…</p>}
          {err && <p role="alert" className="px-1 py-2 text-[12px] font-medium text-danger">{err}</p>}
          {!loading && !err && videos && videos.length === 0 && (
            // The empty state has to name the action that fills it, or it reads
            // as "this feature is broken" rather than "nothing is ready yet".
            <p className="px-1 py-2 text-[12px] text-ink-muted">
              No videos are ready to attach yet. Press <strong>Prepare</strong> on a row in the Video Library — that is what makes the shareable copy a network can fetch.
            </p>
          )}
          {!loading && !err && videos && videos.length > 0 && (
            <ul className="grid max-h-64 gap-1 overflow-y-auto">
              {videos.map((v) => (
                <li key={v.videoId}>
                  <button
                    type="button"
                    onClick={() => { onChange(v.url, v.title); setOpen(false); }}
                    className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition hover:bg-white"
                  >
                    <span aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">{'\u{1F3AC}'}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-medium text-ink">{v.title}</span>
                      <span className="block text-[11px] text-ink-faint">{v.source === 'youtube' ? 'From YouTube' : 'From Drive'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
