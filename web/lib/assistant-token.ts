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
// Deliberately NOT 'server-only'. It needs nothing but node crypto and an
// environment variable, and marking it server-only put the consent logic for the
// one path that spends money and writes to the clinic's Metricool queue outside
// what `node --test` can load — which is why the whole of it shipped untested.
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

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
  /**
   * This ticket's identity, so it can be spent exactly once.
   *
   * The session round-trips through the BROWSER. Clearing `session.pendingBatch`
   * server-side only edits the copy in the current response — the client still
   * holds the pre-confirmation body, signature intact, and re-posting it with
   * "yes" ran the whole batch again. Five replays of a ten-item batch is fifty
   * posts in the clinic's Metricool queue, every one of them signature-valid.
   * Expiry alone cannot fix that; an id the server records as spent can.
   */
  jti: string;
};

/** A fresh ticket id. Random, not derived — two identical batches must be spendable separately. */
export function newTicketId(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Canonical bytes for a ticket.
 *
 * Every field that changes what gets WRITTEN is in here, and each is encoded so
 * that ABSENT and EMPTY are different bytes. `i.mediaUrl ?? ''` mapped
 * undefined, null and '' onto the same string while draftAndQueue branches on
 * truthiness — so a ticket approved as "reel with video" could have its
 * mediaUrl deleted and still verify, queueing the approved copy as a text-only
 * post. Substitution was covered; removal and downgrade were not.
 */
function canonical(t: BatchTicket): string {
  const tag = (v: unknown): string => (v === undefined ? '\u0000undefined' : v === null ? '\u0000null' : String(v));
  return JSON.stringify([
    t.userId,
    t.expiresAt,
    t.jti ?? '',
    t.items.map((i) => [i.topic, i.network, i.publishAt, tag(i.format), tag(i.mediaUrl)]),
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
  if (!ticket.jti) return false;
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

// --- spent tickets ----------------------------------------------------------
//
// In-process, because that is honest about what it is: one Lambda's memory. It
// stops the replay that actually happens — a browser re-posting the same body,
// a double-click, a retry after a timeout — which all land on a warm instance
// within seconds. A determined attacker with a valid signed ticket could wait
// for a cold start, so this is a guard rail, not a vault; the ticket also
// expires, is bound to one user, and every post it can create is a draft that a
// human still has to approve.
//
// Deliberately not a database table: that needs a migration, and asking someone
// to paste SQL before their assistant stops double-posting is the wrong trade.
const spent = new Map<string, number>();

/**
 * Claim this ticket. True exactly once per id; false every time after.
 *
 * Call it BEFORE doing the work — a ticket claimed after the batch runs is a
 * ticket that a concurrent second request has already got past.
 */
export function claimBatch(jti: string, ttlMs = BATCH_TTL_MS): boolean {
  const id = String(jti || '');
  if (!id) return false;
  const now = Date.now();
  // Opportunistic sweep. The map only ever holds tickets from the last quarter
  // hour, so it cannot grow without bound on a long-lived instance.
  if (spent.size > 500) {
    for (const [k, at] of spent) if (at <= now) spent.delete(k);
  }
  const seen = spent.get(id);
  if (seen !== undefined && seen > now) return false;
  spent.set(id, now + ttlMs);
  return true;
}
