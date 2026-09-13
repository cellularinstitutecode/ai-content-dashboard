// web/lib/autopilot.ts
// The Autopilot Content Engine: turns schedule templates from static text
// into per-occurrence strategies. For every upcoming slot of an active
// template it researches (Semrush brief + domain movers + learnings),
// decides a distinct angle, drafts with the full generation stack (brand
// voice, performance hint, keyword brief), scores the result against a
// rubric with a self-critique retry, and stages it for human review.
//
// It NEVER publishes. Runs stop at ready_for_review; approval (a human
// action) pushes a Metricool DRAFT (autoPublish: false) and a posts row.
//
// Design constraints honored:
// - Cache-first & budget-guarded: every Semrush call goes through the
//   existing unit-floor/cache layer, so a tick can never drain the balance.
// - Idempotent, resumable steps: the daily cron advances each run one state
//   at a time; a failure retries next tick, and unique(template_id,
//   scheduled_for) makes planning re-entrant.
// - Fail-soft: a missing key or empty report degrades the angle choice, it
//   never throws the whole tick.
import { reportError } from '@/lib/report';
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { appliesTo, checkCompliance, complianceMessage, ensureAviso } from '@/lib/compliance';
import { avisoForUser } from '@/lib/compliance-gate';
import { recordApproval } from '@/lib/approval-log';
import { loadBrandContext } from '@/lib/brand-context';
import {
  chatAssistant,
  generateContentPack,
  type BrandContext,
  type ContentPack,
  type ContentType,
} from '@/lib/ai';
import { reviewPack, type SafetyFlag } from '@/lib/safety';
import {
  buildKeywordBrief,
  briefPromptFrom,
  opportunityScore,
  recordDraftKeywords,
  researchBundle,
  type KeywordBrief,
  type SemKeyword,
} from '@/lib/semrush';
import { keywordMovers, primaryDomain, topOrganicKeywords, type KeywordMovers } from '@/lib/semrush-domain';
import { summarizeTopPerformers, type NormalizedMetric } from '@/lib/performance';
import { metricoolSchedulePost, readPostId, type Provider as McProvider } from '@/lib/metricool';
import { ensureDraftImage, type PackImage } from '@/lib/images';
import { SCHEDULE_TZ, upcomingSlots } from '@/lib/timezone';
import { ANTI_REPEAT_DAYS, HORIZON_DAYS, MAX_ATTEMPTS, SCORE_THRESHOLD } from '@/lib/planner-constants';
import { usableLeadHours, leadProblem } from '@/lib/lead-window';
import { videoVerdict, pendingRefusal, type PackLike } from '@/lib/video-required';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StrategyMode = 'off' | 'fixed_topic' | 'pillars' | 'auto';

export type TemplateStrategy = {
  mode: StrategyMode;
  topic?: string;
  pillars?: string[];
  goal?: 'rank' | 'traffic' | 'engagement' | 'authority';
  format?: ContentType;
  lead_hours?: number;
  max_regens?: number;
};

export type AngleType = 'answer' | 'commercial' | 'defense' | 'opportunity';

export type Angle = {
  type: AngleType;
  query: string; // the primary search phrase this post targets
  seedTopic: string; // the pillar/topic the query came from
  rationale: string; // human-readable "why this angle, this week"
  volume: number | null;
  difficulty: number | null;
  intent: string | null;
  // v2 enrichments (all optional, all fail-soft):
  strategistNote?: string; // AI strategist's 2-3 sentence guidance for the writer
  reviewerNote?: string; // human feedback carried into a regeneration
  provenPerformer?: boolean; // boosted by the measured-engagement learning loop
  media?: { url: string; title: string } | null; // matching clip to attach on approve
};

export type RunScore = {
  total: number; // 0-100
  breakdown: Record<string, number>;
  safetyFlags: SafetyFlag[];
  critique: string[];
};

export type TemplateRow = {
  id: string;
  user_id: string;
  name: string;
  providers: string[];
  text: string;
  weekdays: number[];
  time_of_day: string;
  active: boolean;
  strategy: TemplateStrategy | null;
};

export type RunRow = {
  id: string;
  template_id: string;
  user_id: string;
  scheduled_for: string;
  state: string;
  attempts: number;
  regens: number;
  brief: KeywordBrief | null;
  angle: Angle | null;
  score: RunScore | null;
  draft_id: string | null;
  log: { at: string; step: string; note: string }[];
};

const ACTIVE_STATES = ['planned', 'researched', 'drafted'] as const;
// MAX_ATTEMPTS is two, not three. The cron fires once a day and `advanceRuns`
// takes at most one attempt per run per tick, inside an eligibility window that
// is only ever a couple of ticks wide - so with a limit of 3 a broken run could
// never reach `failed`, never showed up under "Needs attention", and simply went
// quiet.
//
// These four moved to lib/planner-constants.ts so the assistant's playbook can
// interpolate them rather than restate them from memory and drift.

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export function normalizeStrategy(raw: unknown): TemplateStrategy {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode: StrategyMode = ['off', 'fixed_topic', 'pillars', 'auto'].includes(String(s.mode))
    ? (String(s.mode) as StrategyMode)
    : 'off';
  const pillars = Array.isArray(s.pillars)
    ? s.pillars.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const goal = ['rank', 'traffic', 'engagement', 'authority'].includes(String(s.goal))
    ? (String(s.goal) as TemplateStrategy['goal'])
    : 'rank';
  const format = ['social', 'blog', 'email', 'video', 'ad'].includes(String(s.format))
    ? (String(s.format) as ContentType)
    : 'social';
  const lead = num(s.lead_hours);
  const regens = num(s.max_regens);
  return {
    mode,
    topic: typeof s.topic === 'string' ? s.topic.trim().slice(0, 200) : undefined,
    pillars,
    goal,
    format,
    lead_hours: lead != null && lead >= 1 && lead <= 96 ? Math.round(lead) : 24,
    max_regens: regens != null && regens >= 0 && regens <= 2 ? Math.round(regens) : 1,
  };
}

function logLine(run: RunRow, step: string, note: string): { at: string; step: string; note: string }[] {
  const entry = { at: new Date().toISOString(), step, note: note.slice(0, 400) };
  const prior = Array.isArray(run.log) ? run.log : [];
  return [...prior.slice(-30), entry];
}

// ---------------------------------------------------------------------------
// Planner: materialize template_runs for upcoming slots.
// ---------------------------------------------------------------------------

export async function planRuns(scopeUserId?: string): Promise<{ planned: number; templates: number }> {
  const db = supabaseAdmin();
  let q = db
    .from('schedule_templates')
    .select('id, user_id, name, providers, text, weekdays, time_of_day, active, strategy')
    .eq('active', true);
  if (scopeUserId) q = q.eq('user_id', scopeUserId);
  // Surface the query error instead of discarding it. A dropped error here read
  // as "no templates", so a missing table or a rotated service-role key made the
  // daily cron answer {ok:true, planned:0} - green in Vercel, dead in reality.
  const { data: templates, error: tplErr } = await q;
  if (tplErr) throw new Error('planRuns: could not read templates - ' + tplErr.message);
  if (!Array.isArray(templates) || templates.length === 0) return { planned: 0, templates: 0 };

  const now = new Date();
  let planned = 0;
  let dynamicTemplates = 0;

  for (const t of templates as TemplateRow[]) {
    const strategy = normalizeStrategy(t.strategy);
    if (strategy.mode === 'off') continue; // static templates keep the old Apply flow
    dynamicTemplates++;
    const weekdays: number[] = Array.isArray(t.weekdays) ? t.weekdays : [];
    if (!weekdays.length) continue;

    // Template times are CLINIC-LOCAL wall-clock times (America/Cancun by
    // default), not server time — Vercel runs in UTC, so the old setHours()
    // approach fired a "09:00" template at 4 AM Cancun.
    const rows = upcomingSlots(weekdays, t.time_of_day || '09:00', HORIZON_DAYS, SCHEDULE_TZ, now)
      .map((slot) => ({ template_id: t.id, user_id: t.user_id, scheduled_for: slot.toISOString() }));
    if (!rows.length) continue;
    // Idempotent: unique(template_id, scheduled_for) — ignore existing runs.
    const { data: inserted, error: insErr } = await db
      .from('template_runs')
      .upsert(rows, { onConflict: 'template_id,scheduled_for', ignoreDuplicates: true })
      .select('id');
    if (insErr) throw new Error('planRuns: could not plan runs - ' + insErr.message);
    planned += Array.isArray(inserted) ? inserted.length : 0;
  }
  return { planned, templates: dynamicTemplates };
}

