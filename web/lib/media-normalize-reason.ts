// web/lib/media-normalize-reason.ts
// Why Metricool would not take the video — in words, and not the same five
// words for every cause.
//
// THE FAILURE THIS EXISTS TO EXPLAIN. A post with a video is sent in two
// steps: Metricool pulls the file onto its own storage ("normalise"), and then
// the post is created referring to it. When the first step fails, the second
// must not run — Metricool accepts a raw URL with a 200 and silently drops the
// file, so a post that looks sent arrives empty.
//
// That refusal reached the screen as one sentence: "Metricool did not take the
// video, so the post was not created. Try again in a moment; if it keeps
// happening, the video copy needs a look." It covers a file Metricool thinks is
// too large, an expired link, a bad token, a 502 at their end and a transfer
// that ran out of time — five different problems, four of which will never be
// fixed by trying again, and none of which "needs a look" tells anybody how to
// look at.
//
// The status code was already known at the point the message was written, and
// thrown away. This turns it back into a sentence.
//
// Pure: no imports, so the test runner reads this file directly.

export type NormalizeReason =
  /** Metricool answered, and said no. */
  | 'refused'
  /** Metricool's uploader is broken or busy right now. */
  | 'upstream'
  /** Our credentials were not accepted. */
  | 'auth'
  /** Metricool could not fetch our link, or we could not reach Metricool. */
  | 'unreachable'
  /** The transfer was still running when the clock ran out. */
  | 'timeout'
  /** It answered 200 with something this app could not read. */
  | 'unreadable';

export type NormalizeFailure = {
  reason: NormalizeReason;
  /** Metricool's HTTP status, when there was one. */
  status: number | null;
  /** One sentence for a person, naming the cause and what it means. */
  message: string;
};

/** Bytes as a person reads them: "512 MB", "1.8 GB". */
export function readableSize(bytes: number | null | undefined): string {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1).replace(/\.0$/, '') + ' GB';
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

/**
 * What went wrong, from the status Metricool answered with.
 *
 * `error` is set instead when the request never completed — a timeout, a DNS
 * failure, a socket reset. A status and an error are not the same fact and are
 * never merged: "Metricool said no" and "we never heard from Metricool" call
 * for opposite next steps.
 */
export function normalizeFailure(input: {
  status?: number | null;
  error?: string | null;
  /** The size of the file, when this app has measured it. */
  sizeBytes?: number | null;
}): NormalizeFailure {
  const status = Number.isFinite(Number(input.status)) ? Number(input.status) : null;
  const size = readableSize(input.sizeBytes);
  const sized = size ? ' The file is ' + size + '.' : '';

  const err = String(input.error || '');
  if (err) {
    const timedOut = /timed out|timeout|abort/i.test(err);
    return {
      reason: timedOut ? 'timeout' : 'unreachable',
      status: null,
      message: timedOut
        ? 'Metricool was still pulling the video when the transfer ran out of time.' + sized +
          ' A file this size can take minutes to copy across; sending it again often works, and a smaller export always does.'
        : 'Metricool could not be reached while the video was being handed over.' + sized + ' Nothing was posted; try again in a moment.',
    };
  }

  if (status === 401 || status === 403) {
    return {
      reason: 'auth',
      status,
      message: 'Metricool rejected the request as unauthorised (' + status + '). The API token or the brand id is wrong — ' +
        'this will not fix itself by trying again.',
    };
  }
  if (status === 413) {
    return {
      reason: 'refused',
      status,
      message: 'Metricool refused the video as too large (413).' + sized + ' It has to be exported smaller before it can be scheduled.',
    };
  }
  if (status === 415 || status === 422) {
    return {
      reason: 'refused',
      status,
      message: 'Metricool would not accept this file (' + status + ').' + sized +
        ' It reached Metricool but was rejected as the wrong kind of file.',
    };
  }
  if (status === 404) {
    return {
      reason: 'refused',
      status,
      message: 'Metricool answered 404 for the upload — it could not fetch the video from the link it was given.' + sized,
    };
  }
  if (status === 429) {
    return {
      reason: 'upstream',
      status,
      message: 'Metricool is rate-limiting this account (429). Nothing was posted; wait a minute and send again.',
    };
  }
  if (status != null && status >= 500) {
    return {
      reason: 'upstream',
      status,
      message: 'Metricool’s uploader failed (' + status + '). That is at their end, not this post — try again shortly.',
    };
  }
  if (status != null && status >= 400) {
    return {
      reason: 'refused',
      status,
      message: 'Metricool refused the video (' + status + ').' + sized,
    };
  }
  return {
    reason: 'unreadable',
    status,
    message: 'Metricool answered, but not with a reference this app could read, so the video would have been dropped silently.' + sized,
  };
}

/**
 * The whole sentence the person sees, including what OUR OWN link did.
 *
 * Both halves matter and they are different questions. "Metricool said 403" and
 * "our media link is fine, 512 MB, a real MP4" together say where to look; the
 * first alone had somebody checking the video copy that was never the problem.
 */
export function mediaHandoverMessage(failure: NormalizeFailure, linkNote?: string | null): string {
  const note = String(linkNote || '').trim();
  return note ? failure.message + ' ' + note : failure.message;
}

/** What this app found when it fetched its own media link, in one clause. */
export function ourLinkNote(probe: { ok: boolean; message?: string; bytes?: number | null } | null | undefined): string {
  if (!probe) return '';
  const size = readableSize(probe.bytes);
  if (probe.ok) return 'The video link this app handed over is fine' + (size ? ' (' + size + ')' : '') + ', so the file itself is not the problem.';
  return 'The video link this app handed over did not answer either: ' + String(probe.message || 'it could not be fetched') + '.';
}
