// web/lib/assistant-token.ts
// The signing key the assistant uses, and the batch ticket it issues.
//
// The batch drafter is a second route that must trust something the chat route
// decided: "this user asked for these eight posts, and confirmed it." Passing
// the list from the browser and believing it would make /api/assistant/batch a
// button anyone signed in can press to spend AI credit and fill the clinic's
// Metricool queue. So the chat route SIGNS the batch, and this route verifies.
//
// The key resolution is lifted verbatim from app/api/assistant/route.ts, which
// is now a caller rather than an owner: two copies of a fallback chain is how a
// deployment ends up with the two halves of one feature signing with different
// keys and no error anywhere.
import 'server-only';

import { createHmac, timingSafeEqual } from 'crypto';

let warnedAboutBorrowedKey = false;

/**
 * Key material for signing anything the client round-trips.
 *
 * Prefer a dedicated secret. The chain below keeps existing deployments working,
 * but borrowing SUPABASE_SERVICE_ROLE_KEY as application signing material couples
 * the most privileged credential in the system to an unrelated purpose — rotating
 * one then forces the other. Set ASSISTANT_SESSION_SECRET (openssl rand -hex 32).
 */
export function sessionKey(): string {
  const dedicated = process.env.ASSISTANT_SESSION_SECRET || process.env.CRON_SECRET;
  if (dedicated) return dedicated;
  const borrowed = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!warnedAboutBorrowedKey) {
    warnedAboutBorrowedKey = true;
    if (borrowed) {
      console.error(
        'assistant: signing sessions with SUPABASE_SERVICE_ROLE_KEY because neither ' +
        'ASSISTANT_SESSION_SECRET nor CRON_SECRET is set. Set ASSISTANT_SESSION_SECRET.',
      );
    } else {
      // With no key at all, every session fails verification and resets. The
      // assistant still answers, but statelessly: guided mode cannot advance and
      // "yes" never confirms anything. That is safe, and invisible — so say it.
      console.error(
        'assistant: NO signing key configured (ASSISTANT_SESSION_SECRET / CRON_SECRET / ' +
        'SUPABASE_SERVICE_ROLE_KEY all unset). Session state cannot survive a round-trip: ' +
        'guided mode, yes/no confirmation and batch drafting will not work until one is set.',
      );
    }
  }
  return borrowed;
}

/** How long a confirmed batch stays runnable. Long enough to run, short enough not to be a standing permit. */
export const BATCH_TTL_MS = 15 * 60 * 1000;

export type BatchTicket = {
  userId: string;
  /** The exact items the user was shown and agreed to. */
  items: { topic: string; network: string; publishAt: string; format?: string; mediaUrl?: string }[];
  expiresAt: number;
};

/**
 * Canonical bytes for a ticket.
 *
 * Every field that changes what gets WRITTEN is in here. Leaving mediaUrl out,
 * for instance, would let an approved batch be replayed with a different video
 * attached to the clinic's approved copy.
 */
function canonical(t: BatchTicket): string {
  return JSON.stringify([
    t.userId,
    t.expiresAt,
    t.items.map((i) => [i.topic, i.network, i.publishAt, i.format ?? '', i.mediaUrl ?? '']),
  ]);
}

export function signBatch(ticket: BatchTicket): string | null {
  const key = sessionKey();
  if (!key) return null;
  return createHmac('sha256', key).update(canonical(ticket)).digest('hex');
}

/**
 * Is this ticket one this server issued, to this user, still in date?
 *
 * Fails closed on a missing key: with nothing to sign with there is no way to
 * tell an issued batch from a crafted one, and the safe reading of "I cannot
 * tell" is no.
 */
export function batchIsAuthentic(ticket: BatchTicket | null | undefined, signature: string, userId: string): boolean {
  if (!ticket) return false;
  if (ticket.userId !== userId) return false;
  if (!ticket.expiresAt || Date.now() > ticket.expiresAt) return false;
  const expect = signBatch(ticket);
  const got = String(signature || '');
  if (!expect || !got || expect.length !== got.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expect), Buffer.from(got));
  } catch {
    return false;
  }
}
