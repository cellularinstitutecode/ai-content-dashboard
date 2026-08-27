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
// GET /api/semrush?action=movers[&domain=...]  → new/lost/improved/declined
// GET /api/semrush?action=advise[&domain=...]  → AI ranking action plan built
//                                                from the (cached) domain data
import { NextRequest, NextResponse } from 'next/server';
import { researchBundle, serpCompetitors, getUnitsBalance, opportunityScore } from '@/lib/semrush';
import { domainBundle, primaryDomain, siteAudit, trackingSummary, normalizeDomain, keywordResearchActivity, keywordMovers } from '@/lib/semrush-domain';
import { chatAssistant } from '@/lib/ai';
import { checkRateLimit } from '@/lib/rate-limit';
import { supabaseServer } from '@/lib/supabase';

export const runtime = 'nodejs';
export const maxDuration = 60;

async function requireUser(): Promise<string | null> {
  try {
    const sb = await supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    return user?.id || null;
  } catch {
    // Fail CLOSED: if the auth check itself breaks, do not open an endpoint
    // that can spend Semrush API units to anonymous callers.
    return null;
  }
}

// Every action below `balance` can miss the cache and spend paid Semrush
// units. Only `advise` was capped before, so a signed-in client looping over
// `action=hub` with fresh topics could drain the unit pot on its own.
const UNIT_SPENDING = new Set(['domain', 'movers', 'project', 'serp', 'hub']);

export async function GET(req: NextRequest) {
  const action = (req.nextUrl.searchParams.get('action') || 'hub').trim();
  const topic = (req.nextUrl.searchParams.get('topic') || '').trim();

  const userId = await requireUser();
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (UNIT_SPENDING.has(action) || (!action && topic)) {
    const rl = await checkRateLimit(userId, 'semrush');
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'rate_limited', limit: rl.limit },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }
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
      const sb = await supabaseServer();
      const { data: { user } } = await sb.auth.getUser();
      if (user) rows = await keywordResearchActivity(user.id, 12);
    } catch {
      // fail-open: empty feed
    }
    return NextResponse.json({ rows }, { headers: { 'Cache-Control': 'no-store' } });
  }

  if (action === 'movers') {
    const domain = normalizeDomain(req.nextUrl.searchParams.get('domain') || '') || primaryDomain();
    const movers = await keywordMovers(domain);
    return NextResponse.json(movers, { headers: { 'Cache-Control': 'private, max-age=300' } });
  }

  if (action === 'advise') {
    // AI Ranking Advisor: turns the (cached) Semrush picture into a
    // prioritized action plan. Spends AI credits → auth + rate limit.
    const rl = await checkRateLimit(userId, 'generate');
    if (!rl.ok) {
      return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });
    }

    const domain = normalizeDomain(req.nextUrl.searchParams.get('domain') || '') || primaryDomain();
    // All of this is cache-first, so composing the context is ~free in units.
    const [bundle, movers, audit] = await Promise.all([domainBundle(domain), keywordMovers(domain), siteAudit()]);

    const lines: string[] = [];
    lines.push('DOMAIN: ' + domain);
    if (bundle.overview) {
      const o = bundle.overview;
      lines.push('OVERVIEW: organic keywords ' + (o.organicKeywords ?? '?') + ', organic traffic ' + (o.organicTraffic ?? '?') + '/mo (value $' + (o.organicCost ?? '?') + '), paid keywords ' + (o.paidKeywords ?? '?') + ', Semrush rank ' + (o.rank ?? '?'));
    }
    if (bundle.backlinks) {
      const b = bundle.backlinks;
      lines.push('AUTHORITY: score ' + (b.authorityScore ?? '?') + '/100, backlinks ' + (b.backlinksTotal ?? '?') + ', referring domains ' + (b.refDomains ?? '?') + ', follow/nofollow ' + (b.follows ?? '?') + '/' + (b.nofollows ?? '?'));
    }
    if (bundle.topKeywords.length) {
      lines.push('TOP RANKING KEYWORDS (pos | volume | KD | traffic% | url):');
      for (const k of bundle.topKeywords.slice(0, 25)) {
        lines.push('- "' + k.keyword + '" | pos ' + (k.position ?? '?') + ' | ' + (k.volume ?? '?') + '/mo | KD ' + (k.difficulty ?? '?') + ' | ' + (k.trafficPct != null ? k.trafficPct.toFixed(2) + '%' : '?') + ' | ' + k.url);
      }
    }
    const mv = (label: string, rows: { keyword: string; position: number | null; volume: number | null }[]) =>
      rows.length ? label + ': ' + rows.map((r) => '"' + r.keyword + '" (pos ' + (r.position ?? '—') + ', ' + (r.volume ?? '?') + '/mo)').join('; ') : '';
    const mvLines = [mv('NEW RANKINGS', movers.newKeywords), mv('LOST RANKINGS', movers.lostKeywords), mv('IMPROVED', movers.improved), mv('DECLINED', movers.declined)].filter(Boolean);
    lines.push(...mvLines);
    if (bundle.competitors.length) {
      lines.push('ORGANIC COMPETITORS: ' + bundle.competitors.map((c) => c.domain + ' (' + (c.commonKeywords ?? '?') + ' common kw, ' + (c.organicTraffic ?? '?') + ' traffic)').join('; '));
    }
    if (audit.data.configured && audit.data.health != null) {
      lines.push('SITE AUDIT: health ' + audit.data.health + '%, errors ' + (audit.data.errors ?? '?') + ', warnings ' + (audit.data.warnings ?? '?') + ', pages crawled ' + (audit.data.pagesCrawled ?? '?'));
    }

    const prompt =
      'You are an expert SEO strategist for a physician-led regenerative/stem-cell medicine clinic in Cancun (patients mostly search from the US). ' +
      'Below is REAL Semrush data for the clinic\'s domain. Build a prioritized ranking action plan.\n\n' +
      lines.join('\n') +
      '\n\nReturn STRICT JSON only (no markdown fences, no prose outside JSON) with this shape:\n' +
      '{"summary":"2-3 sentence read of the situation","priorities":[{"rank":1,"category":"content|technical|authority","title":"short title","why":"grounded in the data above, cite numbers","action":"concrete next step","impact":"high|medium|low","effort":"low|medium|high","keywords":["target keywords"],"draftPrompt":"a ready-to-use content-generation prompt for the clinic\'s AI writer, or empty string if not content work"}]}\n' +
      'Rules: 5-7 priorities max, ordered by impact-per-effort. Quick wins first (positions 4-20 with volume). Never invent metrics not present above. Keep medical claims compliant.';

    try {
      const raw = await chatAssistant([{ role: 'user', content: prompt }]);
      let cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      if (!cleaned.startsWith('{')) {
        const s = cleaned.indexOf('{');
        const e = cleaned.lastIndexOf('}');
        if (s !== -1 && e > s) cleaned = cleaned.slice(s, e + 1);
      }
      let plan: any = null;
      try { plan = JSON.parse(cleaned); } catch { plan = null; }
      if (plan && Array.isArray(plan.priorities)) {
        return NextResponse.json({ ok: true, plan, generatedAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
      }
      return NextResponse.json({ ok: true, plan: { summary: raw.slice(0, 2000), priorities: [] }, generatedAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (e: any) {
      return NextResponse.json({ ok: false, error: e?.message || 'advisor failed' }, { status: 500 });
    }
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
