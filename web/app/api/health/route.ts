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
// The checks themselves now live in lib/health-checks.ts, because this page was
// not the only thing that needed them: the assistant was answering "is anything
// broken?" from one check out of seventeen. This route is the same endpoint it
// always was, returning the same JSON — it just no longer owns the knowledge.
//
// It reports CONFIGURATION, with one deliberate exception. It never prints a
// secret, only whether one is present, and it makes no paid upstream calls. The
// exception is Semrush: "is the key set" was true on the live deployment for
// weeks while every lookup was refused by the unit floor, so the check reported
// healthy about a feature that was dead. It now asks the same budget guard the
// real calls use (a FREE balance read, cached ten minutes, stale-on-error).
import { NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { runHealthChecks, type Check } from '@/lib/health-checks';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  // Configuration state is not public: it tells an attacker which integrations
  // are live and which guards are unset.
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  // Uncached on purpose. This is the page a person opens BECAUSE they have just
  // changed something; serving it a minute-old answer is how "I fixed it and it
  // still says it is broken" happens. The assistant uses the cached read.
  // WRAPPED, because this endpoint failing takes the banner down with it.
  //
  // runHealthChecks makes live calls — Google Drive, Google Sheets, the Semrush
  // balance, several Supabase reads — so it CAN throw or time out for reasons
  // that have nothing to do with the deployment being unhealthy. Unwrapped, any
  // of those returned a 500 with no `checks` array, and components/SystemStatus
  // renders NOTHING when it cannot read one. So a transient Google blip made
  // the whole status banner disappear — including the Shared Drive setup panel
  // and its test button — and an absent banner is indistinguishable from "every
  // check passed".
  //
  // That is the failure mode this whole file exists to prevent, one level up:
  // the page you open BECAUSE something is broken must not be the page that
  // breaks. A synthetic failing check keeps the shape valid, so the banner
  // still renders and says plainly that the status could not be read.
  let checks: Check[];
  try {
    ({ checks } = await runHealthChecks());
  } catch (e) {
    reportError('health:run', e);
    checks = [{
      name: 'health_report',
      ok: false,
      severity: 'required',
      code: 'unreadable',
      detail: 'The status checks could not be completed just now, so nothing below could be verified. '
        + 'This is usually a temporary problem reaching Google or the database — reload in a moment. '
        + (e instanceof Error ? e.message.slice(0, 200) : ''),
    }];
  }

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
