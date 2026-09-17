// web/lib/publish-mode.ts
// Do posts arrive in Metricool SCHEDULED, or as drafts to approve?
//
// Metricool shows the difference at a glance: a scheduled post is in colour on
// the calendar and publishes itself at its time; a draft is greyed out and
// waits for somebody. The clinic was making that change by hand on every post
// after the fact, which is the whole reason this setting exists.
//
// ONE SETTING, read in one place. The three doors that create posts — the
// panel's Send, the nightly video sweep and the assistant's batch drafter —
// all ask here, so they cannot drift apart and there is one thing to change to
// put the approval step back.
//
// WHAT THIS DOES NOT CHANGE, and must not:
//   * the mode is a SERVER setting and never a request parameter. A caller
//     asking to publish is how a signed-in account turns a review queue into a
//     megaphone; lib/route-policy.test.ts still holds that line.
//   * a video post with no video still does not go out (lib/video-required.ts).
//   * the advertising gate still refuses copy without its AVISO and REF.
//   * a row already published is still refused rather than sent twice.
//
// Pure: no imports, so the test runner reads this file directly.

export type PublishMode = 'review' | 'scheduled';

/**
 * The mode every new post is created in.
 *
 * Defaults to 'scheduled' — posts land on Metricool's calendar ready to go out
 * at their slot. Set PUBLISH_MODE=review to put the approve-first step back,
 * in which case posts arrive greyed out and nothing publishes until a person
 * presses Approve.
 */
export function publishMode(env: Record<string, string | undefined> = process.env): PublishMode {
  const raw = String(env.PUBLISH_MODE || '').trim().toLowerCase();
  if (raw === 'review' || raw === 'draft' || raw === 'drafts') return 'review';
  return 'scheduled';
}

/** True when posts are created ready to publish themselves. */
export function publishesOnSend(env: Record<string, string | undefined> = process.env): boolean {
  return publishMode(env) === 'scheduled';
}
