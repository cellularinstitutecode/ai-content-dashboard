// web/app/api/health/route.ts
//
// Section 3 of GO-LIVE.md, as code that runs itself.
//
// The deployment currently has no way to answer "is this thing actually wired
// up" except a human remembering to run a checklist. That matters more here than
// in most apps, because every integration in this codebase degrades quietly by
// design: a missing SEMRUSH_API_KEY turns the keyword layer into a link-out, and
// a missing CRON_SECRET makes both daily crons 401 forever. Nothing is broken in
// a way anybody sees - Autopilot just never runs.
//
// This endpoint reports CONFIGURATION only. It never prints a secret, only
// whether one is present, and it makes no upstream calls (so it costs nothing
// and cannot itself fail because a third party is down).
import { NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { ALLOWED_EMAILS, ALLOWED_BLOG_IDS } from '@/lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Check = {
  name: string;
  ok: boolean;
  severity: 'required' | 'optional';
  detail: string;
};

function has(name: string): boolean {
  return Boolean(process.env[name]);
}

export async function GET() {
  // Configuration state is not public: it tells an attacker which integrations
  // are live and which guards are unset.
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const checks: Check[] = [
    {
      name: 'supabase',
      ok: has('NEXT_PUBLIC_SUPABASE_URL') && has('NEXT_PUBLIC_SUPABASE_ANON_KEY') && has('SUPABASE_SERVICE_ROLE_KEY'),
      severity: 'required',
      detail: 'Database, auth and storage.',
    },
    {
      name: 'cron_secret',
      ok: has('CRON_SECRET'),
      severity: 'required',
      detail:
        'Without it BOTH scheduled jobs in vercel.json fail closed every day: ' +
        '/api/metricool/sync returns 401 at its bearer check, and /api/autopilot/tick ' +
        'falls through to session auth that a cron does not have. Autopilot never runs ' +
        'and post_metrics is never populated, so the learning loop has no data.',
    },
    {
      name: 'assistant_session_secret',
      ok: has('ASSISTANT_SESSION_SECRET') || has('CRON_SECRET'),
      severity: 'optional',
      detail: has('ASSISTANT_SESSION_SECRET') || has('CRON_SECRET')
        ? 'Dedicated signing secret configured.'
        : has('SUPABASE_SERVICE_ROLE_KEY')
          ? 'Falling back to SUPABASE_SERVICE_ROLE_KEY. It works, but couples the most ' +
            'privileged credential in the system to an unrelated purpose.'
          : 'NO signing key at all. Assistant sessions cannot survive a round-trip: ' +
            'guided mode and yes/no confirmation are inert until one is set.',
    },
    {
      name: 'allowed_emails',
      ok: has('ALLOWED_EMAILS'),
      severity: 'required',
      detail:
        ALLOWED_EMAILS.length +
        ' address(es) currently allowed. Unset means the allowlist resolves to a hard-coded ' +
        'default in lib/access.ts, so changing who can sign in needs a deploy.',
    },
    {
      name: 'ai_provider',
      ok: has('ANTHROPIC_API_KEY') || has('OPENAI_API_KEY'),
      severity: 'required',
      detail: 'At least one generation provider must be configured.',
    },
    {
      name: 'metricool',
      ok: has('METRICOOL_USER_TOKEN') && has('METRICOOL_BLOG_ID') && has('METRICOOL_USER_ID'),
      severity: 'required',
      detail: ALLOWED_BLOG_IDS.size + ' brand profile(s) allowlisted for scheduling.',
    },
    {
      name: 'semrush',
      ok: has('SEMRUSH_API_KEY'),
      severity: 'optional',
      detail:
        'Unset means the entire keyword layer degrades to cache-or-link-out: the Semrush ' +
        'panel, the assistant’s live grounding, and Autopilot’s angle selection all ' +
        'lose their data. Degrading is fine; degrading without anyone choosing it is not.',
    },
    {
      name: 'images',
      ok: has('OPENAI_API_KEY') && process.env.IMAGE_GEN !== 'off',
      severity: 'optional',
      detail: 'AI hero images need OPENAI_API_KEY and IMAGE_GEN not set to "off".',
    },
    {
      name: 'opus_webhook',
      ok: has('OPUS_WEBHOOK_SECRET') || has('OPUS_API_KEY'),
      severity: 'optional',
      detail: 'Without a secret the webhook refuses every call with 503; the poll fallback still delivers clips.',
    },
    {
      name: 'drive',
      ok: has('GOOGLE_SERVICE_ACCOUNT_JSON') && has('DRIVE_FOLDER_ID'),
      severity: 'optional',
      detail: 'Permanent clip storage. Without it clips rely on Opus signed links, which expire in ~3 days.',
    },
    {
      name: 'rate_limiting',
      ok: process.env.RATE_LIMIT_FAIL_OPEN !== 'true',
      severity: 'required',
      detail:
        'RATE_LIMIT_FAIL_OPEN=true removes the only cap on AI spend whenever the database ' +
        'errors. It exists for a one-time migration bootstrap; leave it unset in production.',
    },
  ];

  const failing = checks.filter((c) => !c.ok);
  const requiredFailing = failing.filter((c) => c.severity === 'required');

  return NextResponse.json(
    {
      status: requiredFailing.length ? 'degraded' : 'ok',
      requiredFailing: requiredFailing.map((c) => c.name),
      optionalFailing: failing.filter((c) => c.severity === 'optional').map((c) => c.name),
      checks,
    },
    {
      status: requiredFailing.length ? 503 : 200,
      headers: { 'cache-control': 'no-store' },
    },
  );
}
