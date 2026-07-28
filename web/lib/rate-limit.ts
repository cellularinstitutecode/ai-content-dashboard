// web/lib/rate-limit.ts
// DB-backed sliding-window rate limiter for expensive AI routes.
//
// Uses the service-role client so it can read/write usage_events regardless of
// RLS. Counts a user's events for a given action within the trailing window and
// rejects once the cap is reached.
//
// IMPORTANT: this limiter FAILS OPEN. If the usage_events table does not exist
// yet (migration not applied) or the DB errors, we allow the request rather than
// block legitimate traffic. Apply web/supabase/schema.sql to activate enforcement.
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase';

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
};

const DEFAULT_POLICY: Policy = { limit: 60, windowSec: 3600 };

// Check (and record) a usage event for a user + action.
// Returns ok:false when the trailing-window count is at or above the limit.
export async function checkRateLimit(userId: string, action: string): Promise<RateLimitResult> {
  const policy = POLICIES[action] || DEFAULT_POLICY;
  const windowStart = new Date(Date.now() - policy.windowSec * 1000).toISOString();

  try {
    const admin = supabaseAdmin();

    const { count, error } = await admin
      .from('usage_events')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('action', action)
      .gte('created_at', windowStart);

    // Fail open on any DB error (e.g. table missing before migration).
    if (error) {
      return { ok: true, limit: policy.limit, remaining: policy.limit, retryAfterSec: 0 };
    }

    const used = count || 0;
    if (used >= policy.limit) {
      return { ok: false, limit: policy.limit, remaining: 0, retryAfterSec: policy.windowSec };
    }

    // Under the cap: record this event. Ignore insert errors (fail open).
    await admin.from('usage_events').insert({ user_id: userId, action });

    return {
      ok: true,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - used - 1),
      retryAfterSec: 0,
    };
  } catch {
    return { ok: true, limit: policy.limit, remaining: policy.limit, retryAfterSec: 0 };
  }
}
