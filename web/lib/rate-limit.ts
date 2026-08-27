// web/lib/rate-limit.ts
// DB-backed sliding-window rate limiter for expensive AI routes.
//
// Uses the service-role client so it can read/write usage_events regardless of
// RLS. Counts a user's events for a given action within the trailing window and
// rejects once the cap is reached.
//
// IMPORTANT: this limiter FAILS CLOSED. If the usage_events table does not exist
// yet (migration not applied) or the DB errors, we REJECT the request so an
// outage can't remove the only cap on AI spend. For the one-time pre-migration
// bootstrap you may set RATE_LIMIT_FAIL_OPEN=true to temporarily allow traffic;
// leave it unset in production. Apply web/supabase/schema.sql to activate.
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';

export type RateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
};

// Per-action policy: max requests allowed within windowSec.
type Policy = { limit: number; windowSec: number };

const POLICIES: Record<string, Policy> = {
  generate: { limit: 30, windowSec: 3600 },
  assistant: { limit: 60, windowSec: 3600 },
  'opus-clip': { limit: 10, windowSec: 3600 },
  image: { limit: 20, windowSec: 3600 },
  // Paid third-party credit spend — these were previously uncapped.
  'autopilot-tick': { limit: 12, windowSec: 3600 },
  'autopilot-action': { limit: 40, windowSec: 3600 },
  semrush: { limit: 120, windowSec: 3600 },
  keywords: { limit: 60, windowSec: 3600 },
  // Reaches a live brand account through a paid third party.
  schedule: { limit: 60, windowSec: 3600 },
  // Each call mints a spendable OpenAI Realtime credential.
  realtime: { limit: 20, windowSec: 3600 },
};

const DEFAULT_POLICY: Policy = { limit: 60, windowSec: 3600 };

// Check (and record) a usage event for a user + action.
// Returns ok:false when the trailing-window count is at or above the limit.
export async function checkRateLimit(userId: string, action: string): Promise<RateLimitResult> {
  const policy = POLICIES[action] || DEFAULT_POLICY;
  const windowStart = new Date(Date.now() - policy.windowSec * 1000).toISOString();
  // Explicit opt-in for the pre-migration bootstrap window only. Leave unset in prod.
  const failOpen = process.env.RATE_LIMIT_FAIL_OPEN === 'true';

  try {
    const admin = supabaseAdmin();

    const { count, error } = await admin
      .from('usage_events')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('action', action)
      .gte('created_at', windowStart);

    // Fail CLOSED on any DB error (e.g. table missing before migration) unless
    // explicitly bootstrapping via RATE_LIMIT_FAIL_OPEN.
    if (error) {
      return failOpen
        ? { ok: true, limit: policy.limit, remaining: policy.limit, retryAfterSec: 0 }
        : { ok: false, limit: policy.limit, remaining: 0, retryAfterSec: policy.windowSec };
    }

    const used = count || 0;
    if (used >= policy.limit) {
      return { ok: false, limit: policy.limit, remaining: 0, retryAfterSec: policy.windowSec };
    }

    // Under the cap: record this event. The insert is what MAKES the limiter
    // work — if it silently fails, `count` stays flat and the cap never trips.
    // The module's contract is fail-closed, so a failed insert is treated the
    // same way a failed count is.
    const { error: insertError } = await admin.from('usage_events').insert({ user_id: userId, action });
    if (insertError) {
      console.error('rate-limit: usage_events insert failed', action, insertError.message);
      return failOpen
        ? { ok: true, limit: policy.limit, remaining: policy.limit, retryAfterSec: 0 }
        : { ok: false, limit: policy.limit, remaining: 0, retryAfterSec: policy.windowSec };
    }

    return {
      ok: true,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - used - 1),
      retryAfterSec: 0,
    };
  } catch {
    return failOpen
      ? { ok: true, limit: policy.limit, remaining: policy.limit, retryAfterSec: 0 }
      : { ok: false, limit: policy.limit, remaining: 0, retryAfterSec: policy.windowSec };
  }
}
