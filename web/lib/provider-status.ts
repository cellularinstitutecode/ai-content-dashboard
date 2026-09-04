// What the providers actually did last time we asked them.
//
// /api/health reported `images: ok` for as long as OPENAI_API_KEY was set. It
// was set. The account was out of credit, so every generation had been failing
// for days, the vision verifier and the voice assistant were down with it, and
// the health endpoint — the one thing a non-technical coordinator is told to
// look at — said everything was fine. `has('OPENAI_API_KEY')` answers "is this
// configured", and nobody was asking that.
//
// This module records the outcome of the last real attempt so health can
// report CAPABILITY instead, the same correction lib/semrush.ts already got
// when "is the key set" stayed true through weeks of refused lookups.
//
// It is deliberately best-effort in both directions. Recording never throws
// into a generation, and reading never throws into the health endpoint: if the
// table is missing (see the `database_schema` check) or Supabase is down, the
// answer is "no record", which reads as "nothing known against it" — the same
// place we were before, never a false alarm.
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { classifyImageFailure, OUTCOME_WINDOW_MS, type ImageFailureReason } from './image-failure-reason.ts';

// Re-exported so callers have one import for "what do we know about images".
export { classifyImageFailure, OUTCOME_WINDOW_MS, type ImageFailureReason };

export type ImageOutcome = {
  ok: boolean;
  reason: ImageFailureReason | null;
  /** Epoch ms of the attempt. */
  at: number;
};

const PROVIDER = 'openai_images';

// A process that just generated an image knows the answer without a round
// trip; the row is for the OTHER instance that serves /api/health.
let lastSeen: ImageOutcome | null = null;

/** Remember how an image generation went. Never throws, never awaited. */
export function recordImageOutcome(input: { ok: boolean; message?: string }): void {
  const outcome: ImageOutcome = {
    ok: input.ok,
    reason: input.ok ? null : classifyImageFailure(input.message || ''),
    at: Date.now(),
  };
  lastSeen = outcome;
  void (async () => {
    try {
      await supabaseAdmin()
        .from('provider_status')
        .upsert(
          {
            provider: PROVIDER,
            ok: outcome.ok,
            reason: outcome.reason,
            detail: input.message ? String(input.message).slice(0, 300) : null,
            updated_at: new Date(outcome.at).toISOString(),
          },
          { onConflict: 'provider' },
        );
    } catch {
      // Health degrades to "no record". A generation must never fail because
      // we could not write a note about it.
    }
  })();
}

/**
 * The last image attempt, if it is recent enough to still mean anything.
 *
 * @param windowMs how far back an attempt still counts (default 24h)
 */
export async function lastImageOutcome(windowMs: number = OUTCOME_WINDOW_MS): Promise<ImageOutcome | null> {
  const fresh = (o: ImageOutcome | null) => (o && Date.now() - o.at <= windowMs ? o : null);
  let stored: ImageOutcome | null = null;
  try {
    const { data } = await supabaseAdmin()
      .from('provider_status')
      .select('ok, reason, updated_at')
      .eq('provider', PROVIDER)
      .maybeSingle();
    if (data && data.updated_at) {
      stored = {
        ok: Boolean(data.ok),
        reason: (data.reason as ImageFailureReason | null) ?? null,
        at: new Date(data.updated_at).getTime(),
      };
    }
  } catch {
    // Missing table or an unreachable database: fall back to this instance's
    // own memory rather than inventing a verdict.
  }
  // Whichever is newer. This instance may have generated an image a second
  // ago; the row may have been written by a different instance a minute ago.
  const best = !stored ? lastSeen : !lastSeen ? stored : stored.at >= lastSeen.at ? stored : lastSeen;
  return fresh(best);
}

/** Test seam: forget what this process has seen. */
export function __resetImageOutcome(): void {
  lastSeen = null;
}
