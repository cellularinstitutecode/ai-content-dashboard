// web/lib/revive-decision.ts
// Should a stalled video row be handed back to the queue?
//
// Kept apart from lib/video-revive.ts, which does the reading and writing, so
// the rule itself can be tested without Supabase in the room. Getting it wrong
// is expensive in both directions: too eager and the clinic pays for the same
// download every day; too shy and a video is never made and nothing says why.
//
// Relative imports only — the test runner strips types and runs this file
// directly, so a `@/`-aliased import would take it out of reach.
import { failureKind } from './failure-kind.ts';
import { claimIsStale } from './video-row.ts';

/**
 * How long a retired row waits before it is worth another go.
 *
 * Long enough that a genuinely unreadable video is not re-transcribed daily,
 * short enough that one bad afternoon does not cost a week. The sweep runs
 * once a day, so anything under a day effectively means "the next run".
 */
export const REVIVE_COOLDOWN_MS = 12 * 60 * 60 * 1000;

/**
 * How many times a row may be brought back before it is left alone.
 *
 * Without a ceiling this is not a cooldown, it is an unlimited retry with
 * extra steps — and the thing being retried costs a download and a
 * transcription every single time.
 */
export const MAX_REVIVALS = 2;

export type ReviveRow = {
  state: string;
  attempts: number;
  updated_at?: string | null;
  last_error_code?: string | null;
  revivals?: number | null;
};

export type ReviveDecision =
  /** A claim nothing is holding any more. Hand it back and refund the attempt. */
  | 'release'
  /** Retired on a failure that has probably passed. Give it a clean slate. */
  | 'revive'
  /** Trying again reaches the same answer. Say so rather than spend on it. */
  | 'needs_human'
  /** Nothing to do: in flight, or still inside its cooldown. */
  | 'leave';

export function reviveDecision(row: ReviveRow, now: number): ReviveDecision {
  // A run that died mid-flight. The attempt it consumed is given back, because
  // dying halfway is evidence about the request, not about the video.
  if (row.state === 'preparing') {
    return claimIsStale(row.updated_at, now) ? 'release' : 'leave';
  }
  if (row.state !== 'failed' && row.state !== 'needs_transcript') return 'leave';

  // 'terminal' means a person must paste a transcript or fix a link;
  // 'blocked' means a migration is missing. Another pass reaches the same
  // answer, having paid for a full download to get there.
  if (failureKind(row.last_error_code ?? null) !== 'transient') return 'needs_human';

  if ((row.revivals ?? 0) >= MAX_REVIVALS) return 'needs_human';

  const at = row.updated_at ? Date.parse(row.updated_at) : NaN;
  if (Number.isFinite(at) && now - at < REVIVE_COOLDOWN_MS) return 'leave';
  return 'revive';
}
