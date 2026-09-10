'use client';

// The attachment panel: what is going out with this post, shown as itself.
//
// It used to be a film-strip emoji and the sentence "This video will be
// attached to the post." That is a claim, not evidence — a correctly attached
// video and an empty string with a label beside it looked identical, and the
// honest reaction to that was the one we got: "I still don't see it."
//
// So the attached state is now the video, playing, at the size of a phone
// screen. If you can watch it here, it is attached. If the box is empty, it is
// not. Nothing about the post's media is left to a caption any more.
//
// Mounted in the dashboard composer AND the Calendar scheduler, which had no
// media control at all — so a video channel there could only ever produce a
// draft Metricool refuses.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { friendlyErrorFromResponse } from '@/lib/friendly-error';
import { drivePreviewUrl, previewKindOf } from '@/lib/media-preview';

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

/**
 * Make one video attachable and return the URL a post can carry.
 *
 * The Drive original is private, so a network handed that link gets a
 * permission wall. This asks the server for the world-readable copy, making it
 * if there is none. Exported so the Video Library's "Use in post" can use the
 * same one call rather than growing its own.
 */
export async function ensureVideoAttachable(videoLink: string, title?: string): Promise<{ url: string; error: string | null }> {
  try {
    const r = await fetch('/api/media', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoLink, title: title || '' }),
    });
    if (!r.ok) return { url: '', error: await friendlyErrorFromResponse(r, 'We could not prepare that video for posting.') };
    const j = await r.json();
    return { url: String(j?.url || ''), error: null };
  } catch {
    return { url: '', error: 'We could not reach the video library just now.' };
  }
}

/**
 * The attachment, rendered as the thing it is.
 *
 * Three cases, because one element does not cover them: a Drive video needs
 * Drive's iframe player (its download URL in a <video> tag is a black box — see
 * lib/media-preview.ts), an Opus clip is a direct file a <video> tag plays, and
 * an image is an image.
 */
export function MediaPreview({ url, label, tall }: { url: string; label?: string; tall?: boolean }) {
  const kind = previewKindOf(url, label);
  const frame = 'w-full overflow-hidden rounded-xl bg-black ' + (tall ? 'aspect-[9/16] max-h-[420px]' : 'aspect-video');
  if (kind === 'drive') {
    return (
      <div className={frame}>
        <iframe
          src={drivePreviewUrl(url)}
          title={label || 'Attached video'}
          allow="autoplay"
          className="h-full w-full border-0"
        />
      </div>
    );
  }
  if (kind === 'video') {
    return (
      <div className={frame}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video src={url} controls preload="metadata" className="h-full w-full object-contain" />
      </div>
    );
  }
  if (kind === 'image') {
    return (
      <div className={frame}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={label || 'Attached image'} className="h-full w-full object-contain" />
      </div>
    );
  }
  return null;
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
  //
  // The guard is a ref, and there is no cancel-on-cleanup, because the obvious
  // version of this deadlocks: with `loading` in the dependency array, setting
  // it to true re-runs the effect, whose CLEANUP then cancels the fetch that
  // the first run had just started. The request completes, its `.then` sees a
  // cancelled flag and returns, and the panel reads "Reading your video
  // library…" forever. A ref survives the re-render without being a dependency,
  // and a state update after unmount is a no-op in React 18+, so nothing needs
  // cancelling.
  const started = useRef(false);
  function load() {
    started.current = true;
    setLoading(true);
    void fetchShareableVideos().then((out) => {
      setVideos(out.videos);
      setErr(out.error);
      setLoading(false);
    });
  }
  useEffect(() => {
    if (!open || started.current) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** Try again after a failure — the one case where a second fetch is right. */
  function retry() {
    setVideos(null);
    setErr(null);
    setOpen(true);
    load();
  }

  if (value) {
    const isImage = previewKindOf(value, label) === 'image';
    return (
      <div className="mt-2 rounded-2xl bg-subtle p-2.5 ring-1 ring-line">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden className="text-[13px]">{isImage ? '\u{1F5BC}' : '✅'}</span>
            <span className="truncate text-[13px] font-semibold text-ink">
              {isImage ? 'Image attached' : 'Video attached'}
              {label ? <span className="font-normal text-ink-muted"> · {label}</span> : null}
            </span>
          </div>
          <button
            type="button"
            onClick={() => { onChange('', ''); setOpen(false); }}
            className="shrink-0 rounded-full bg-white px-2.5 py-1 text-[12px] font-medium text-ink-muted ring-1 ring-line transition hover:ring-accent"
          >Remove</button>
        </div>
        {/* The proof. Everything above this line is a label; this is the file. */}
        <MediaPreview url={value} label={label} />
        <p className="mt-2 text-[11px] text-ink-faint">
          This is exactly what goes out with the post. If it plays here, it is attached.
        </p>
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
          {err && (
            <div role="alert" className="px-1 py-2 text-[12px]">
              <p className="font-medium text-danger">{err}</p>
              <button type="button" onClick={retry} className="mt-1.5 rounded-full bg-white px-3 py-1 text-[12px] font-medium text-ink ring-1 ring-line transition hover:ring-accent">Try again</button>
            </div>
          )}
          {!loading && !err && videos && videos.length === 0 && (
            // The empty state has to name the action that fills it, or it reads
            // as "this feature is broken" rather than "nothing is ready yet".
            <div className="px-1 py-2 text-[12px] text-ink-muted">
              <p>No videos are ready to attach yet. In the Video Library, press <strong>Use in post · with video</strong> on a row — that makes the shareable copy a network can fetch, and brings the video straight here.</p>
              <Link href="/sources/videos" className="mt-1.5 inline-flex rounded-full bg-white px-3 py-1 font-medium text-ink no-underline ring-1 ring-line transition hover:ring-accent">Open the Video Library ↗</Link>
            </div>
          )}
          {!loading && !err && videos && videos.length > 0 && (
            <ul className="grid max-h-[420px] gap-2 overflow-y-auto">
              {videos.map((v) => (
                <li key={v.videoId}>
                  <button
                    type="button"
                    onClick={() => { onChange(v.url, v.title); setOpen(false); }}
                    className="w-full rounded-xl p-1.5 text-left ring-1 ring-transparent transition hover:bg-white hover:ring-line"
                  >
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">{'\u{1F3AC}'}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-ink">{v.title}</span>
                        <span className="block text-[11px] text-ink-faint">{v.source === 'youtube' ? 'From YouTube' : 'From Drive'} · click to attach</span>
                      </span>
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
