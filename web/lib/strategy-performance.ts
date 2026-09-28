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
// run when it is on one of the run's networks, was published within a few
// days of the run's slot, and its caption opens the same way as the copy the
// run wrote for that network. The keyword_performance view already does the
// same kind of join (supabase/autopilot.sql). Every result says how many posts
// it could and could not measure, so a thin sample is never read as a verdict.
//
// Pure: imports only ./x.ts files.
import { FREQUENCY_PILLARS, BLOG_SLOT_KEY, slotByKey, frequencyPillarById, type MixGroup } from './content-strategy.ts';
import { FORMATS, type PostFormat } from './strategy-variety.ts';

export type PerfRun = {
  id: string;
  /** The template's strategy.slot. */
  slot: string;
  scheduled_for: string;
  angle?: { query?: string | null; format?: string | null } | null;
  /** The copy the run published, per network (the draft pack's channel fields). */
  texts: Record<string, string>;
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

/** Does this metric row look like this run's post? */
export function metricMatchesRun(run: PerfRun, m: PerfMetric): boolean {
  const net = networkOf(m.network);
  const copy = run.texts[net];
  if (!copy) return false;
  if (m.published_at) {
    const dt = new Date(m.published_at).getTime() - new Date(run.scheduled_for).getTime();
    if (!Number.isFinite(dt) || dt < -MATCH_WINDOW_MS || dt > MATCH_WINDOW_MS) return false;
  }
  const a = comparable(copy).slice(0, PREFIX);
  const b = comparable(m.text).slice(0, PREFIX);
  const n = Math.min(a.length, b.length);
  if (n < MIN_MATCH) return false;
  return a.slice(0, n) === b.slice(0, n);
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
export function strategyPerformance(runs: readonly PerfRun[], metrics: readonly PerfMetric[]): StrategyPerformance {
  const claimed = new Set<number>();
  const perRun = new Map<string, { impressions: number; engagement: number; measured: boolean }>();
  // Newest runs first: a recent post is the more likely owner of a recent metric.
  const ordered = [...runs].sort((a, b) => String(b.scheduled_for).localeCompare(String(a.scheduled_for)));
  for (const run of ordered) {
    const acc = { impressions: 0, engagement: 0, measured: false };
    metrics.forEach((m, i) => {
      if (claimed.has(i) || !metricMatchesRun(run, m)) return;
      claimed.add(i);
      acc.measured = true;
      acc.impressions += Number(m.impressions) || 0;
      acc.engagement += Number(m.engagement) || 0;
    });
    perRun.set(run.id, acc);
  }

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

/** The channel copy a draft pack holds, keyed by network. */
export function textsOfPack(pack: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!pack || typeof pack !== 'object') return out;
  const p = pack as Record<string, unknown>;
  for (const k of ['instagram', 'facebook', 'linkedin']) {
    if (typeof p[k] === 'string' && (p[k] as string).trim()) out[k] = p[k] as string;
  }
  return out;
}
