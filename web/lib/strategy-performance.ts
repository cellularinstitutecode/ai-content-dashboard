// web/lib/strategy-performance.ts
// How each pillar of the weekly strategy is actually doing.
//
// Phase 4. Metricool's analytics land in `post_metrics` (the daily sync), but
// that table knows a network, a caption and two numbers — nothing about which
// slot, pillar, angle or caption shape the post came from. The strategy knows
// all of that (template_runs.angle, the template's slot) and nothing about how
// the post did. This joins the two.
//
// THE JOIN IS BY TEXT, deliberately and visibly. Metricool's analytics id is
// not the scheduler id stored on `posts`, so there is no key to join on; the
// one thing both sides share is the caption. A metric row is matched to a
// run when its caption opens the same way as a post the run SENT (the `posts`
// row approveRun wrote for that network — the exact text, and the time
// Metricool was given, which follows a reschedule) and it was published
// within a few days of that time. The draft's pack is not used: it can still
// be edited after approval, and the sent text cannot. The keyword_performance view already does the
// same kind of join (supabase/autopilot.sql). Every result says how many posts
// it could and could not measure, so a thin sample is never read as a verdict.
//
// Pure: imports only ./x.ts files.
import { FREQUENCY_PILLARS, BLOG_SLOT_KEY, slotByKey, frequencyPillarById, type MixGroup } from './content-strategy.ts';
import { FORMATS, type PostFormat } from './strategy-variety.ts';

/** One network's post as it went out: a `posts` row. */
/**
 * One network's post as it went out: a `posts` row. `live` is false for a row
 * still marked pending_review — sent to Metricool as a draft. It may since
 * have been published from Metricool's own review queue, which nothing syncs
 * back; a matching metric is the proof that it was.
 */
export type SentPost = { network: string; text: string; at: string; live?: boolean };

export type PerfRun = {
  id: string;
  /** The template's strategy.slot. */
  slot: string;
  scheduled_for: string;
  angle?: { query?: string | null; format?: string | null } | null;
  /** The live posts the run sent, one per network. A run with none is not counted. */
  sent: SentPost[];
};

export type PerfMetric = {
  network: string;
  text: string | null;
  published_at: string | null;
  impressions: number | null;
  engagement: number | null;
};

/** How long after its slot a post can still be the run's (re-dated, published late). */
const MATCH_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;
/** Characters of the opening compared. Long enough to be distinctive, short enough to survive truncation. */
const PREFIX = 60;
/** Fewer than this many comparable characters is not a match, whatever it says. */
const MIN_MATCH = 30;

/** A caption as comparable text: lower case, letters and digits, single spaces. */
export function comparable(text: string | null | undefined): string {
  return String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/#\S+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function networkOf(n: string): string {
  const s = String(n || '').toLowerCase();
  if (s.includes('insta')) return 'instagram';
  if (s.includes('face') || s === 'fb') return 'facebook';
  if (s.includes('linked')) return 'linkedin';
  return s;
}

function sameOpening(copy: string, text: string | null): boolean {
  const a = comparable(copy).slice(0, PREFIX);
  const b = comparable(text).slice(0, PREFIX);
  const n = Math.min(a.length, b.length);
  if (n < MIN_MATCH) return false;
  return a.slice(0, n) === b.slice(0, n);
}

function nearInTime(sentAt: string, publishedAt: string | null): boolean {
  if (!publishedAt) return true;
  const dt = new Date(publishedAt).getTime() - new Date(sentAt).getTime();
  return Number.isFinite(dt) && dt >= -MATCH_WINDOW_MS && dt <= MATCH_WINDOW_MS;
}

/**
 * Does this metric row look like one of this run's posts?
 *
 * The post for the metric's network when the run sent one there. When the
 * metric's network is not one the run sent to — including 'unknown', which is
 * what the sync stores when Metricool's row names no network — any of the
 * run's posts may match; the caption and the date must still agree.
 */
export function metricMatchesRun(run: PerfRun, m: PerfMetric): boolean {
  return postForMetric(run, m) >= 0;
}

/** Which of the run's sent posts this metric row is, or -1. */
function postForMetric(run: PerfRun, m: PerfMetric): number {
  const net = networkOf(m.network);
  const own = run.sent.map((p, i) => ({ p, i })).filter(({ p }) => networkOf(p.network) === net);
  const candidates = own.length ? own : run.sent.map((p, i) => ({ p, i }));
  const hit = candidates.find(({ p }) => nearInTime(p.at, m.published_at) && sameOpening(p.text, m.text));
  return hit ? hit.i : -1;
}

export type PerfCell = {
  /** Approved runs counted here. */
  posts: number;
  /** Of those, how many had at least one network's numbers. */
  measured: number;
  impressions: number;
  engagement: number;
  /** Per measured post; null when none were measured. */
  avgEngagement: number | null;
  avgImpressions: number | null;
};

export type PillarPerformance = PerfCell & {
  id: string;
  name: string;
  group: MixGroup;
  /** The measured angle with the most engagement, if any. */
  best: { angle: string; engagement: number } | null;
};

export type FormatPerformance = PerfCell & { format: PostFormat; label: string };

export type StrategyPerformance = {
  pillars: PillarPerformance[];
  formats: FormatPerformance[];
  article: PerfCell;
  totals: { posts: number; measured: number; metricsRead: number; metricsMatched: number };
};

