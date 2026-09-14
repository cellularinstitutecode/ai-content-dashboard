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
import { redact } from '@/lib/report';
import { classifyImageFailure, OUTCOME_WINDOW_MS, type ImageFailureReason } from './image-failure-reason.ts';

// Re-exported so callers have one import for "what do we know about images".
export { classifyImageFailure, OUTCOME_WINDOW_MS, type ImageFailureReason };

export type ImageOutcome = {
  ok: boolean;
  reason: ImageFailureReason | null;
  /** Epoch ms of the attempt. */
  at: number;
};

/**
 * The providers this module can speak for.
 *
 * It began life hardcoded to `openai_images` — `const PROVIDER =
 * 'openai_images'` — despite the general name, so a revoked ANTHROPIC_API_KEY
 * or a rejected Metricool token reported healthy forever while the health check
 * asked only "is the variable set". That is the exact question the module's own
 * header says nobody was asking. The table is already keyed by provider, so
 * naming more of them costs no migration.
 */
export type ProviderName = 'openai_images' | 'anthropic_text' | 'openai_text' | 'metricool';

const IMAGE_PROVIDER: ProviderName = 'openai_images';

/** An outcome for any provider. Same shape the image path always used. */
export type ProviderOutcome = ImageOutcome;

// A process that just called a provider knows the answer without a round trip;
// the row is for the OTHER instance that serves /api/health.
const lastSeen = new Map<ProviderName, ProviderOutcome>();

/**
 * Remember how a call to a provider went. Never throws, never awaited.
 *
 * Same discipline as before: recording must never fail the thing being
 * recorded, because the call has already happened and this is evidence, not a
 * checkpoint.
 */
export function recordProviderOutcome(
  provider: ProviderName,
  input: { ok: boolean; message?: string },
): void {
  const outcome: ProviderOutcome = {
    ok: input.ok,
    reason: input.ok ? null : classifyImageFailure(input.message || ''),
    at: Date.now(),
  };
  lastSeen.set(provider, outcome);
  void (async () => {
    try {
      await supabaseAdmin()
        .from('provider_status')
        .upsert(
          {
            provider,
            ok: outcome.ok,
            reason: outcome.reason,
            // Redacted: this is a provider's own error text, which is exactly
            // where a vendor has been seen echoing a live key back.
            detail: input.message ? redact(String(input.message)).slice(0, 300) : null,
            updated_at: new Date(outcome.at).toISOString(),
          },
          { onConflict: 'provider' },
        );
    } catch {
      // Health degrades to "no record". A call must never fail because we could
      // not write a note about it.
    }
  })();
}

/** Remember how an image generation went. Never throws, never awaited. */
export function recordImageOutcome(input: { ok: boolean; message?: string }): void {
  recordProviderOutcome(IMAGE_PROVIDER, input);
}

/**
 * The last image attempt, if it is recent enough to still mean anything.
 *
 * @param windowMs how far back an attempt still counts (default 24h)
 */
export async function lastImageOutcome(windowMs: number = OUTCOME_WINDOW_MS): Promise<ImageOutcome | null> {
  return lastProviderOutcome(IMAGE_PROVIDER, windowMs);
}

/**
 * The last attempt against any provider, if it is recent enough to mean
 * anything.
 *
 * Returns null for "nothing known", which every caller must read as "no reason
 * to complain" rather than as a fault — a deployment that has not called a
 * provider yet is not a broken one.
 */
export async function lastProviderOutcome(
  provider: ProviderName,
  windowMs: number = OUTCOME_WINDOW_MS,
): Promise<ProviderOutcome | null> {
  const fresh = (o: ProviderOutcome | null) => (o && Date.now() - o.at <= windowMs ? o : null);
  let stored: ProviderOutcome | null = null;
  try {
    const { data } = await supabaseAdmin()
      .from('provider_status')
      .select('ok, reason, updated_at')
      .eq('provider', provider)
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
  // Whichever is newer. This instance may have called the provider a second
  // ago; the row may have been written by a different instance a minute ago.
  const mine = lastSeen.get(provider) ?? null;
  const best = !stored ? mine : !mine ? stored : stored.at >= mine.at ? stored : mine;
  return fresh(best);
}

/** Test seam: forget what this process has seen. */
export function __resetImageOutcome(): void {
  lastSeen.clear();
}
