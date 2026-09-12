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
import { runHealthChecks } from '@/lib/health-checks';

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
  const { checks } = await runHealthChecks();

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
