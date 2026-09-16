// web/lib/http-range.ts
// The Range header, forwarded or dropped — nothing in between.
//
// The media route does not compute byte offsets. It hands the client's Range
// straight to Drive, which honours it on ?alt=media and answers 206 with its
// own Content-Range, and passes that back. That leaves exactly one decision
// here: is this header safe to forward?
//
// A multi-range request is the one that is not. Drive would answer it with
// multipart/byteranges, and this route copies Drive's content-type through
// verbatim — so the caller would get a MIME multipart body labelled as such
// where it asked for a video. Dropping the header yields a plain 200 with the
// whole file, which is always a correct answer to a Range request.
//
// Pure: no imports, so the test runner reads this file directly.

/** A single byte range: `bytes=0-15`, `bytes=1000-`, or the suffix form `bytes=-500`. */
const ONE_RANGE = /^bytes=(?:\d+-\d*|-\d+)$/;

/**
 * The Range header to send upstream, or null to send none.
 *
 * Whitespace is tolerated and normalised away, because `bytes = 0 - 15` is
 * legal enough that somebody's client will send it and illegal enough that
 * Drive would refuse it.
 */
export function forwardableRange(header: string | null | undefined): string | null {
  const raw = String(header || '');
  // A header long enough to be an attack is not a header worth parsing.
  if (!raw || raw.length > 128) return null;
  const tidy = raw.replace(/\s+/g, '').toLowerCase();
  if (!ONE_RANGE.test(tidy)) return null;
  // `bytes=-0` asks for the last zero bytes: unsatisfiable, and Drive answers
  // 416 to it. Dropping it serves the file instead of failing the post.
  if (tidy === 'bytes=-0') return null;
  return tidy;
}
