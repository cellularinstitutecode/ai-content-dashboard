// web/app/api/semrush/route.ts
// Server endpoint for the Keyword Intelligence hub. All Semrush access stays
// on the server (key read from env, never exposed). Cache-first + budget-
// guarded via lib/semrush.
//
// GET /api/semrush?action=balance
// GET /api/semrush?action=hub&topic=...        → brief + related + questions
// GET /api/semrush?action=serp&topic=...       → top ranking domains
// GET /api/semrush?action=domain[&domain=...]  → full domain intelligence bundle
//                                                (overview, backlinks, top
//                                                keywords, competitors)
// GET /api/semrush?action=project              → Site Audit + Position Tracking
//                                                (needs SEMRUSH_PROJECT_ID)
import { NextRequest, NextResponse } from 'next/server';
import { researchBundle, serpCompetitors, getUnitsBalance, opportunityScore } from '@/lib/semrush';
import { domainBundle, primaryDomain, siteAudit, trackingSummary, normalizeDomain, keywordResearchActivity } from '@/lib/semrush-domain';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 30;

async function requireUser(): Promise<boolean> {
  try {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    return Boolean(user);
  } catch {
    // If the auth check itself breaks, fall through: lib/semrush is safe
    // without a key and everything degrades to cache/link-out.
    return true;
  }
}

export async function GET(req: NextRequest) {
  const action = (req.nextUrl.searchParams.get('action') || 'hub').trim();
  const topic = (req.nextUrl.searchParams.get('topic') || '').trim();

  if (!(await requireUser())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (action === 'balance') {
    const balance = await getUnitsBalance();
    return NextResponse.json({ balance }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (action === 'domain') {
    const domain = normalizeDomain(req.nextUrl.searchParams.get('domain') || '') || primaryDomain();
    const bundle = await domainBundle(domain);
    return NextResponse.json(bundle, { headers: { 'Cache-Control': 'private, max-age=300' } });
  }

  if (action === 'activity') {
    // Recent AI drafts that passed through the Semrush keyword filter.
    let rows: Awaited<ReturnType<typeof keywordResearchActivity>> = [];
    try {
      const sb = supabaseServer();
      const { data: { user } } = await sb.auth.getUser();
      if (user) rows = await keywordResearchActivity(user.id, 12);
    } catch {
      // fail-open: empty feed
    }
    return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (action === 'project') {
    const domain = normalizeDomain(req.nextUrl.searchParams.get('domain') || '') || primaryDomain();
    const [audit, tracking] = await Promise.all([siteAudit(), trackingSummary(domain)]);
    return NextResponse.json(
      { audit: audit.data, auditMeta: audit.meta, tracking: tracking.data, trackingMeta: tracking.meta },
      { headers: { 'Cache-Control': 'private, max-age=300' } }
    );
  }

  if (!topic) {
    return NextResponse.json({ error: 'topic required' }, { status: 400 });
  }

  if (action === 'serp') {
    const serp = await serpCompetitors(topic, { limit: 10 });
    return NextResponse.json(
      { ok: serp.ok, rows: serp.rows, source: serp.source, reason: serp.reason, note: serp.note ?? null, unitsSpent: serp.unitsSpent },
      { headers: { 'Cache-Control': 'private, max-age=300' } }
    );
  }

  // Default: the full hub bundle (brief + tables), plus fresh balance for the chip.
  const bundle = await researchBundle(topic, { relatedLimit: 12, questionLimit: 6 });
  const balance = await getUnitsBalance();
  return NextResponse.json(
    {
      ok: bundle.brief.source === 'semrush',
      source: bundle.brief.source,
      fromCache: bundle.brief.fromCache,
      reason: bundle.reason,
      note: bundle.note ?? null,
      brief: bundle.brief,
      related: bundle.related.map((k) => ({ ...k, opportunity: opportunityScore(k) })),
      questions: bundle.questions,
      unitsSpent: bundle.brief.unitsSpent,
      balance,
    },
    { headers: { 'Cache-Control': 'private, max-age=300' } }
  );
}
