// web/lib/media-route.ts
// How a video gets its audio out: staged on disk, or read where it lives.
//
// The pipeline has always written the whole video to the function's scratch
// disk and let ffmpeg lift the audio out of the file. That is why the size
// ceiling existed, and why it sat at 450 MB: Vercel gives the function a 512 MB
// /tmp, and the video had to fit in it.
//
// It is worth being precise about what that ceiling was NOT. It was never about
// the transcriber — the mp3 that reaches OpenAI is a couple of megabytes
// whatever the source weighs — and never about function memory, since
// extractAudio has streamed to disk rather than buffering since it was written.
// It was a scratch-disk limit and nothing else, so "that video is 1722 MB, past
// the 450 MB the dashboard can pull down in one go" was describing a staging
// step the audio never needed.
//
// ffmpeg can read the file over HTTP instead, with range requests, and write
// only the mp3. Then nothing but the audio ever touches disk and the ceiling
// stops existing.
//
// Both paths are kept. The disk path is the proven one and handles every video
// the clinic normally posts (76-283 MB), so it kept its behaviour exactly; the
// URL path takes over above that, where the alternative today is a refusal.
// A new path that only ever runs where the old one could not run at all cannot
// regress anything.
//
// No imports: the test runner strips types and runs this file directly.

/**
 * The largest video worth staging on disk.
 *
 * 450 MB inside a 512 MB /tmp — the margin covers the mp3 written alongside it
 * and anything else sharing the scratch directory.
 */
export const DISK_SAFE_BYTES = 450 * 1024 * 1024;

/**
 * The point past which a file is refused outright.
 *
 * Not a disk limit — the URL path has none — but a TIME one. ffmpeg has to read
 * the container through to the end of the audio it wants, so the bytes still
 * cross the network inside the request's budget. Somewhere past a few gigabytes
 * that stops being plausible on any connection, and a refusal naming the size
 * is worth more than a timeout that says nothing.
 *
 * Deliberately far above anything a reel can be. It exists to give the honest
 * message, not to gatekeep.
 */
export const ABSOLUTE_MAX_BYTES = 5 * 1024 * 1024 * 1024;

export type MediaRoute =
  /** Stage it on the scratch disk, then extract. The original path. */
  | 'disk'
  /** Let ffmpeg read it over HTTP; only the audio is written. */
  | 'stream'
  /** Too big to read inside one request, whatever the method. */
  | 'too_large';

/**
 * Which path should this file take?
 *
 * An UNKNOWN size routes to 'disk'. Drive omits `size` for shortcuts and a few
 * other file kinds, and the disk path already refuses mid-download if the bytes
 * turn out to overrun the cap — so an unknown size keeps the guarded behaviour
 * rather than being handed to the path with no ceiling.
 */
export function routeFor(
  sizeBytes: number | null,
  diskSafe = DISK_SAFE_BYTES,
  absoluteMax = ABSOLUTE_MAX_BYTES,
): MediaRoute {
  if (sizeBytes === null || !Number.isFinite(sizeBytes)) return 'disk';
  if (sizeBytes > absoluteMax) return 'too_large';
  return sizeBytes > diskSafe ? 'stream' : 'disk';
}

/** How big, in the units a person reads. */
export function megabytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return 'that video';
  return (bytes / 1024 / 1024).toFixed(0) + ' MB';
}