function emptyCell(): PerfCell {
  return { posts: 0, measured: 0, impressions: 0, engagement: 0, avgEngagement: null, avgImpressions: null };
}

function finish<T extends PerfCell>(c: T): T {
  c.avgEngagement = c.measured ? Math.round((c.engagement / c.measured) * 10) / 10 : null;
  c.avgImpressions = c.measured ? Math.round(c.impressions / c.measured) : null;
  return c;
}

/**
 * Each run's numbers (summed over its networks) and the pillar, shape and
 * article totals. A metric row is claimed by at most one run, so two slots
 * that opened alike cannot both count the same post.
 */
export function strategyPerformance(allRuns: readonly PerfRun[], metrics: readonly PerfMetric[]): StrategyPerformance {
  // Only runs with a post that actually went out. A Metricool draft, a post
  // still in the future or an approval that never sent is not "published",
  // and counting it made the unmeasured share look like a sync problem.
  const candidates = allRuns.filter((r) => r.sent.length > 0);
  const claimed = new Set<number>();
  const perRun = new Map<string, { impressions: number; engagement: number; measured: boolean }>();
  // Newest runs first: a recent post is the more likely owner of a recent metric.
  const ordered = [...candidates].sort((a, b) => String(b.scheduled_for).localeCompare(String(a.scheduled_for)));
  for (const run of ordered) {
    const acc = { impressions: 0, engagement: 0, measured: false };
    // ONE metric row per sent post. The same post can be stored twice (a
    // key that changed between syncs, a network spelled two ways); every
    // copy is claimed so no other run can take it, but only the one with
    // the most engagement — the freshest numbers — is counted.
    const best = new Map<number, PerfMetric>();
    metrics.forEach((m, i) => {
      if (claimed.has(i)) return;
      const post = postForMetric(run, m);
      if (post < 0) return;
      claimed.add(i);
      const cur = best.get(post);
      if (!cur || (Number(m.engagement) || 0) > (Number(cur.engagement) || 0)) best.set(post, m);
    });
    for (const m of best.values()) {
      acc.measured = true;
      acc.impressions += Number(m.impressions) || 0;
      acc.engagement += Number(m.engagement) || 0;
    }
    perRun.set(run.id, acc);
  }
  // Published: a post that is live (approved, and its time has passed), or
  // one Metricool has numbers for — a draft approved in Metricool's own queue
  // went out even though nothing told this app.
  const runs = candidates.filter((r) => r.sent.some((p) => p.live !== false) || perRun.get(r.id)?.measured);

  const pillars = new Map<string, PillarPerformance>(
    FREQUENCY_PILLARS.map((f) => [f.id, { id: f.id, name: f.name, group: f.group, best: null, ...emptyCell() }]),
  );
  const formats = new Map<PostFormat, FormatPerformance>(
    (Object.keys(FORMATS) as PostFormat[]).map((k) => [k, { format: k, label: FORMATS[k].label, ...emptyCell() }]),
  );
  const article = emptyCell();

  const add = (c: PerfCell, r: { impressions: number; engagement: number; measured: boolean }) => {
    c.posts += 1;
    if (!r.measured) return;
    c.measured += 1;
    c.impressions += r.impressions;
    c.engagement += r.engagement;
  };

  let measured = 0;
  for (const run of runs) {
    const r = perRun.get(run.id)!;
    if (r.measured) measured += 1;
    if (run.slot === BLOG_SLOT_KEY) { add(article, r); continue; }
    const slot = slotByKey(run.slot);
    if (!slot) continue;
    // Every row the slot counts towards, primary or integrated — the same
    // rows the brief and the mix count it in.
    for (const tag of slot.tags) {
      const p = pillars.get(tag.freqId);
      if (!p || !frequencyPillarById(tag.freqId)) continue;
      add(p, r);
      const angle = String(run.angle?.query || '').trim();
      if (r.measured && angle && (!p.best || r.engagement > p.best.engagement)) p.best = { angle, engagement: r.engagement };
    }
    const f = run.angle?.format as PostFormat | undefined;
    const fc = f ? formats.get(f) : undefined;
    if (fc) add(fc, r);
  }

  return {
    pillars: [...pillars.values()].map(finish),
    formats: [...formats.values()].filter((f) => f.posts > 0).map(finish),
    article: finish(article),
    totals: { posts: runs.length, measured, metricsRead: metrics.length, metricsMatched: claimed.size },
  };
}

/**
 * Which `posts` rows count as a post that went out: approved (the one status
 * /api/posts treats as live — a plain Approve leaves 'pending_review', a
 * Metricool draft that may never publish) and due by now.
 */
export function isLivePost(row: { status?: string | null; publication_date?: string | null }, now: number = Date.now()): boolean {
  if (String(row.status || '') !== 'approved') return false;
  const t = new Date(String(row.publication_date || '')).getTime();
  return Number.isFinite(t) && t <= now;
}

/**
 * How a `posts` row takes part: 'live' (see isLivePost), 'pending' — a
 * Metricool draft whose time has passed, which counts only if Metricool has
 * numbers for it — or null (still to come, or any other status).
 */
export function sentRowState(row: { status?: string | null; publication_date?: string | null }, now: number = Date.now()): 'live' | 'pending' | null {
  if (isLivePost(row, now)) return 'live';
  if (String(row.status || '') !== 'pending_review') return null;
  const t = new Date(String(row.publication_date || '')).getTime();
  return Number.isFinite(t) && t <= now ? 'pending' : null;
}