// ---------------------------------------------------------------------------
// Step 1: research + decide. Gathers live data and picks a distinct angle.
// ---------------------------------------------------------------------------

function pickSeedTopic(strategy: TemplateStrategy, occurrenceIndex: number, seedPool: string[]): string {
  if (strategy.mode === 'fixed_topic' && strategy.topic) return strategy.topic;
  if (seedPool.length) return seedPool[occurrenceIndex % seedPool.length];
  if (strategy.topic) return strategy.topic;
  return 'stem cell therapy';
}

// Full-auto seed discovery: the pool rotates through the user's pillars PLUS
// what the domain data says matters right now — keywords we are losing (write
// to defend) and keywords already earning traffic (write to consolidate).
async function autoSeedPool(pillars: string[], brandKeywords: string[]): Promise<string[]> {
  const pool: string[] = [...pillars];
  try {
    const movers = await keywordMovers(primaryDomain());
    for (const m of [...movers.lostKeywords, ...movers.declined].slice(0, 3)) {
      if (m.keyword) pool.push(m.keyword);
    }
  } catch (err) { /* cache/link-out mode */ reportError('autopilot:keyword-brief', err); }
  try {
    const top = await topOrganicKeywords(primaryDomain(), 30);
    for (const k of top.rows.slice(0, 5)) {
      if (k.keyword && (k.position ?? 99) > 3) pool.push(k.keyword); // consolidate non-#1 winners
    }
  } catch (err) { /* cache/link-out mode */ reportError('autopilot:keyword-questions', err); }
  for (const b of brandKeywords) pool.push(b);
  // Dedupe, keep order.
  const seen = new Set<string>();
  return pool.filter((p) => {
    const key = p.toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isCommercial(k: SemKeyword): boolean {
  return k.intents.includes('commercial') || k.intents.includes('transactional');
}

function usable(k: SemKeyword | null | undefined, recent: Set<string>): k is SemKeyword {
  return Boolean(k && k.keyword && !recent.has(k.keyword.toLowerCase()));
}

// The rotation: consecutive occurrences of the same template get different
// jobs. Order is rotated by occurrence index; unavailable angles fall through.
function decideAngle(
  occurrenceIndex: number,
  seedTopic: string,
  brief: KeywordBrief,
  questions: SemKeyword[],
  movers: KeywordMovers | null,
  recent: Set<string>,
  learned: Map<string, number> = new Map()
): Angle {
  const related = [brief.primary, ...brief.supporting].filter((k): k is SemKeyword => Boolean(k));
  // Learning loop: keywords that measurably earned engagement for THIS
  // audience get a boost on top of the volume-vs-difficulty score.
  const learnBoost = (k: SemKeyword): number => {
    let boost = 0;
    for (const [kw, eng] of learned) {
      if (k.keyword.toLowerCase().includes(kw) || kw.includes(k.keyword.toLowerCase())) {
        boost = Math.max(boost, Math.log10(1 + eng) * 10);
      }
    }
    return boost;
  };
  const byOpportunity = [...related].sort(
    (a, b) => opportunityScore(b) + learnBoost(b) - (opportunityScore(a) + learnBoost(a))
  );

  const candidates: (Angle | null)[] = [];

  // answer: a real searcher question we can own.
  const q = [...questions, ...brief.questions].find((k) => usable(k, recent));
  candidates.push(
    q
      ? {
          type: 'answer',
          query: q.keyword,
          seedTopic,
          rationale:
            'Real searcher question "' + q.keyword + '"' +
            (q.volume != null ? ' (' + q.volume + '/mo' + (q.difficulty != null ? ', KD ' + q.difficulty : '') + ')' : '') +
            ' — answering it directly builds topical authority.',
          volume: q.volume,
          difficulty: q.difficulty,
          intent: q.intents.join(', ') || null,
        }
      : null
  );

  // commercial: highest-opportunity commercial/transactional keyword.
  const c = byOpportunity.find((k) => usable(k, recent) && isCommercial(k) && (k.difficulty == null || k.difficulty < 60));
  candidates.push(
    c
      ? {
          type: 'commercial',
          query: c.keyword,
          seedTopic,
          rationale:
            'Commercial-intent opportunity "' + c.keyword + '"' +
            (c.volume != null ? ' (' + c.volume + '/mo, KD ' + (c.difficulty ?? '?') + ')' : '') +
            ' — winnable difficulty with buying intent.',
          volume: c.volume,
          difficulty: c.difficulty,
          intent: c.intents.join(', ') || null,
        }
      : null
  );

  // defense: a keyword we just lost or that is falling — defend the ranking.
  const fallen = movers
    ? [...movers.lostKeywords, ...movers.declined]
        .filter((m) => m.keyword && !recent.has(m.keyword.toLowerCase()))
        .sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0]
    : undefined;
  candidates.push(
    fallen
      ? {
          type: 'defense',
          query: fallen.keyword,
          seedTopic,
          rationale:
            'Ranking defense: "' + fallen.keyword + '"' +
            (fallen.volume != null ? ' (' + fallen.volume + '/mo)' : '') +
            (fallen.prevPosition ? ' slipped from #' + fallen.prevPosition : ' dropped out of the top 100') +
            ' — fresh content signals relevance to win it back.',
          volume: fallen.volume,
          difficulty: fallen.difficulty,
          intent: null,
        }
      : null
  );

  // opportunity: best remaining keyword by the clinic-tuned opportunity score
  // (plus the measured-engagement learning boost).
  const o = byOpportunity.find((k) => usable(k, recent));
  const oProven = o ? learnBoost(o) > 0 : false;
  candidates.push(
    o
      ? {
          type: 'opportunity',
          query: o.keyword,
          seedTopic,
          rationale:
            'Top opportunity "' + o.keyword + '"' +
            (o.volume != null ? ' (' + o.volume + '/mo, KD ' + (o.difficulty ?? '?') + ')' : '') +
            ' by the volume-vs-difficulty score' +
            (oProven ? ' — related posts already earned measurable engagement with your audience.' : '.'),
          volume: o.volume,
          difficulty: o.difficulty,
          intent: o.intents.join(', ') || null,
          provenPerformer: oProven,
        }
      : null
  );

  const available = candidates.filter((a): a is Angle => Boolean(a));
  if (!available.length) {
    return {
      type: 'opportunity',
      query: seedTopic,
      seedTopic,
      rationale: 'No fresh keyword data available — writing on the pillar topic itself (cache/link-out mode).',
      volume: null,
      difficulty: null,
      intent: null,
    };
  }
  // Rotate the starting angle by occurrence so week 1..4 differ, then take
  // the first available from that rotation.
  const order: AngleType[] = ['answer', 'commercial', 'defense', 'opportunity'];
  const start = occurrenceIndex % order.length;
  for (let i = 0; i < order.length; i++) {
    const want = order[(start + i) % order.length];
    const hit = available.find((a) => a.type === want);
    if (hit) return hit;
  }
  return available[0];
}

async function stepResearch(run: RunRow, template: TemplateRow, strategy: TemplateStrategy): Promise<Partial<RunRow>> {
  const db = supabaseAdmin();

  // Occurrence index: how many runs of this template came before this slot.
  const { count, error: countError } = await db
    .from('template_runs')
    .select('id', { count: 'exact', head: true })
    .eq('template_id', run.template_id)
    .lt('scheduled_for', run.scheduled_for);
  // THE ONE THAT MAKES ROTATION COLLAPSE. Unread, a failed count gives null →
  // occurrenceIndex 0 → pickSeedTopic always returns seedPool[0] and decideAngle
  // always starts at the same angle type. Every post, every week, the same
  // pillar — and nothing anywhere says why. The index is otherwise structurally
  // sound: rows are never deleted and planRuns only ever creates future slots,
  // so this dropped error was the sole way it could go constant.
  if (countError) reportError('autopilot:occurrence-count', countError, { runId: run.id });
  const occurrenceIndex = count ?? 0;

  // Brand keywords as pillar fallback.
  let brandKeywords: string[] = [];
  try {
    const { data: bp, error: bpError } = await db
      .from('brand_profiles').select('keywords').eq('user_id', run.user_id).maybeSingle();
    // supabase-js RESOLVES a failed read, so this catch never fired for a
    // database error. Losing the brand keywords drops the pillar fallback, and
    // pickSeedTopic then falls all the way through to a hardcoded topic.
    if (bpError) reportError('autopilot:brand-keywords', bpError, { runId: run.id });
    if (bp && Array.isArray((bp as { keywords?: string[] }).keywords)) {
      brandKeywords = ((bp as { keywords?: string[] }).keywords || []).filter(Boolean);
    }
  } catch (err) { /* optional */ reportError('autopilot:brand-load', err); }

  // Seed pool: pillars for 'pillars' mode; pillars + live domain data
  // (lost/declining keywords, consolidatable winners) for full 'auto'.
  let seedPool = (strategy.pillars || []).length ? [...(strategy.pillars as string[])] : [...brandKeywords];
  if (strategy.mode === 'auto') {
    seedPool = await autoSeedPool(strategy.pillars || [], brandKeywords);
  }
  const seedTopic = pickSeedTopic(strategy, occurrenceIndex, seedPool);

  // Anti-repetition: primary keywords used in the last 30 days.
  const recent = new Set<string>();
  try {
    const since = new Date(Date.now() - ANTI_REPEAT_DAYS * 24 * 60 * 60 * 1000).toISOString();
    // `topic`, not `keyword`.
    //
    // decideAngle filters candidate angle.query values against this set, and
    // angle.query is what recordDraftKeywords stores in the TOPIC column
    // (lib/semrush.ts): `role: 'primary'` marks the brief's own primary keyword,
    // which is a different string chosen from the research. So comparing
    // queries against keywords almost never matched, and the anti-repeat was
    // inert on the normal Semrush path — every fourth occurrence re-ran the
    // identical query with the identical rationale, indefinitely. It appeared to
    // work only in the degraded cache-only branch, which does store the query.
    const { data: used, error: usedError } = await db
      .from('draft_keywords')
      .select('topic')
      .eq('user_id', run.user_id)
      .gte('created_at', since)
      .limit(400);
    if (usedError) reportError('autopilot:draft-keywords', usedError, { runId: run.id });
    for (const r of used || []) recent.add(String((r as { topic: string }).topic || '').toLowerCase());
  } catch (err) { /* table optional */ reportError('autopilot:draft-keywords', err); }

  // Learning loop: measured engagement per primary keyword (view joins
  // draft_keywords × post_metrics). Empty until posts get measured — fail-soft.
  const learned = new Map<string, number>();
  try {
    const { data: perf, error: perfError } = await db
      .from('keyword_performance')
      .select('keyword, total_engagement')
      .eq('user_id', run.user_id)
      .order('total_engagement', { ascending: false })
      .limit(50);
    // Unread, this silently reverted the whole measured-engagement learning
    // loop to a plain volume/difficulty sort, with provenPerformer always false.
    if (perfError) reportError('autopilot:keyword-performance', perfError, { runId: run.id });
    for (const r of perf || []) {
      const kw = String((r as { keyword: string }).keyword || '').toLowerCase();
      const eng = Number((r as { total_engagement: number }).total_engagement) || 0;
      if (kw && eng > 0) learned.set(kw, eng);
    }
  } catch (err) { /* view optional */ reportError('autopilot:keyword-performance', err); }

  // Live data (all cache-first + unit-floor guarded).
  const bundle = await researchBundle(seedTopic, { relatedLimit: 12, questionLimit: 6 });
  let movers: KeywordMovers | null = null;
  try {
    movers = await keywordMovers(primaryDomain());
  } catch { movers = null; }

  // bundle.questions, not bundle.brief.questions.
  //
  // The 4th parameter is concatenated with `brief.questions` inside decideAngle,
  // so passing the brief's own slice meant the SAME array joined to itself: the
  // six question keywords fetched and paid for were narrowed back to three, and
  // the wider `related` set never reached the angle picker at all.
  const angle = decideAngle(occurrenceIndex, seedTopic, bundle.brief, bundle.questions, movers, recent, learned);

  // AI strategist note: 2-3 sentences of editorial direction for the writer,
  // grounded in the chosen angle. Purely additive — skipped without API keys.
  try {
    const note = await chatAssistant([
      {
        role: 'user',
        content:
          'In 2-3 short sentences, give editorial direction for a ' +
          (strategy.format || 'social') + ' post targeting the search "' + angle.query +
          '" (angle: ' + angle.type + '; rationale: ' + angle.rationale +
          '). What should the writer emphasize and avoid? Be specific and compliant — no medical claims. Plain text only.',
      },
    ]);
    if (note && note.trim()) angle.strategistNote = note.trim().slice(0, 500);
  } catch (err) { /* optional */ reportError('autopilot:recent-angles', err); }

  return {
    state: 'researched',
    brief: bundle.brief.source === 'semrush' ? bundle.brief : null,
    angle,
    log: logLine(run, 'research', 'Angle: ' + angle.type + ' → "' + angle.query + '". ' + angle.rationale),
  };
}

// ---------------------------------------------------------------------------
// Step 2: draft with the full generation stack.
// ---------------------------------------------------------------------------

const GOAL_INSTRUCTION: Record<NonNullable<TemplateStrategy['goal']>, string> = {
  rank: 'Optimize to rank: use the primary phrase naturally in the opening and body.',
  traffic: 'Optimize for clicks: strong curiosity hook, clear promise of value.',
  engagement: 'Optimize for engagement: end with a question or conversation starter.',
  authority: 'Optimize for authority: cite the clinical perspective, measured tone.',
};

function topicPromptFor(angle: Angle, strategy: TemplateStrategy): string {
  const parts = [
    'Write about: ' + angle.query + '.',
    'Content pillar: ' + angle.seedTopic + '.',
    'Editorial angle (' + angle.type + '): ' + angle.rationale,
    GOAL_INSTRUCTION[strategy.goal || 'rank'],
  ];
  if (angle.strategistNote) parts.push('Strategist direction: ' + angle.strategistNote);
  if (angle.reviewerNote) parts.push('REVIEWER FEEDBACK (must address): ' + angle.reviewerNote);
  return parts.join(' ');
}

// Media enrichment: find the user's best matching finished clip for an angle.
// clips.result is the OpusClip webhook payload (title/text/hashtags + mp4 urls).
async function findMatchingClip(
  userId: string,
  angle: Angle
): Promise<{ url: string; title: string } | null> {
  try {
    const db = supabaseAdmin();
    const { data: rows, error: rowsError } = await db
      .from('clips')
      .select('result')
      .eq('user_id', userId)
      .not('result', 'is', null)
      .order('created_at', { ascending: false })
      .limit(10);
    // Unread, a failed read looked identical to "there are no clips" and the
    // post shipped without one.
    if (rowsError) reportError('autopilot:clip-match', rowsError, { userId });
    const words = angle.query.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    let best: { url: string; title: string; score: number } | null = null;
    for (const row of rows || []) {
      const clips = (row as { result?: unknown }).result;
      if (!Array.isArray(clips)) continue;
      for (const c of clips as Record<string, unknown>[]) {
        const url = String(c.export || c.preview || '');
        if (!url) continue;
        const hay = (String(c.title || '') + ' ' + String(c.text || '') + ' ' + String(c.description || '') + ' ' + String(c.hashtags || '')).toLowerCase();
        const score = words.filter((w) => hay.includes(w)).length;
        if (score > 0 && (!best || score > best.score)) {
          best = { url, title: String(c.title || 'Clip'), score };
        }
      }
    }
    return best ? { url: best.url, title: best.title } : null;
  } catch {
    return null;
  }
}

async function stepDraft(run: RunRow, template: TemplateRow, strategy: TemplateStrategy): Promise<Partial<RunRow>> {
  const db = supabaseAdmin();
  const angle = run.angle as Angle;
  if (!angle) throw new Error('run has no angle');

  // Brief for the CHOSEN query (cache-first; distinct from the seed brief).
  // Falls back to the seed-topic brief already gathered at research time so
  // the model still writes with real numbers in cache-only mode.
  let brief: KeywordBrief | null = null;
  let hint = '';
  try {
    brief = await buildKeywordBrief(angle.query);
    if (brief.source === 'semrush') hint = briefPromptFrom(brief);
    else brief = null;
  } catch { brief = null; }
  if (!brief && run.brief && run.brief.source === 'semrush') {
    hint = briefPromptFrom(run.brief);
  }

  // Brand voice.
  let brand: BrandContext | undefined;
  try {
    const { data: bp, error: brandError } = await db
      .from('brand_profiles')
      .select('*')
      .eq('user_id', run.user_id)
      .maybeSingle();
    // Unread, this generated the post with NO brand voice at all and said
    // nothing. (The catch also carried the wrong label — 'media-match' — so even
    // a thrown error was filed under another operation.)
    if (brandError) reportError('autopilot:brand-load', brandError, { runId: run.id });
    if (bp) brand = bp as BrandContext;
  } catch (err) { /* optional */ reportError('autopilot:brand-load', err); }

  // Performance hint from measured posts.
  let performanceHint: string | undefined;
  try {
    const { data: rows, error: metricsError } = await db
      .from('post_metrics')
      .select('network, external_id, text, published_at, impressions, engagement')
      .eq('user_id', run.user_id)
      .order('engagement', { ascending: false })
      .limit(5);
    if (metricsError) reportError('autopilot:performance-hint', metricsError, { runId: run.id });
    if (rows && rows.length) {
      const metrics: NormalizedMetric[] = (rows as Record<string, unknown>[]).map((r) => ({
        network: String(r.network || ''),
        externalId: (r.external_id as string) ?? null,
        text: (r.text as string) ?? null,
        publishedAt: (r.published_at as string) ?? null,
        impressions: Number(r.impressions) || 0,
        engagement: Number(r.engagement) || 0,
      }));
      performanceHint = summarizeTopPerformers(metrics) || undefined;
    }
  } catch (err) { /* optional */ reportError('autopilot:clip-lookup', err); }

  const { provider, pack } = await generateContentPack({
    topic: topicPromptFor(angle, strategy),
    contentType: strategy.format || 'social',
    channels: template.providers,
    brand,
    performanceHint,
    // Pass the prepared hint ('' = researched, nothing found) so the
    // generator does not run a second, redundant Semrush lookup.
    keywordHint: hint,
  });

  // Stamp autopilot provenance on the pack (same pattern as _semrush).
  (pack as ContentPack & { _autopilot?: Record<string, unknown> })._autopilot = {
    run_id: run.id,
    template_id: run.template_id,
    template_name: template.name,
    scheduled_for: run.scheduled_for,
    angle,
  };

  // Media enrichment: remember the best matching finished clip so approval
  // can attach it to the Metricool draft. Purely additive.
  const media = await findMatchingClip(run.user_id, angle);
  const angleOut: Angle = { ...angle, media };

  // Reuse the existing draft row on regeneration so the library doesn't
  // accumulate orphans; insert on first pass.
  let draftId = run.draft_id;
  if (draftId) {
    // Carry the verified hero image across a redraft. This wrote the fresh
    // pack with no spread, so "Ask for changes" silently destroyed `_image`:
    // the review card lost its picture, the stored file was orphaned, and
    // approval regenerated from variant 0 (burning a second image credit and
    // breaking the "every reroll is a visibly different take" guarantee).
    // The angle is unchanged by a redraft, so the image stays on-topic.
    const { data: prior, error: priorError } = await db
      .from('drafts').select('pack').eq('id', draftId).eq('user_id', run.user_id).maybeSingle();
    // Unread, this dropped _image on every redraft — exactly the bug the comment
    // above says it fixes.
    if (priorError) reportError('autopilot:prior-image', priorError, { runId: run.id });
    const priorImage = (prior as { pack?: { _image?: unknown } } | null)?.pack?._image;
    const nextPack = priorImage && !(pack as { _image?: unknown })._image
      ? { ...(pack as Record<string, unknown>), _image: priorImage }
      : pack;
    const { error } = await db
      .from('drafts').update({ pack: nextPack, provider })
      .eq('id', draftId).eq('user_id', run.user_id);
    if (error) throw new Error('draft update failed: ' + error.message);
  } else {
    const { data: draft, error } = await db
      .from('drafts')
      .insert({
        user_id: run.user_id,
        topic: '[Autopilot] ' + angle.query,
        goal: strategy.goal || 'rank',
        channels: template.providers || [],
        pack,
        provider,
      })
      .select('id')
      .single();
    if (error) throw new Error('draft insert failed: ' + error.message);
    draftId = (draft as { id: string }).id;
  }

  // Learnings: log the applied keywords for the feedback loop. When the
  // chosen query has no brief of its own (cache-only mode), still record the
  // primary from the angle's data — anti-repetition and the learning view
  // both depend on this row existing.
  if (brief) {
    // Was fire-and-forget: on Vercel the lambda can freeze once the response
    // is returned, so this insert was lost non-deterministically — and it is
    // the row anti-repetition reads. The else-branch already awaited.
    await recordDraftKeywords(run.user_id, angle.query, brief);
  } else {
    try {
      await db.from('draft_keywords').insert({
        user_id: run.user_id,
        topic: angle.seedTopic,
        keyword: angle.query,
        volume: angle.volume != null ? Math.round(angle.volume) : null,
        difficulty: angle.difficulty != null ? Math.round(angle.difficulty) : null,
        intent: angle.intent,
        role: 'primary',
      });
    } catch (err) { /* learnings are best-effort */ reportError('autopilot:record-learnings', err); }
  }

  return {
    state: 'drafted',
    draft_id: draftId,
    angle: angleOut,
    brief: brief ?? run.brief,
    log: logLine(
      run,
      'draft',
      'Drafted via ' + provider + ' for channels: ' + (template.providers || []).join(', ') +
        (media ? ' — matched clip "' + media.title + '" will attach on approval' : '')
    ),
  };
}

// ---------------------------------------------------------------------------
// Step 3: score against the rubric; one self-critique regeneration if weak.
// ---------------------------------------------------------------------------

const CTA_RE = /\b(book|schedule|contact|call|visit|learn more|read more|watch|subscribe|sign up|reach out|dm us|link in bio)\b/i;

function channelText(pack: ContentPack, provider: string): string {
  const key = provider === 'twitter' ? 'instagram' : provider; // closest fit
  const p = pack as unknown as Record<string, string>;
  return String(p[key] || p.instagram || p.blog || '');
}

export function scorePack(pack: ContentPack, providers: string[], angle: Angle): RunScore {
  const texts = (providers.length ? providers : ['instagram']).map((p) => channelText(pack, p));
  const joined = texts.join('\n').toLowerCase();
  const critique: string[] = [];
  const breakdown: Record<string, number> = {};

  // Keyword coverage (0-30): primary phrase (or most of its words) present.
  const query = angle.query.toLowerCase().trim();
  const words = query.split(/\s+/).filter((w) => w.length > 2);
  const covered = words.length ? words.filter((w) => joined.includes(w)).length / words.length : 0;
  // `joined.includes('')` is TRUE, so a blank query — reachable from a Semrush
  // row with an empty keyword — scored a perfect 30/30 for covering nothing.
  breakdown.keyword = !query ? 0 : Math.round(30 * (joined.includes(query) ? 1 : covered));
  if (breakdown.keyword < 18) critique.push('Work the exact phrase "' + angle.query + '" naturally into the opening.');

  // Channel completeness (0-25): every requested channel has real copy.
  const complete = texts.filter((t) => t.trim().length >= 80).length;
  breakdown.channels = Math.round(25 * (texts.length ? complete / texts.length : 0));
  if (breakdown.channels < 25) critique.push('One or more channels came back empty or too short — write full copy for each.');

  // Hook (0-20): first line short and strong.
  const firstLine = (texts[0] || '').split('\n').find((l) => l.trim()) || '';
  breakdown.hook = firstLine && firstLine.length <= 140 ? 20 : firstLine ? 10 : 0;
  if (breakdown.hook < 20) critique.push('Open with a one-line scroll-stopping hook under 140 characters.');

  // CTA (0-15).
  breakdown.cta = CTA_RE.test(joined) ? 15 : 0;
  if (!breakdown.cta) critique.push('Close with a clear, compliant call to action.');

  // Safety (0-10): advisory flags cost points and surface to the reviewer.
  const safetyFlags = reviewPack(pack as unknown as Record<string, unknown>);
  breakdown.safety = Math.max(0, 10 - safetyFlags.length * 5);
  if (safetyFlags.length) critique.push('Rephrase flagged passages: ' + safetyFlags.map((f) => f.code).join(', ') + '.');

  const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
  return { total, breakdown, safetyFlags, critique };
}

async function stepScore(run: RunRow, template: TemplateRow, strategy: TemplateStrategy): Promise<Partial<RunRow>> {
  const db = supabaseAdmin();
  const angle = run.angle as Angle;
  if (!run.draft_id || !angle) throw new Error('run has no draft to score');

  const { data: draftRow, error } = await db
    // .eq('user_id') as well as the id: draft_id is a client-writable column on
    // template_runs, so it is not on its own proof of ownership.
    .from('drafts').select('id, pack, provider').eq('id', run.draft_id).eq('user_id', run.user_id).single();
  if (error || !draftRow) throw new Error('draft not found for scoring');
  let pack = (draftRow as { pack: ContentPack }).pack;
  let score = scorePack(pack, template.providers || [], angle);
  let regens = run.regens;

  // Self-critique: one bounded regeneration when below threshold.
  if (score.total < SCORE_THRESHOLD && regens < (strategy.max_regens ?? 1)) {
    regens++;
    try {
      const critiqueNote =
        topicPromptFor(angle, strategy) +
        ' Previous attempt scored ' + score.total + '/100. Fix exactly these issues: ' +
        score.critique.join(' ');
      // WITH the brand voice, and without suppressing the keyword brief.
      //
      // The retry passed neither, while the first pass passes both. scorePack
      // measures keyword coverage, channel completeness, hook length, CTA and
      // safety — it does NOT measure voice. So a retry that was off-brand but
      // repeated the phrase more often scored higher, won the comparison below,
      // and replaced the on-brand draft with something the rubric was blind to.
      //
      // keywordHint is left UNDEFINED rather than '': generateContentPack runs
      // its own auto-brief when the field is absent and skips it when the field
      // is an empty string, so '' was explicitly turning the research off.
      const brand = await loadBrandContext(db, run.user_id);
      const { pack: retry } = await generateContentPack({
        topic: critiqueNote,
        contentType: strategy.format || 'social',
        channels: template.providers,
        brand,
      });
      const retryScore = scorePack(retry, template.providers || [], angle);
      if (retryScore.total > score.total) {
        (retry as ContentPack & { _autopilot?: unknown })._autopilot =
          (pack as ContentPack & { _autopilot?: unknown })._autopilot;
        const { error: saveError } = await db.from('drafts').update({ pack: retry })
          .eq('id', run.draft_id).eq('user_id', run.user_id);
        // Read, not assumed. Unread, the SCORE was persisted while the pack was
        // not: the review card showed 81 and the copy stored — and later
        // published — was the one that scored 52.
        if (saveError) {
          reportError('autopilot:regen-save', saveError, { runId: run.id });
        } else {
          pack = retry;
          score = retryScore;
        }
      }
    } catch (err) { /* keep the original pack+score */ reportError('autopilot:regen-rescore', err); }
  }

  return {
    state: 'ready_for_review',
    score,
    regens,
    log: logLine(
      run,
      'score',
      'Scored ' + score.total + '/100 (' +
        Object.entries(score.breakdown).map(([k, v]) => k + ' ' + v).join(', ') + ')' +
        (score.safetyFlags.length ? ' — ' + score.safetyFlags.length + ' safety flag(s) for review' : '')
    ),
  };
}

// ---------------------------------------------------------------------------
// Sweeper: close out runs whose moment has passed.
// ---------------------------------------------------------------------------

/**
 * Mark still-active runs whose scheduled time has gone by as failed.
 *
 * Without this a run that stalled - a step that kept timing out, a template
 * that stopped being eligible - sat in `planned`/`researched` forever: past its
 * slot, excluded from the advancer, and filtered out of the queue's own listing,
 * so the post never happened and nothing told anyone. `failed` is the state the
 * UI already surfaces as "Needs attention", and `regenerateRun` accepts it, so
 * the reviewer can retry it by hand.
 */
/**
 * Rescue runs stranded in `approved`.
 *
 * `approved` is claimed BEFORE the expensive work — an image generation, media
 * normalisation and the Metricool POST. A thrown error releases the claim; a
 * PLATFORM KILL does not. And nothing else can reach the run afterwards:
 * approveRun requires ready_for_review, regenerateRun rejects it, skipRun
 * refuses it, and neither advanceRuns nor expireStaleRuns selects it. So the run
 * disappears from the queue with nothing published and no way back short of SQL.
 *
 * A run that got far enough to record a Metricool post is NOT rescued — that one
 * really was approved, and putting it back would invite a second post for the
 * same slot.
 */
export async function rescueStrandedApprovals(scopeUserId?: string): Promise<number> {
  const db = supabaseAdmin();
  // Comfortably longer than the approve path's own ceiling, so a slow-but-alive
  // approval is never interrupted by this.
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  let q = db
    .from('template_runs')
    // draft_id too: the check below needs it to tell a genuinely-approved run
    // from one that died before reaching Metricool.
    .select('id, log, state, updated_at, draft_id')
    .eq('state', 'approved')
    .lt('updated_at', cutoff)
    .limit(50);
  if (scopeUserId) q = q.eq('user_id', scopeUserId);
  const { data, error } = await q;
  if (error) {
    reportError('autopilot:rescue-read', error);
    return 0;
  }

  let rescued = 0;
  type Stranded = { id: string; log: RunRow['log']; state: string; draft_id: string | null };
  for (const row of (data || []) as unknown as Stranded[]) {
    // Did this one actually reach Metricool? If a posts row exists for the run's
    // draft, the approval went through and the run is correctly terminal.
    const { data: post, error: postError } = await db
      .from('posts')
      .select('id')
      .eq('draft_id', row.draft_id || '')
      .limit(1)
      .maybeSingle();
    if (postError) {
      reportError('autopilot:rescue-post-check', postError, { runId: row.id });
      continue;
    }
    if (post) continue;

    const { data: updated, error: writeError } = await db
      .from('template_runs')
      .update({
        state: 'ready_for_review',
        log: logLine(row as unknown as RunRow, 'rescued', 'Approval stopped part-way through and left nothing published, so this is back in your queue. Approve it again.'),
      })
      .eq('id', row.id)
      .eq('state', 'approved')
      .select('id');
    if (writeError) {
      reportError('autopilot:rescue-write', writeError, { runId: row.id });
      continue;
    }
    if (Array.isArray(updated) && updated.length) rescued++;
  }
  return rescued;
}

export async function expireStaleRuns(scopeUserId?: string): Promise<number> {
  const db = supabaseAdmin();
  // A couple of hours of grace: a slot that just passed may still be mid-tick.
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  let q = db
    .from('template_runs')
    .select('id, state, log, scheduled_for')
    .in('state', ACTIVE_STATES as unknown as string[])
    .lt('scheduled_for', cutoff)
    .limit(50);
  if (scopeUserId) q = q.eq('user_id', scopeUserId);
  const { data, error } = await q;
  if (error) throw new Error('expireStaleRuns: ' + error.message);

  let expired = 0;
  for (const row of (data || []) as RunRow[]) {
    const { data: updated, error: expireError } = await db
      .from('template_runs')
      .update({
        state: 'failed',
        log: logLine(row, 'expired', 'Its scheduled time passed before this post was ready, so nothing was sent.'),
      })
      .eq('id', row.id)
      .eq('state', row.state)
      .select('id')
      .maybeSingle();
    if (expireError) reportError('autopilot:expire', expireError, { runId: row.id });
    if (updated) expired++;
  }
  return expired;
}

// ---------------------------------------------------------------------------
// The advancer: move due runs forward, one resumable step at a time.
// ---------------------------------------------------------------------------

export async function advanceRuns(opts: {
  scopeUserId?: string;
  runId?: string;
  budgetMs?: number;
  maxRuns?: number;
} = {}): Promise<{ advanced: number; ready: number; errors: number }> {
  const db = supabaseAdmin();
  const deadline = Date.now() + (opts.budgetMs ?? 40_000);

  let q = db
    .from('template_runs')
    .select('*')
    .order('scheduled_for', { ascending: true })
    .limit(opts.maxRuns ?? 4);
  if (opts.runId) {
    // Explicit run-now: allow retrying a failed run too.
    q = q.eq('id', opts.runId).in('state', [...ACTIVE_STATES, 'failed'] as unknown as string[]);
  } else {
    q = q
      .in('state', ACTIVE_STATES as unknown as string[])
      .lt('attempts', MAX_ATTEMPTS)
      // The per-template lead window is enforced below; here just exclude
      // stale past slots (older than a day) from consideration.
      .gte('scheduled_for', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  }
  if (opts.scopeUserId) q = q.eq('user_id', opts.scopeUserId);
  const { data: runs, error: runsErr } = await q;
  if (runsErr) throw new Error('advanceRuns: could not read runs - ' + runsErr.message);

  let advanced = 0, ready = 0, errors = 0;
  for (const raw of (runs || []) as RunRow[]) {
    if (Date.now() > deadline) break;
    const { data: t, error: tError } = await db
      .from('schedule_templates')
      .select('id, user_id, name, providers, text, weekdays, time_of_day, active, strategy')
      .eq('id', raw.template_id)
      .maybeSingle();
    // Unread, a database blip made this `continue` — the run silently skipped
    // with no attempt and no log line, and the tick returned {advanced: 0},
    // indistinguishable from a quiet day. That is the exact complaint the tick
    // route's own header records.
    if (tError) {
      reportError('autopilot:template-read', tError, { runId: raw.id });
      errors++;
      continue;
    }
    if (!t) continue;
    const template = t as TemplateRow;
    const strategy = normalizeStrategy(template.strategy);
    if (strategy.mode === 'off' || !template.active) continue;

    // Respect the lead window unless this is an explicit run-now.
    //
    // RAISED to whatever the daily tick can actually reach. The cron fires once
    // a day and expireStaleRuns retires anything two hours past its slot, so a
    // lead shorter than the gap between the tick and the slot means this
    // `continue` fires on every tick that could still help — and by the next
    // morning the run is already stale and marked failed. Every occurrence,
    // forever, with a message blaming the slot time. lib/lead-window.ts works
    // out the floor; honouring a too-short lead is the one choice that produces
    // a template which silently never runs.
    const slotAt = new Date(raw.scheduled_for);
    const effectiveLead = usableLeadHours(
      strategy.lead_hours ?? 24,
      slotAt.getUTCHours() * 60 + slotAt.getUTCMinutes(),
    );
    const leadMs = effectiveLead * 60 * 60 * 1000;
    if (!opts.runId && slotAt.getTime() - leadMs > Date.now()) continue;

    let run = raw;
    // Explicit retry of a failed run: restart the pipeline from research.
    if (run.state === 'failed') {
      const { data: reset, error: resetError } = await db
        .from('template_runs')
        .update({ state: 'planned', attempts: 0, log: logLine(run, 'retry', 'Manual retry — restarting from research.') })
        .eq('id', run.id)
        // Predicated, so a run somebody else has already moved is left alone.
        .eq('state', 'failed')
        .select('*')
        .maybeSingle();
      // Read, not dropped. Without this a failed reset left run.state as
      // 'failed', the while-guard below (which only admits ACTIVE_STATES) never
      // fired, and "Run now" on a failed run silently did nothing while
      // returning {ok: true, advanced: 0} — indistinguishable from a quiet day.
      if (resetError) {
        reportError('autopilot:retry-reset', resetError, { runId: run.id });
        continue;
      }
      if (!reset) continue;
      run = reset as RunRow;
    }
    // Step until ready (or budget/attempt limits hit) so a single tick can
    // take one run all the way to review.
    while (ACTIVE_STATES.includes(run.state as (typeof ACTIVE_STATES)[number]) && Date.now() < deadline) {
      // Count the attempt BEFORE the step runs.
      //
      // `attempts` used to be incremented only in the catch below. A step that
      // exceeds the function budget is not an exception - the platform kills
      // the process - so the catch never ran, `attempts` never moved, and the
      // run stayed eligible forever. Every following tick then re-ran the same
      // step (roughly a dozen Semrush reports plus a full model call) at full
      // cost, every day, with nothing ever reaching MAX_ATTEMPTS. Claiming the
      // attempt up front makes a timeout cost exactly what a thrown error
      // costs; a successful step resets the counter to 0 in the same write
      // that advances the state.
      const startedFrom = run.state;
      const claimedAttempts = (run.attempts ?? 0) + 1;
      const { data: claimed, error: claimErr } = await db
        .from('template_runs')
        .update({ attempts: claimedAttempts })
        .eq('id', run.id)
        .eq('state', startedFrom)
        .eq('attempts', run.attempts ?? 0)
        .select('*')
        .maybeSingle();
      if (claimErr) throw new Error('advanceRuns: could not claim run - ' + claimErr.message);
      if (!claimed) break; // another worker holds this run
      run = claimed as RunRow;

      try {
        let patch: Partial<RunRow>;
        if (run.state === 'planned') patch = await stepResearch(run, template, strategy);
        else if (run.state === 'researched') patch = await stepDraft(run, template, strategy);
        else patch = await stepScore(run, template, strategy);

        // Conditional on the state we started this step from. Without it, a
        // cron tick and a "Run engine now" click running concurrently both
        // advanced the same run and the second write clobbered the first,
        // leaving log/draft_id inconsistent. Now the loser's write matches
        // no row and it stops instead of corrupting the run.
        const { data: updated, error } = await db
          .from('template_runs')
          .update({ ...patch, attempts: 0 })
          .eq('id', run.id)
          .eq('state', run.state)
          .select('*')
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!updated) break; // another worker advanced this run — leave it alone
        run = updated as RunRow;
        advanced++;
        if (run.state === 'ready_for_review') { ready++; break; }
      } catch (e) {
        errors++;
        // The attempt was already recorded by the claim above.
        const attempts = run.attempts ?? claimedAttempts;
        // CONDITIONAL, like every other transition in this file. This was the
        // one blind write, and it resurrected work a person had cancelled: a
        // reviewer pressing Skip during a long step sets 'skipped', then this
        // handler wrote 'drafted' straight over it — and the run advanced,
        // became approvable, and published. The same race clobbered a
        // concurrent regenerateRun, discarding the reviewer's feedback note.
        //
        // Predicated on the state this loop believes it holds, so a run that
        // somebody else has moved is left exactly where they put it.
        const { error: failError } = await db
          .from('template_runs')
          .update({
            state: attempts >= MAX_ATTEMPTS ? 'failed' : startedFrom,
            log: logLine(run, 'error', e instanceof Error ? e.message : 'step failed'),
          })
          .eq('id', run.id)
          // startedFrom, which the claim above left untouched (it writes only
          // `attempts`) and which the success path predicates on identically.
          .eq('state', startedFrom);
        if (failError) reportError('autopilot:step-error-write', failError, { runId: run.id });
        break;
      }
    }
  }
  return { advanced, ready, errors };
}

// ---------------------------------------------------------------------------
// Approval: the ONLY path that talks to the scheduler — and it stays a draft.
// ---------------------------------------------------------------------------

const MC_PROVIDERS: McProvider[] = [
  'instagram', 'facebook', 'twitter', 'linkedin', 'tiktok',
  'youtube', 'gmb', 'pinterest', 'threads', 'bluesky',
];

export type ApproveOptions = {
  /**
   * true  → the post goes straight into Metricool's live queue and publishes
   *         at the run's slot (the reviewer pressed "Approve & schedule");
   * false → it lands in the review queue as before (the default).
   * Either way a person pressed the button; the engine never sets this.
   */
  schedule?: boolean;
};

/**
 * Put a run that has already been CLAIMED back in the queue.
 *
 * Every early exit after the claim must come through here. `approved` is a
 * one-way trapdoor otherwise: approveRun requires ready_for_review,
 * regenerateRun rejects it, skipRun refuses it, and neither advanceRuns nor
 * expireStaleRuns selects it — so a run left there disappears from the queue
 * with nothing published and no way to reach it short of SQL.
 */
async function releaseClaim(
  db: ReturnType<typeof supabaseAdmin>,
  run: RunRow,
  step: string,
  note: string,
): Promise<void> {
  const { error } = await db
    .from('template_runs')
    .update({ state: 'ready_for_review', log: logLine(run, step, note) })
    .eq('id', run.id)
    .eq('state', 'approved');
  // Read, not assumed. A failed release is exactly the stranding this function
  // exists to prevent, and it must be visible rather than silently leaving the
  // run in `approved` while the caller reports a tidy refusal.
  if (error) reportError('autopilot:release-claim', error, { runId: run.id, step });
}

export async function approveRun(runId: string, userId: string, opts: ApproveOptions = {}): Promise<{ ok: boolean; note: string }> {
  const db = supabaseAdmin();
  const { data: r, error: readError } = await db
    .from('template_runs').select('*').eq('id', runId).eq('user_id', userId).maybeSingle();
  // supabase-js RESOLVES a failed read, so an unread error here returned
  // "run not found" for a run that exists — a lie that makes a reviewer stop
  // trying.
  if (readError) {
    reportError('autopilot:approve-read', readError, { runId });
    return { ok: false, note: 'Could not read that run just now. Nothing was sent; try again in a moment.' };
  }
  const run = r as RunRow | null;
  if (!run) return { ok: false, note: 'run not found' };
  if (run.state !== 'ready_for_review') return { ok: false, note: 'run is not ready for review' };
  if (!run.draft_id) return { ok: false, note: 'run has no draft' };

  // CLAIM FIRST. The read above and the transition at the end used to be
  // separated by up to 60s of image generation and the Metricool POST, with
  // nothing in between guarding the state — so two tabs (or a retry after an
  // edge timeout) both passed the check and both created a Metricool draft
  // and a posts row for the same slot. `posts` has no unique constraint to
  // catch it. This conditional update is the atomic claim: exactly one caller
  // can move ready_for_review -> approved, and the loser stops here having
  // spent nothing. State is set before the handoff rather than after, which
  // matches the existing semantics — a failed Metricool call already left the
  // run approved with an explanatory note.
  const { data: claimed, error: claimError } = await db
    .from('template_runs')
    .update({ state: 'approved' })
    .eq('id', run.id)
    .eq('state', 'ready_for_review')
    .select('id');
  // "Somebody else got there first" and "the write failed" are different
  // answers. Reporting the second as the first told a reviewer their post was
  // already handled when nothing had happened at all.
  if (claimError) {
    reportError('autopilot:approve-claim', claimError, { runId: run.id });
    return { ok: false, note: 'Could not take hold of that run just now. Nothing was sent; try again in a moment.' };
  }
  if (!Array.isArray(claimed) || claimed.length === 0) {
    return { ok: false, note: 'this run was already actioned' };
  }

  // THE READ THAT COULD NOT FAIL QUIETLY.
  //
  // supabase-js resolves a failed query, so an unread error here gave `t = null`
  // and therefore `providers = []`. Everything downstream then reads as a
  // deliberate no-op: appliesTo([]) is false so the COFEPRIS advertising gate is
  // SKIPPED, `if (mcProviders.length)` is false so NOTHING is sent to Metricool,
  // handoffFailed stays false so no compensating write runs — and a posts row is
  // inserted and `{ok: true, note: 'Staged for publishing review.'}` returned.
  // The post sits on the calendar saying "waiting for your approval" and can
  // never publish. This is the exact invariant the comment below claims.
  const { data: t, error: templateError } = await db
    .from('schedule_templates').select('providers, name').eq('id', run.template_id).maybeSingle();
  if (templateError) {
    reportError('autopilot:approve-template', templateError, { runId: run.id });
    await releaseClaim(db, run, 'approve-failed', 'Approval could not proceed: the template could not be read. Returned for review.');
    return { ok: false, note: 'Could not read the template for that run, so nothing was sent. It is back in your queue.' };
  }
  const providers: string[] = (t && Array.isArray((t as { providers?: string[] }).providers))
    ? ((t as { providers?: string[] }).providers as string[])
    : [];
  // A template with no usable network is not something to stage silently.
  if (!providers.length) {
    await releaseClaim(db, run, 'approve-failed', 'Approval could not proceed: the template has no networks selected. Returned for review.');
    return { ok: false, note: 'That template has no networks selected, so there was nowhere to send it. It is back in your queue.' };
  }
  const { data: d, error: draftError } = await db.from('drafts').select('pack').eq('id', run.draft_id).eq('user_id', run.user_id).maybeSingle();
  if (draftError) {
    reportError('autopilot:approve-draft', draftError, { runId: run.id });
    await releaseClaim(db, run, 'approve-failed', 'Approval could not proceed: the draft could not be read. Returned for review.');
    return { ok: false, note: 'Could not read that draft just now, so nothing was sent. It is back in your queue.' };
  }
  const pack = (d as { pack?: ContentPack } | null)?.pack;
  if (!pack) {
    await releaseClaim(db, run, 'approve-failed', 'Approval could not proceed: the draft has no content. Returned for review.');
    return { ok: false, note: 'The draft has no content, so nothing was sent. The run is back in your queue.' };
  }

  const mcProviders = providers.filter((p): p is McProvider => (MC_PROVIDERS as string[]).includes(p));
  // Pick the copy for a network we are actually posting to. This used
  // providers[0], which is whatever the user clicked FIRST in the template
  // editor — including 'blog', which is not a Metricool network. A template
  // with providers ['blog','instagram'] shipped the full long-form article as
  // the Instagram caption (far past the 2,200-char limit) while the
  // purpose-written pack.instagram copy went unused.
  let text = channelText(pack, mcProviders[0] || providers[0] || 'instagram');

  // Advertising rule (lib/compliance.ts): Instagram / Facebook copy must carry
  // the AVISO line and a REF citation. The AVISO is deterministic, so it is
  // added here if the pack predates the rule; a missing REF cannot be invented
  // and returns the run for review with the reason written down.
  if (appliesTo(mcProviders)) {
    const aviso = await avisoForUser(run.user_id);
    text = ensureAviso(text, aviso);
    const check = checkCompliance(text, aviso);
    if (!check.ok) {
      await db
        .from('template_runs')
        .update({
          state: 'ready_for_review',
          log: logLine(run, 'approve-refused', 'Not sent: ' + complianceMessage(check) + ' Edit the draft, then approve again.'),
        })
        .eq('id', run.id)
        .eq('state', 'approved');
      return { ok: false, note: complianceMessage(check) + ' The run is back in your queue.' };
    }
  }

  // And the video rule, at the same door as the advertising rule above.
  //
  // The Autopilot writes its own drafts and none of them is transcribed from a
  // video, so on the ordinary path this never fires. It is here because
  // `template_runs.draft_id` is a column the RLS policy lets a user UPDATE on
  // their own row — the same hole that once made this route hand back another
  // user's pack — so a run CAN be pointed at a video-prepared draft, and with
  // `schedule: true` this function publishes LIVE. A gate that is dead on the
  // happy path and load-bearing on the one that is not is worth its four lines.
  //
  // "Has the video" here means the matched clip, not the hero image: `angle
  // .media.url` is the only video this path can attach, and the image below is
  // a picture.
  const videoRule = videoVerdict(pack as PackLike, Boolean(run.angle?.media?.url));
  if (videoRule.pending) {
    await releaseClaim(db, run, 'approve-refused', 'Not sent: ' + pendingRefusal(videoRule));
    return { ok: false, note: pendingRefusal(videoRule) + ' The run is back in your queue.' };
  }

  // Image enrichment: make sure the draft carries its AI hero image before
  // the handoff, so the Metricool draft ships with a visual. Best-effort —
  // an image failure never blocks approval.
  //
  // HARD RULE at the ship-point: an image the checker flagged for text can
  // NEVER be attached to the Metricool handoff. A text-flagged stored image
  // is treated as missing (ensureDraftImage regenerates it with the next
  // composition variant), and if the regeneration still carries text, the
  // post ships with no image rather than a text-bearing one.
  const shippable = (img: PackImage | null): PackImage | null =>
    img?.verification?.textDetected === true ? null : img;
  let packImage: PackImage | null = shippable(
    (pack as ContentPack & { _image?: PackImage })._image || null
  );
  if (!packImage) {
    try { packImage = shippable(await ensureDraftImage(run.draft_id, run.user_id)); } catch { packImage = null; }
  }

  let note = 'Staged for publishing review.';
  // Did the Metricool handoff actually happen? The local `posts` row exists to
  // mirror Metricool; writing one after a FAILED handoff put a post in the
  // queue and on the calendar marked "waiting for your approval" that had been
  // sent nowhere and would never publish. Every other route in this app
  // ("the two sides can never disagree") refuses to record that state — so
  // does this one now.
  let handoffFailed = false;
  let metricoolPostId: string | null = null;
  // Push a Metricool DRAFT (autoPublish: false) so it lands in the approval
  // queue there too. Fail-soft: missing env just means dashboard-only staging.
  if (mcProviders.length) {
    // A matched video clip wins; otherwise attach the generated hero image.
    const media = run.angle?.media?.url
      ? [{ url: run.angle.media.url }]
      : packImage?.url
        ? [{ url: packImage.url }]
        : [];
    try {
      const created = await metricoolSchedulePost({
        text,
        providers: mcProviders,
        publicationDate: run.scheduled_for,
        media,
      }, opts.schedule ? 'scheduled' : 'review');
      // Keep Metricool's id on our row. Without it the queue's Approve,
      // Reschedule and Delete had nothing to address upstream, so an Autopilot
      // post could only ever be managed inside Metricool.
      metricoolPostId = readPostId(created);
      note =
        (opts.schedule ? 'Approved and SCHEDULED in Metricool for ' : 'Sent to Metricool as a DRAFT for ') + mcProviders.join(', ') +
        (run.angle?.media?.url
          ? ' with clip "' + (run.angle?.media?.title || 'video') + '" attached'
          : packImage?.url
            ? ' with the AI hero image attached'
            : '') +
        (opts.schedule ? ' — Metricool will publish it at the scheduled time.' : ' — press Approve in your queue to publish.');
    } catch (e) {
      handoffFailed = true;
      note = 'Could not send this to Metricool (' + (e instanceof Error ? e.message : 'error') + '). Nothing was scheduled and the run is back in your queue — press Approve again to retry.';
    }
  }

  if (handoffFailed) {
    // Same treatment the empty-draft path above gets: the claim already moved
    // this run to `approved`, and no other transition accepts that state, so
    // leaving it there strands the run with nothing scheduled. Release it so
    // the reviewer can press Approve again once Metricool answers.
    await db
      .from('template_runs')
      .update({ state: 'ready_for_review', log: logLine(run, 'approve-failed', note) })
      .eq('id', run.id)
      .eq('state', 'approved');
    return { ok: false, note };
  }

  const { data: inserted, error: insertError } = await db.from('posts').insert({
    user_id: userId,
    draft_id: run.draft_id,
    providers,
    text,
    publication_date: run.scheduled_for,
    metricool_post_id: metricoolPostId,
    // 'approved' — not 'scheduled' — is the one word /api/posts treats as
    // live. See modeOf() there: 'scheduled' is also the column default and
    // part of Metricool's own vocabulary, so it cannot mean "a person said
    // yes to this".
    status: opts.schedule && mcProviders.length ? 'approved' : 'pending_review',
  }).select('id').maybeSingle();
  // READ, not assumed. The Metricool post already exists at this point — with
  // opts.schedule it is in the LIVE queue with autoPublish: true — so a
  // swallowed error here leaves a post that will publish and that this
  // dashboard has no row for: nothing to approve, reschedule or delete, and
  // `ok: true` returned. templates/apply handles this exact case correctly and
  // says so in a comment; this did not.
  let bookkeeping = '';
  if (insertError) {
    reportError('autopilot:approve-posts-insert', insertError, { runId: run.id, metricoolPostId: metricoolPostId || '' });
    bookkeeping = metricoolPostId
      ? ' NOTE: it is in Metricool but could not be saved to this dashboard, so it will not appear on your calendar here — manage it in Metricool.'
      : ' NOTE: it could not be saved to this dashboard.';
  }
  // A run approved straight to a live slot is also recorded on the team's
  // calendar sheet (best-effort; see lib/approval-log.ts).
  if (opts.schedule && mcProviders.length) {
    // AWAITED, not fire-and-forget. This same file says so 500 lines earlier
    // about recordDraftKeywords: "on Vercel the lambda can freeze once the
    // response is returned, so this insert was lost non-deterministically".
    // Identical construct, same runtime — and this is the audit record for the
    // LIVE-scheduled posts specifically. recordApproval is already fail-soft
    // (it catches and returns false), so awaiting it costs nothing.
    await recordApproval({
      publishDate: run.scheduled_for,
      networks: providers,
      caption: text,
      mediaUrl: run.angle?.media?.url || packImage?.url || '',
      source: 'Autopilot · approve & schedule',
      // The run id is NOT a post id. Falling back to it silently mixed two id
      // spaces in the audit column; an empty cell is honest, a wrong id is not.
      postId: String((inserted as { id?: string } | null)?.id || ''),
    });
  }
  const { error: logError } = await db
    .from('template_runs')
    // State was already set by the claim above; this records the outcome.
    .update({ log: logLine(run, 'approve', note) })
    .eq('id', run.id);
  if (logError) reportError('autopilot:approve-log', logError, { runId: run.id });
  return { ok: true, note: note + bookkeeping };
}

// Reviewer feedback loop: send a run back for a redraft that MUST address
// the note. The existing draft row is reused, the pipeline restarts at the
// draft step with the feedback embedded in the prompt.
export async function regenerateRun(runId: string, userId: string, note?: string): Promise<boolean> {
  const db = supabaseAdmin();
  const { data: r, error: readError } = await db
    .from('template_runs')
    .select('*')
    .eq('id', runId)
    .eq('user_id', userId)
    .maybeSingle();
  if (readError) {
    reportError('autopilot:regenerate-read', readError, { runId });
    return false;
  }
  const run = r as RunRow | null;
  if (!run || !run.angle) return false;
  if (!['ready_for_review', 'drafted', 'failed'].includes(run.state)) return false;
  const angle: Angle = { ...run.angle, reviewerNote: (note || '').trim().slice(0, 500) || run.angle.reviewerNote };
  // Claim the state we READ, exactly as approveRun does. Without the predicate
  // this was a read-then-blind-write: two open tabs, one approving and one
  // regenerating, and the regenerate could rewrite `approved` back to
  // `researched` while approveRun was still inside its ~60s Drive + Metricool
  // handoff. The run then came back for review and got approved a second time -
  // two Metricool drafts and two `posts` rows for one slot, with no unique
  // constraint and no compensating path (skipRun refuses terminal runs).
  const { data: claimed, error: claimError } = await db
    .from('template_runs')
    .update({
      state: 'researched',
      attempts: 0,
      regens: 0,
      angle,
      log: logLine(run, 'regenerate', note ? 'Reviewer asked for changes: ' + note : 'Reviewer asked for a fresh take.'),
    })
    .eq('id', runId)
    .eq('user_id', userId)
    .eq('state', run.state)
    .select('id');
  if (claimError) {
    reportError('autopilot:regenerate-claim', claimError, { runId });
    return false;
  }
  // Lost the race: something else moved this run between our read and write.
  return Array.isArray(claimed) && claimed.length > 0;
}

export async function skipRun(runId: string, userId: string): Promise<boolean> {
  const db = supabaseAdmin();
  const { data: r, error: readError } = await db
    .from('template_runs').select('id, log, state').eq('id', runId).eq('user_id', userId).maybeSingle();
  if (readError) {
    reportError('autopilot:skip-read', readError, { runId });
    return false;
  }
  if (!r) return false;
  // `state` was selected and then never checked, so a stale second tab could
  // skip a run that had ALREADY been approved — the dashboard then reported
  // the post as cancelled while the Metricool draft and the posts row still
  // existed and still shipped. Nothing in the app compensates for that, so
  // refuse instead: a terminal run cannot be skipped.
  const priorState = (r as RunRow).state;
  if (priorState === 'approved' || priorState === 'skipped') return false;
  const { data: skipped, error } = await db
    .from('template_runs')
    .update({ state: 'skipped', log: logLine(r as RunRow, 'skip', 'Skipped by reviewer.') })
    .eq('id', runId)
    // Conditional write: if another tab approved it between the read and
    // here, this matches nothing rather than clobbering the approval.
    .eq('state', priorState)
    .select('id');
  // AND THE RESULT IS RETURNED. The compare-and-swap above was written
  // correctly and then thrown away: `return true` regardless meant that when
  // another tab had already approved the run — the precise case the CAS exists
  // to catch — the reviewer was told "Skipped" for a post that was in Metricool
  // and would ship. A guard whose outcome nobody reads is not a guard.
  if (error) {
    reportError('autopilot:skip', error, { runId });
    return false;
  }
  return Array.isArray(skipped) && skipped.length > 0;
}
