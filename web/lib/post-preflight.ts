// web/lib/post-preflight.ts
// The one gate every post passes, whichever door it came through.
//
// WHY THIS EXISTS NOW. Until posts started arriving SCHEDULED, every one of
// them went through Approve, and Approve is where the correctness checks lived.
// Approve is optional now — a post publishes itself at its slot — so those
// checks are the only backstop left, and an audit found they were not all
// there:
//
//   * THE VIDEO RULE RAN ON NEITHER SEND PATH. videoVerdict was called from
//     Approve and from the Autopilot's approve, and from nowhere else. A
//     LinkedIn post of transcript-written copy whose video copy had failed
//     went out text-only. The sweep's only defence was dropping the networks
//     that REQUIRE media — LinkedIn, X and Facebook sailed through.
//   * The manual door enforced no character limit at all. Metricool truncates,
//     and the AVISO and REF lines live at the END of a caption, so truncation
//     produces a silently non-compliant medical advertisement.
//   * The manual door never checked aspect: a landscape video could be
//     scheduled to TikTok.
//   * The automatic door took a supplied publishing time on trust and would
//     accept one in the past.
//
// Each rule below already existed and was already tested. What did not exist
// was one place that ran them ALL, which is exactly why the two doors drifted.
// Nothing here is new logic; it is the same rules, in one order, for everyone.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly and
// so both a route and a library function can call it.
import { fitsNetwork } from './video-row.ts';
import { fitsAspect } from './video-slot.ts';
import { mediaProblem } from './composer.ts';
import { pendingRefusal, videoVerdict, type PackLike } from './video-required.ts';

export type PreflightInput = {
  /** The one network this post is going to, lowercased by the caller or not. */
  network: string;
  text: string;
  /** The linked draft's pack, when there is one. Null for a hand-written post. */
  pack?: PackLike;
  /** Does the post actually carry a video or image? */
  hasMedia: boolean;
  /** The sheet's FORMATO for the video, when known — decides the aspect rule. */
  format?: string | null;
  /** The absolute instant it is meant to go out. */
  publishAt?: string | Date | null;
  now?: Date;
};

export type PreflightVerdict =
  | { ok: true }
  | { ok: false; reason: 'no_video' | 'too_long' | 'needs_media' | 'wrong_aspect' | 'past'; message: string };

/**
 * May this post be created?
 *
 * Ordered by how badly each failure reads to the clinic: a post that goes out
 * without its video, or with its legally required lines truncated off, is worse
 * than one refused for a fixable reason.
 */
export function preflightPost(input: PreflightInput): PreflightVerdict {
  const network = String(input.network || '').trim().toLowerCase();
  const text = String(input.text || '');

  // 1. Written from a video, and has none. THE rule the clinic stated first:
  //    "only with the video included; if not, it doesn't go out."
  const verdict = videoVerdict(input.pack ?? null, input.hasMedia);
  if (verdict.pending) return { ok: false, reason: 'no_video', message: pendingRefusal(verdict) };

  // 2. Too long. Reported, never trimmed — see fitsNetwork's own note.
  const fit = fitsNetwork(network, text);
  if (!fit.ok) {
    return {
      ok: false,
      reason: 'too_long',
      message: 'That copy is ' + fit.length.toLocaleString() + ' characters and ' + network
        + ' accepts ' + fit.limit.toLocaleString() + '. Shorten it by ' + (fit.length - fit.limit).toLocaleString()
        + ' — it cannot be trimmed automatically, because the AVISO and REF lines are at the end.',
    };
  }

  // 3. A network that cannot post text alone.
  const media = mediaProblem([network], input.hasMedia ? 'yes' : '');
  if (media) return { ok: false, reason: 'needs_media', message: media };

  // 4. A landscape video on a vertical-only network.
  if (input.format !== undefined && !fitsAspect(network, input.format ?? null)) {
    return {
      ok: false,
      reason: 'wrong_aspect',
      message: 'That video is landscape and ' + network + ' only takes vertical. Send it to the other channels, or use a vertical cut.',
    };
  }

  // 5. A time that has already gone. A post scheduled into the past either
  //    publishes immediately or never, and neither is what anybody asked for.
  if (input.publishAt != null && input.publishAt !== '') {
    const at = input.publishAt instanceof Date ? input.publishAt.getTime() : Date.parse(String(input.publishAt));
    const now = (input.now ?? new Date()).getTime();
    if (!Number.isFinite(at)) return { ok: false, reason: 'past', message: 'That publishing time could not be read.' };
    if (at <= now) return { ok: false, reason: 'past', message: 'That time has already passed. Pick a future one.' };
  }

  return { ok: true };
}
