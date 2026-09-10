// One Prepare call, from the browser, including the second pass.
//
// Shared because there are now two ways to press it — the button on a row and
// the batch across many — and they must behave identically. A long video does
// not fit in one 60-second request: the server stops once the transcript is
// stored and answers 202 'transcript_ready', and the caller asks again. Having
// that written twice would mean one of the copies eventually drifting, and the
// bug would look like "batch prepare works differently".
import { friendlyErrorFromResponse } from '@/lib/friendly-error';

/**
 * What to tell a person when the platform kills a request outright.
 *
 * This used to say flatly "the transcript is kept, so the second run skips the download".
 * A killed request returns no body — the server never got to say anything — so that
 * sentence was printed on every timeout regardless of whether anything had been saved. On
 * a database missing the transcript table nothing ever was, and somebody pressed the
 * button over and over, paying for the same download each time, on advice this file
 * invented.
 *
 * It now says what is actually known, and names the one thing to check when it is wrong.
 */
export const TIMEOUT_HINT =
  'Press Prepare again — if the transcript was saved, the second run skips the download and finishes quickly. ' +
  'If it stops in the same place twice, the transcript is not being saved: check /api/health → database_schema.';

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
  | { ok: false; kind: 'needs_transcript'; message: string; code?: string }
  /**
   * @param code the server's own error name — `out_of_time`, `named_a_person`,
   *   `no_citation` and so on.
   *
   * Eight distinct codes used to collapse into these three kinds and the code
   * itself was dropped here, so nothing downstream could tell "trying again
   * fixes this" from "trying again buys the same refusal at the price of
   * another download". lib/failure-kind.ts can answer that question, but only
   * if the answer survives this boundary.
   */
  | { ok: false; kind: 'error'; message: string; code?: string };

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
      return { ok: false, kind: 'needs_transcript', message: String(j.message || 'No captions on this video — paste the transcript.'), code: 'no_transcript' };
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
      return { ok: false, kind: 'error', message, code: typeof j?.error === 'string' ? j.error : undefined };
    }
    return { ok: true, data: j };
  }
  return { ok: false, kind: 'error', message: 'That video needed more than two passes, which means something other than the clock is wrong.' };
}
