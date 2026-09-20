// web/lib/strategy-seed.ts
// Turning the written strategy into rows of `schedule_templates`.
//
// lib/content-strategy.ts says what the week IS. This says what the database
// should therefore hold, and — the part that matters — what to do when some of
// it is already there.
//
// WHY A MARK, AND A NAME. `schedule_templates` has no unique key beyond its
// id, so pressing "Load the weekly strategy" twice would otherwise produce
// thirty templates and thirty posts a week. The seed therefore stamps every
// row it writes (`strategy.seeded`) and updates only rows carrying that stamp,
// matched by name within them.
//
// Matching by name ALONE was the first version, and it was wrong in a way
// nobody would have noticed until their copy was gone: the seed's names are
// ordinary words — Nutrition, Sleep, Movement, Recovery, Prevention — so a
// template a person had written under one of those names was absorbed on the
// first press, its channels, days, time and strategy replaced and its text
// emptied. Anything the seed cannot prove it wrote is now left exactly as it
// is, and the collision is reported.
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

/**
 * The mark that says "this row belongs to the seed".
 *
 * WHY A MARK AND NOT A NAME. The seed's names are ordinary words — Nutrition,
 * Sleep, Movement, Recovery, Prevention. Matching on name alone meant a
 * template a person had written and called "Nutrition" was absorbed on the
 * first press: its channels, days, time and strategy replaced and its text
 * emptied, silently, while the confirm dialog promised the opposite. The seed
 * now updates only rows it can prove it made, and reports the rest.
 */
export const SEED_MARK = 'weekly-strategy';

export type SeedStrategy = {
  mode: 'pillars';
  pillars: string[];
  /** The standing note for the two pillars that carry one; '' for the rest. */
  rule: string;
  goal: string;
  format: 'social' | 'blog';
  lead_hours: number;
  /** SEED_MARK. Its presence is what makes a row safe to overwrite. */
  seeded: string;
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
export type ExistingTemplate = { id?: unknown; name?: unknown; strategy?: unknown };

/** Was this row written by the seed? Only these are ever overwritten. */
export function isSeeded(row: ExistingTemplate | null | undefined): boolean {
  const strategy = row?.strategy;
  if (!strategy || typeof strategy !== 'object') return false;
  return String((strategy as { seeded?: unknown }).seeded || '') === SEED_MARK;
}

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
      seeded: SEED_MARK,
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
        seeded: SEED_MARK,
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
   * Names that matched MORE than one row the seed owns.
   *
   * The first is updated and the others are left alone rather than deleted —
   * this seed does not remove anybody's work — but the caller should say so,
   * because two templates with one name means two posts in that slot.
   */
  duplicates: string[];
  /**
   * Names where a template the seed does NOT own is already using the name.
   *
   * Nothing is done to those rows. The slot is created alongside, and the
   * caller says so, because two templates with one name is a surprise a person
   * should hear about rather than discover on the calendar.
   */
  collisions: string[];
};

/**
 * What to write, given what the account already holds.
 *
 * Every row is either created or updated; nothing is deleted, and no template
 * whose name is not one of the fifteen is read as ours.
 */
export function planSeed(existing: readonly ExistingTemplate[] = []): SeedPlan {
  // Two maps: what the seed owns, and what merely shares a name. Only the
  // first is ever written to.
  const ours = new Map<string, string[]>();
  const theirs = new Set<string>();
  for (const row of existing) {
    const id = typeof row?.id === 'string' ? row.id : '';
    const key = matchKey(row?.name);
    if (!key) continue;
    if (!id || !isSeeded(row)) { theirs.add(key); continue; }
    const list = ours.get(key);
    if (list) list.push(id);
    else ours.set(key, [id]);
  }

  const create: SeedRow[] = [];
  const update: SeedRow[] = [];
  const duplicates: string[] = [];
  const collisions: string[] = [];
  for (const row of seedRows()) {
    const key = matchKey(row.name);
    const ids = ours.get(key) || [];
    if (!ids.length) {
      create.push(row);
      // Somebody's own template is sitting on this name. It is left exactly as
      // it is, and said out loud.
      if (theirs.has(key) && !collisions.includes(row.name)) collisions.push(row.name);
      continue;
    }
    update.push({ ...row, id: ids[0] });
    if (ids.length > 1 && !duplicates.includes(row.name)) duplicates.push(row.name);
  }
  return { create, update, duplicates, collisions };
}

/** One sentence a person can read, rather than a pair of numbers. */
export function seedSummary(plan: SeedPlan): string {
  const parts: string[] = [];
  if (plan.create.length) parts.push(plan.create.length + (plan.create.length === 1 ? ' slot added' : ' slots added'));
  if (plan.update.length) parts.push(plan.update.length + ' brought up to date');
  const head = parts.length ? parts.join(', ') : 'Nothing to do';
  const total = plan.create.length + plan.update.length;
  const tail = (plan.duplicates.length
    ? ' There is more than one slot named ' + plan.duplicates.map((d) => '"' + d + '"').join(', ') +
      ' — the extra ones were left alone, but they will post in the same slot.'
    : '') + (plan.collisions.length
    ? ' You already have a template called ' + plan.collisions.map((d) => '"' + d + '"').join(', ') +
      ' — it was NOT touched, and the new slot was added beside it. Rename or pause one of them if you do not want both posting.'
    : '');
  return head + ' — ' + total + ' posts a week: two a day, plus the Monday article. All of them waiting in the review queue.' + tail;
}
