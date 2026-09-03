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
// This endpoint reports CONFIGURATION, with one deliberate exception. It never
// prints a secret, only whether one is present, and it makes no paid upstream
// calls. The exception is Semrush: "is the key set" was true on the live
// deployment for weeks while every lookup was refused by the unit floor, so the
// check reported healthy about a feature that was dead. It now asks the same
// budget guard the real calls use (a FREE balance read, cached ten minutes,
// stale-on-error — so a Semrush outage fails it closed rather than crashing
// this endpoint).
import { NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { ALLOWED_EMAILS, ALLOWED_BLOG_IDS } from '@/lib/access';
import { keywordCapability } from '@/lib/semrush';
import { lastImageOutcome } from '@/lib/provider-status';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Check = {
  name: string;
  ok: boolean;
  severity: 'required' | 'optional';
  detail: string;
  /** A short machine code for WHY, where one check can fail for several reasons. */
  code?: string;
};

function has(name: string): boolean {
  return Boolean(process.env[name]);
}

export async function GET() {
  // Configuration state is not public: it tells an attacker which integrations
  // are live and which guards are unset.
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const keywords = await keywordCapability();

  // Images: what the account last DID, not what is in the environment.
  const imagesConfigured = has('OPENAI_API_KEY') && process.env.IMAGE_GEN !== 'off';
  const lastImage = imagesConfigured ? await lastImageOutcome() : null;
  const imagesFailing = Boolean(lastImage && !lastImage.ok);

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
      // Only a DEDICATED secret is ok. Falling back to CRON_SECRET used to
      // report "Dedicated signing secret configured", which hid exactly the
      // coupling this check exists to surface: CRON_SECRET is a plaintext
      // bearer that travels in an Authorization header on every cron run, so
      // reusing it as the assistant's HMAC key means one leaked header lets an
      // attacker mint signed sessions.
      ok: has('ASSISTANT_SESSION_SECRET'),
      severity: 'optional',
      detail: has('ASSISTANT_SESSION_SECRET')
        ? 'Dedicated signing secret configured.'
        : has('CRON_SECRET')
          ? 'Borrowing CRON_SECRET - a bearer token sent on every cron invocation. ' +
            'Set ASSISTANT_SESSION_SECRET so a leaked cron header cannot forge sessions.'
        : has('SUPABASE_SERVICE_ROLE_KEY')
          ? 'Falling back to SUPABASE_SERVICE_ROLE_KEY. It works, but couples the most ' +
            'privileged credential in the system to an unrelated purpose.'
          : 'NO signing key at all. Assistant sessions cannot survive a round-trip: ' +
            'guided mode and yes/no confirmation are inert until one is set.',
    },
    {
      name: 'allowed_emails',
      // An allowlist configured under either name works; only the hard-coded
      // fallback is a real problem. Checking ALLOWED_EMAILS alone reported 503
      // degraded for a deployment that was configured, just under the other name.
      ok: has('ALLOWED_EMAILS') || has('NEXT_PUBLIC_ALLOWED_EMAILS'),
      severity: 'required',
      detail: has('ALLOWED_EMAILS')
        ? ALLOWED_EMAILS.length + ' address(es) allowed, set server-side.'
        : has('NEXT_PUBLIC_ALLOWED_EMAILS')
          ? ALLOWED_EMAILS.length + ' address(es) allowed, but only via ' +
            'NEXT_PUBLIC_ALLOWED_EMAILS - that value is inlined into the browser bundle, ' +
            'so the privileged account list is public and cannot rotate without a deploy. ' +
            'Set ALLOWED_EMAILS as well.'
          : 'No allowlist configured: it resolves to a hard-coded default in lib/access.ts, ' +
            'so changing who can sign in needs a code change and a deploy.',
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
      ok: keywords.ok,
      code: keywords.reason,
      severity: 'optional',
      detail: keywords.ok
        ? 'Live keyword research is running. Balance ' + keywords.balance + ' units, floor ' + keywords.floor + '.'
        : keywords.reason === 'no_token'
          ? 'SEMRUSH_API_KEY is unset: the keyword layer degrades to cache-or-link-out — the Semrush ' +
            'panel, the assistant’s live grounding and Autopilot’s angle selection all lose their data.'
          : keywords.reason === 'budget'
            ? 'The key is set but the unit balance (' + keywords.balance + ') is at or below the protection ' +
              'floor (SEMRUSH_UNIT_FLOOR=' + keywords.floor + '), so every live lookup is refused. Top up units ' +
              'or lower the floor. Until then the keyword layer is serving cache-or-link-out only.'
            : 'The key is set but countapiunits.html (a v3 endpoint) returns no number, so the spend guard ' +
              'fails closed and every live lookup is refused. On this account that is because the keys on the ' +
              'API Keys page are v4 keys; every report in this app is Standard API (v3), which needs a Business-plan ' +
              'Standard API key. Adding units changes nothing. If Semrush is merely down, this clears within 30s.',
    },
    {
      // Capability, not configuration. `has('OPENAI_API_KEY')` stayed true
      // through days of failed generations while the account sat at zero
      // credit, so this endpoint reported healthy about a feature that was
      // dead — the same mistake the semrush check above was corrected for.
      // The last real attempt is recorded by lib/images.ts on every call; a
      // failure older than a day is no longer evidence about right now.
      name: 'images',
      ok: imagesConfigured && !imagesFailing,
      code: !imagesConfigured ? 'not_configured' : imagesFailing ? (lastImage!.reason ?? 'other') : undefined,
      severity: 'optional',
      detail: !imagesConfigured
        ? 'AI hero images need OPENAI_API_KEY and IMAGE_GEN not set to "off".'
        : !imagesFailing
          ? 'AI hero images are configured' + (lastImage?.ok ? ' and the last generation succeeded.' : '.')
          : lastImage!.reason === 'no_credit'
            ? 'The key is set but the OpenAI account is out of credit: the last generation was refused for ' +
              'billing. Images, the vision check that keeps text off them, and the voice assistant all run on ' +
              'this one account, so all three are down until it is topped up. Text generation is unaffected — ' +
              'it runs on Anthropic.'
            : lastImage!.reason === 'bad_key'
              ? 'The key is set but OpenAI rejected it on the last generation. Check OPENAI_API_KEY has not ' +
                'been revoked or rotated.'
              : lastImage!.reason === 'rate_limited'
                ? 'OpenAI rate-limited the last generation. This usually clears itself; if it does not, the ' +
                  'account may be at a usage cap.'
                : 'The last image generation failed. Try one from the Image Studio to see the reason.',
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
