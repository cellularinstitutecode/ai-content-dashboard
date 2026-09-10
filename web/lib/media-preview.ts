// web/lib/media-preview.ts
// A URL that PLAYS the attached video, as opposed to one that downloads it.
//
// The composer said "This video will be attached to the post." and showed a
// film-strip glyph. That is a claim, not evidence — there was no way to tell a
// correctly attached video from a blank string with a label next to it, and the
// honest reaction to it was the one we got: "I still don't see it."
//
// The stored media URL is Drive's webContentLink (`uc?export=download&id=…`).
// It is the right thing to hand Metricool and the wrong thing to put in a
// <video> tag: Drive answers it with Content-Disposition: attachment, so the
// element renders an empty black box. Drive's /preview page is the one that
// plays, and because the copy is shared with anyone-with-the-link it plays for
// anyone who can see the dashboard.
//
// Pure, so the mapping is unit-tested without a browser.

import { parseDriveFileId } from './drive-url.ts';

/**
 * An embeddable player for this attachment, or '' when there is nothing to embed.
 *
 * Empty is a real answer — an Opus clip is a direct .mp4 that a <video> tag
 * plays on its own, and a still image is not a video at all. The caller picks
 * the element; this only answers "is there a Drive player, and where".
 */
export function drivePreviewUrl(mediaUrl: string | null | undefined): string {
  const id = parseDriveFileId(String(mediaUrl || ''));
  return id ? 'https://drive.google.com/file/d/' + id + '/preview' : '';
}

/** Is this attachment a still image rather than a video? Label first, then the URL. */
export function looksLikeImage(url: string | null | undefined, label?: string | null): boolean {
  if (/image|photo|foto|thumbnail|portada/i.test(String(label || ''))) return true;
  return /\.(png|jpe?g|webp|gif|avif)(\?|$)/i.test(String(url || ''));
}

/** How to show this attachment: a Drive player, a plain video element, or a picture. */
export function previewKindOf(url: string | null | undefined, label?: string | null): 'image' | 'drive' | 'video' | 'none' {
  const u = String(url || '').trim();
  if (!u) return 'none';
  if (looksLikeImage(u, label)) return 'image';
  if (drivePreviewUrl(u)) return 'drive';
  return 'video';
}
