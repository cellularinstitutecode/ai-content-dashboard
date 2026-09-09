// One Prepare call, from the browser, including the second pass.
//
// Shared because there are now two ways to press it — the button on a row and
// the batch across many — and they must behave identically. A long video does
// not fit in one 60-second request: the server stops once the transcript is
// stored and answers 202 'transcript_ready', and the caller asks again. Having
// that written twice would mean one of the copies eventually drifting, and the
// bug would look like "batch prepare works differently".
import { friendlyErrorFromResponse } from '@/lib/friendly-error';

/** What to tell a person when the platform kills a request outright. */
export const TIMEOUT_HINT =
  'Press Prepare again — the transcript is kept, so the second run skips the download and finishes quickly.';

export type PrepareRequest = {
  url: string;
  /** The sheet row to write into. Omitted for an ad-hoc link. */
  tab?: string;
  row?: number;
  transcript?: string;
  /**
   * A slot this row was already given, when a batch reserved them up front.
   *
   * Omitted for a single Prepare, which chooses its own — reading the calendar once per
   * row is only wrong when several rows do it at the same time and all read it before any
   * of them has written.
   */
  publicationDate?: string;
  /** Write the copy into the sheet, but queue nothing in Metricool. */
  skipMetricool?: boolean;
};

export type PrepareOutcome =
  | { ok: true; data: Record<string, unknown> }
  /** No captions and no speech: only a person can move this one on. */
  | { ok: false; kind: 'needs_transcript'; message: string }
  | { ok: false; kind: 'error'; message: string };

/**
 * @param onProgress called when the first pass banks the transcript, so a
 *        caller can say what is happening instead of showing a frozen button.
 */
export async function runPrepare(req: PrepareRequest, onProgress?: (note: string) => void): Promise<PrepareOutcome> {
  // Twice, never more. A second 'transcript_ready' means something other than
  // the clock is wrong, and looping would hide it behind a spinner.
  for (let attempt = 0; attempt < 2; attempt++) {
    let r: Response;
    try {
      r = await fetch('/api/videos/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: req.url, transcript: req.transcript || undefined, tab: req.tab, row: req.row, publicationDate: req.publicationDate, skipMetricool: req.skipMetricool }),
      });
    } catch {
      return { ok: false, kind: 'error', message: 'We could not reach the dashboard just now.' };
    }

    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;

    if (r.status === 422 && j?.error === 'no_transcript') {
      return { ok: false, kind: 'needs_transcript', message: String(j.message || 'No captions on this video — paste the transcript.') };
    }
    if (r.status === 202 && j?.error === 'transcript_ready' && attempt === 0) {
      onProgress?.(String(j.message || 'The transcript is done — writing the copy now.'));
      continue;
    }
    if (!r.ok) {
      const message = await friendlyErrorFromResponse(
        new Response(JSON.stringify(j), { status: r.status, headers: { 'content-type': 'application/json' } }),
        'We could not prepare that video.',
        TIMEOUT_HINT,
      );
      return { ok: false, kind: 'error', message };
    }
    return { ok: true, data: j };
  }
  return { ok: false, kind: 'error', message: 'That video needed more than two passes, which means something other than the clock is wrong.' };
}
