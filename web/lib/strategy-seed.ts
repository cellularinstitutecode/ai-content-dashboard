// web/lib/strategy-seed.ts
// Turning the written strategy into rows of `schedule_templates`.
//
// lib/content-strategy.ts says what the week IS. This says what the database
// should therefore hold, and — the part that matters — what to do when some of
// it is already there.
//
// WHY MATCHING BY NAME. `schedule_templates` has no unique key beyond its id
// (supabase/schema.sql), so pressing "Load the weekly strategy" twice would
// otherwise produce twenty-eight templates and twenty-eight posts a week. The
// name is the only stable handle the seed has, so the seed OWNS its fifteen
// names and updates those rows in place. Anything else in the account is
// somebody's own template and is never touched, never renamed and never
// deactivated by this.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not turn anything on beyond the
// template itself: no posting, no approval, no scheduling. A seeded template
// produces drafts that wait in the review queue, exactly like every other
// template, until the setting that governs that is turned on somewhere else.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { plannedTemplates } from './content-strategy.ts';

/**
 * The networks each of the fourteen SOCIAL slots posts to.
 *
 * Not TikTok or YouTube: those refuse a post with no video (lib/composer.ts),
 * and these fourteen are written posts with a still image. Not `blog`: an
 * article is its own slot with its own format — putting 400 words of one on
 * Instagram is how a calendar becomes spam. The article slot below carries
 * `blog` and its own promos.
 */
export const STRATEGY_PROVIDERS: readonly string[] = ['instagram', 'facebook', 'linkedin'];

/**
 * `authority`, for all of them.
 *
 * The document's own stated aim — "position Cellular Institute as a source of
 * thoughtful, personalized care, not simply a clinic promoting procedures" —
 * is the authority goal in this engine's words: "cite the clinical
 * perspective, measured tone" (GOAL_INSTRUCTION, lib/autopilot.ts).
 */
export const STRATEGY_GOAL = 'authority';

/** A day's lead time, which the engine's hourly tick has many chances to fill. */
export const STRATEGY_LEAD_HOURS = 24;

/**
 * The weekly article: Monday 11:00, on WordPress.
 *
 * On Monday because that is the day the strategy gives to its two medical
 * pillars — diagnosis at 09:00, personalization at 18:00 — so the long read and
 * the week's short posts circle the same territory. At 11:00 because 08:00 and
 * 17:00 belong to the reels and 09:00 and 18:00 to the social slots.
 *
 * It carries `blog` AND the three social networks: one pack produces the
 * article and three short promo posts pointing at it, which is what the format
 * already does (lib/ai.ts) and one generation rather than two.
 */
export const BLOG_SLOT = {
  name: 'Weekly article',
  day: 1 as const,
  time: '11:00',
  providers: ['blog', 'instagram', 'facebook', 'linkedin'] as readonly string[],
};

/**
 * The article's angle bank.
 *
 * Drawn from the document's own medical pillars rather than invented: an
 * article is the long form of what the week is already saying, so its rotation
 * follows the same subjects at more length.
 */
export const BLOG_ANGLES: readonly string[] = [
  'Why effective care begins with a thorough evaluation',
  'Why one protocol does not work the same way for every person',
  'Why you should not wait until you feel unwell to assess your health',
  'How follow-ups at 1, 3, 6, and 12 months support continuity of care',
  'The difference between addressing symptoms and exploring possible causes',
  'What information a physician needs before recommending a protocol',
];

export type SeedStrategy = {
  mode: 'pillars';
  pillars: string[];
  /** The standing note for the two pillars that carry one; '' for the rest. */
  rule: string;
  goal: string;
  format: 'social' | 'blog';
  lead_hours: number;
};

export type SeedRow = {
  /** Present only when this row updates a template that already exists. */
  id?: string;
  name: string;
  providers: string[];
  weekdays: number[];
  time_of_day: string;
  active: true;
  strategy: SeedStrategy;
};

/** Enough of an existing template to decide whether it is one of ours. */
export type ExistingTemplate = { id?: unknown; name?: unknown };

/** How two names are compared: case, spacing and surrounding punctuation do not count. */
export function matchKey(name: unknown): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** The fourteen social slots, as the strategy document defines them, plus the weekly article. */
export function seedRows(): SeedRow[] {
  const social: SeedRow[] = plannedTemplates().map((t) => ({
    name: t.name,
    providers: [...STRATEGY_PROVIDERS],
    weekdays: [...t.weekdays],
    time_of_day: t.time_of_day,
    active: true as const,
    strategy: {
      mode: 'pillars' as const,
      pillars: [...t.pillars],
      rule: t.rule,
      goal: STRATEGY_GOAL,
      format: 'social' as const,
      lead_hours: STRATEGY_LEAD_HOURS,
    },
  }));
  return [
    ...social,
    {
      name: BLOG_SLOT.name,
      providers: [...BLOG_SLOT.providers],
      weekdays: [BLOG_SLOT.day],
      time_of_day: BLOG_SLOT.time,
      active: true as const,
      strategy: {
        mode: 'pillars' as const,
        pillars: [...BLOG_ANGLES],
        rule: '',
        goal: STRATEGY_GOAL,
        format: 'blog' as const,
        lead_hours: STRATEGY_LEAD_HOURS,
      },
    },
  ];
}

export type SeedPlan = {
  /** Rows with no counterpart in the account yet. */
  create: SeedRow[];
  /** Rows that carry the id of the template they replace. */
  update: SeedRow[];
  /**
   * Names that matched MORE than one existing template.
   *
   * The first is updated and the others are left alone rather than deleted —
   * this seed does not remove anybody's work — but the caller should say so,
   * because two templates with one name means two posts in that slot.
   */
  duplicates: string[];
};

/**
 * What to write, given what the account already holds.
 *
 * Every row is either created or updated; nothing is deleted, and no template
 * whose name is not one of the fifteen is read as ours.
 */
export function planSeed(existing: readonly ExistingTemplate[] = []): SeedPlan {
  const byName = new Map<string, string[]>();
  for (const row of existing) {
    const id = typeof row?.id === 'string' ? row.id : '';
    if (!id) continue;
    const key = matchKey(row?.name);
    if (!key) continue;
    const list = byName.get(key);
    if (list) list.push(id);
    else byName.set(key, [id]);
  }

  const create: SeedRow[] = [];
  const update: SeedRow[] = [];
  const duplicates: string[] = [];
  for (const row of seedRows()) {
    const ids = byName.get(matchKey(row.name)) || [];
    if (!ids.length) {
      create.push(row);
      continue;
    }
    update.push({ ...row, id: ids[0] });
    if (ids.length > 1 && !duplicates.includes(row.name)) duplicates.push(row.name);
  }
  return { create, update, duplicates };
}

/** One sentence a person can read, rather than a pair of numbers. */
export function seedSummary(plan: SeedPlan): string {
  const parts: string[] = [];
  if (plan.create.length) parts.push(plan.create.length + (plan.create.length === 1 ? ' slot added' : ' slots added'));
  if (plan.update.length) parts.push(plan.update.length + ' brought up to date');
  const head = parts.length ? parts.join(', ') : 'Nothing to do';
  const total = plan.create.length + plan.update.length;
  const tail = plan.duplicates.length
    ? ' There is more than one template named ' + plan.duplicates.map((d) => '"' + d + '"').join(', ') +
      ' — the extra ones were left alone, but they will post in the same slot.'
    : '';
  return head + ' — ' + total + ' posts a week: two a day, plus the Monday article. All of them waiting in the review queue.' + tail;
}
