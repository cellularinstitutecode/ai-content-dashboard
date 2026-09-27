// web/lib/strategy-rotation.ts
// Which angle each of the weekly strategy's slots writes, week by week.
//
// WHY NOT "OCCURRENCE MOD BANK LENGTH". That was the rule, and it had three
// faults the strategy's governing sentence — "repeat the content pillar, not
// the wording" — cannot live with:
//
//  1. SIBLINGS IN STEP. The document splits each recurring pillar across two
//     days with two separate banks, and every bank started at its first angle
//     on the same press. So index k of every bank landed in the same week:
//     Tuesday "The role of protein in recovery" beside Saturday "Protein-rich
//     breakfast ideas"; Wednesday "Why staying active matters at every age"
//     beside Saturday "Simple activities that help people stay active";
//     Friday "Why the body needs time to respond" beside Sunday "Why the body
//     needs intentional rest". A fixed offset cannot separate them for good:
//     the Monday banks have five angles and their siblings six, so every pair
//     comes round together once every thirty weeks whatever the offset.
//  2. THE ARTICLE ON TOP OF A POST. The weekly article's bank was six of the
//     medical bullets, word for word, so in the first week it always wrote
//     the same angle as Monday's first post, and again every six weeks.
//  3. COUNTING RUNS, NOT WEEKS. The index was "how many runs came before",
//     so a deleted-and-reloaded slot restarted at angle 1 and every orphan or
//     duplicate run moved the rotation on an extra step.
//
// WHAT REPLACES IT. The week is counted from a fixed Monday in the clinic's
// time zone, and the schedule is DEALT, like cards: each slot uses every angle
// in its bank once per cycle, never repeats last week's, and within a week
// picks — among the angles it has left — the one sharing the fewest subject
// words with what the other slots have already taken that week. The article
// draws from all four medical banks together, never an angle already used
// that week. The whole schedule is a pure function of the week number, so the
// engine, a test and a future calendar view all see the same answer.
//
// Pure: imports only ./content-strategy.ts and ./timezone.ts.
import { BLOG_SLOT_KEY, PILLARS, WEEK, pillarById, slotKey } from './content-strategy.ts';
import { SCHEDULE_TZ, wallClockInTz } from './timezone.ts';

/**
 * Week 0 of the dealt schedule: a Monday, read in the clinic's time zone.
 * A slot before it keeps the old rotation.
 */
export const STRATEGY_EPOCH = '2026-09-28';

/** The article's source banks: the medical pillars of the day pages. */
export const ARTICLE_SOURCE_PILLARS = ['diagnosis', 'protocols', 'prevention', 'follow-up'] as const;

/** The order slots pick in each week: Monday first, as the document reads; the article last. */
export const DEAL_ORDER: string[] = [
  ...[1, 2, 3, 4, 5, 6, 0].flatMap((day) => WEEK.filter((s) => s.day === day).sort((a, b) => a.post - b.post).map((s) => slotKey(s))),
  BLOG_SLOT_KEY,
];

/** Every angle each slot may be dealt: its own bank, or for the article all four medical banks. */
export function deckFor(key: string): string[] {
  if (key === BLOG_SLOT_KEY) {
    return ARTICLE_SOURCE_PILLARS.flatMap((id) => pillarById(id)?.angles || []);
  }
  const slot = WEEK.find((s) => slotKey(s) === key);
  return slot ? [...(pillarById(slot.pillarId)?.angles || [])] : [];
}

/** Words that name no subject; two angles sharing only these are not alike. */
const GENERIC = new Set([
  'about', 'after', 'also', 'always', 'before', 'being', 'between', 'body', 'does', 'during', 'each', 'every', 'from',
  'have', 'help', 'helps', 'into', 'just', 'more', 'most', 'much', 'only', 'other', 'same', 'should', 'some', 'such',
  'than', 'that', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'through', 'very', 'what', 'when',
  'where', 'which', 'while', 'with', 'without', 'your', 'people', 'patient', 'patients', 'health', 'care', 'role',
  'importance', 'important', 'difference', 'simple', 'ways', 'options', 'part', 'mean', 'means', 'matters', 'matter',
  'better', 'person', 'individual', 'present',
]);

/**
 * The document's own through-lines: recovery, support and treatment run
 * through a dozen angles in five pillars on purpose. Sharing one is the
 * strategy being coherent, not two posts being alike — so it weighs a
 * quarter of a subject word: enough to break a tie, never enough to decide.
 */
const WEAK = new Set(['recovery', 'recover', 'recovering', 'support', 'supports', 'treatment']);
const WEAK_WEIGHT = 0.25;

/** How alike two angles' subject words are: 1 per shared word, a quarter per shared through-line. */
export function likeness(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n += w.startsWith('~') ? WEAK_WEIGHT : 1;
  return n;
}

/**
 * Words that say the same thing in different ways across the banks. Two angles
 * about exercising within a limit ("…when pain or limited mobility is
 * present", "…when intense exercise is not appropriate") share no word, and
 * are still the same post.
 */
const CONCEPTS: Record<string, string> = {
  calmer: 'calm', calming: 'calm', calmly: 'calm',
  pain: 'limit', limited: 'limit', limitation: 'limit', limitations: 'limit', intense: 'limit', appropriate: 'limit',
};

/** The subject words of an angle, crudely stemmed ("staying" and "stay", "rest" and "resting" meet). */
export function keyWords(angle: string): Set<string> {
  const out = new Set<string>();
  for (const word of String(angle || '').toLowerCase().split(/[^a-z0-9]+/)) {
    const raw = CONCEPTS[word] || word;
    if (raw.length < 4 || GENERIC.has(raw)) continue;
    if (WEAK.has(raw)) { out.add('~' + raw.replace(/(ing|y)$/, '')); continue; }
    const stem = raw.replace(/(ing|ed|es|s)$/, '').replace(/(ation)$/, 'ate');
    out.add(stem.length >= 4 ? stem : raw);
  }
  return out;
}


export type DealtWeek = Record<string, string>;

/**
 * Per slot: the angles planned for the rest of its current cycle (index 0 is
 * this week), and what it wrote last. The article keeps a deck instead.
 */
type SlotState = { plan: string[]; remaining: string[]; last: string | null };

const cache: { weeks: DealtWeek[]; state: Record<string, SlotState> } = { weeks: [], state: {} };

/** Every ordering of a small list, in lexicographic order of its indices. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

const PERMS = new Map<string, string[][]>();

function wordsOf(a: string, memo: Map<string, Set<string>>): Set<string> {
  let w = memo.get(a);
  if (!w) { w = keyWords(a); memo.set(a, w); }
  return w;
}

function dealOne(state: Record<string, SlotState>): DealtWeek {
  const memo = new Map<string, Set<string>>();
  const pick: DealtWeek = {};
  const social = DEAL_ORDER.filter((k) => k !== BLOG_SLOT_KEY);

  // 1. A slot whose cycle has run out plans its next one WHOLE: the ordering
  //    of its bank that shares the fewest subject words, week by week, with
  //    what the other slots have already planned for those weeks. Planning a
  //    cycle at a time is what a week-by-week choice cannot do — two six-angle
  //    banks that start together are otherwise left, five weeks later, with
  //    one card each and no way to keep them apart. The first angle of a new
  //    cycle is never the last of the old one.
  for (const key of social) {
    const deck = deckFor(key);
    if (!deck.length) continue;
    const st = state[key] || (state[key] = { plan: [], remaining: [], last: null });
    if (st.plan.length) continue;
    let perms = PERMS.get(key);
    if (!perms) { perms = permutations(deck); PERMS.set(key, perms); }
    let best: string[] = deck;
    let bestScore = Infinity;
    for (const order of perms) {
      if (order[0] === st.last) continue;
      let score = 0;
      for (let i = 0; i < order.length && score < bestScore; i++) {
        const mine = wordsOf(order[i], memo);
        for (const other of social) {
          if (other === key) continue;
          const planned = state[other]?.plan[i];
          if (!planned) continue;
          if (planned === order[i]) { score += 100; continue; }
          score += likeness(mine, wordsOf(planned, memo));
        }
      }
      if (score < bestScore) { best = order; bestScore = score; if (score === 0) break; }
    }
    st.plan = [...best];
  }
  for (const key of social) {
    const st = state[key];
    if (!st || !st.plan.length) continue;
    pick[key] = st.plan.shift()!;
    st.last = pick[key];
  }

  // 2. The article, dealt last from all four medical banks: never an angle a
  //    post already has this week, never last week's, and the one sharing the
  //    fewest subject words with the week's posts. Its deck of twenty-two runs
  //    through every medical angle before any comes round again.
  const deck = deckFor(BLOG_SLOT_KEY);
  if (deck.length) {
    const st = state[BLOG_SLOT_KEY] || (state[BLOG_SLOT_KEY] = { plan: [], remaining: [], last: null });
    if (!st.remaining.length) st.remaining = [...deck];
    const taken = new Set(Object.values(pick));
    let options = st.remaining.filter((a) => !taken.has(a) && a !== st.last);
    if (!options.length) {
      st.remaining = deck.filter((a) => a !== st.last);
      options = st.remaining.filter((a) => !taken.has(a));
    }
    let best = options[0] ?? deck[0];
    let bestScore = Infinity;
    for (const a of options) {
      const mine = wordsOf(a, memo);
      let score = 0;
      for (const t of taken) score += likeness(mine, wordsOf(t, memo));
      if (score < bestScore) { best = a; bestScore = score; }
    }
    pick[BLOG_SLOT_KEY] = best;
    st.remaining = st.remaining.filter((a) => a !== best);
    st.last = best;
  }
  return pick;
}

/** The dealt schedule for week `w` (0 = the epoch week). Deterministic; memoised. */
export function dealtWeek(w: number): DealtWeek {
  const target = Math.max(0, Math.trunc(w));
  while (cache.weeks.length <= target) cache.weeks.push(dealOne(cache.state));
  return cache.weeks[target];
}

/** Clinic-local Monday-based week number of an instant, counted from STRATEGY_EPOCH. Negative before it. */
export function weekIndex(iso: string, tz: string = SCHEDULE_TZ): number {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return -1;
  const w = wallClockInTz(at, tz);
  const localDay = Date.UTC(w.y, w.m - 1, w.d);
  const mondayOffset = (w.weekday + 6) % 7; // Monday → 0 … Sunday → 6
  const monday = localDay - mondayOffset * 86_400_000;
  const [ey, em, ed] = STRATEGY_EPOCH.split('-').map(Number);
  return Math.floor((monday - Date.UTC(ey, em - 1, ed)) / (7 * 86_400_000));
}

/** Is this bank the document's own for this slot? Only then does the dealt schedule apply. */
export function bankIsDocument(key: string, bank: readonly string[] | null | undefined, articleBank?: readonly string[]): boolean {
  const list = (bank || []).map((a) => String(a).trim());
  if (key === BLOG_SLOT_KEY) {
    // The article row stores a short display list; any list drawn from the
    // medical banks counts as the document's.
    const pool = new Set(deckFor(BLOG_SLOT_KEY));
    return list.length > 0 && (list.every((a) => pool.has(a)) || JSON.stringify(list) === JSON.stringify(articleBank || []));
  }
  const deck = deckFor(key);
  return deck.length > 0 && list.length === deck.length && list.every((a, i) => a === deck[i]);
}

/**
 * The angle a strategy slot writes for the occurrence at `iso`, or null when
 * the dealt schedule does not apply (no slot key, a hand-edited bank, or a
 * slot before the epoch) and the caller keeps its old rotation.
 *
 * `avoid` is the slot's own recently PUBLISHED angles. Only in the first
 * cycle after the switch-over does it change the answer — the dealt schedule
 * starts fresh, and without this a slot could re-publish last week's angle on
 * the day it took over. After that the schedule itself guarantees it.
 */
export function angleFor(
  key: string | null | undefined,
  iso: string,
  opts: { bank?: readonly string[] | null; articleBank?: readonly string[]; avoid?: readonly string[]; tz?: string } = {},
): { angle: string; week: number; position: number; of: number } | null {
  const k = String(key || '');
  if (!k || !bankIsDocument(k, opts.bank, opts.articleBank)) return null;
  const week = weekIndex(iso, opts.tz);
  if (week < 0) return null;
  const deck = deckFor(k);
  let angle = dealtWeek(week)[k];
  if (!angle) return null;
  const avoid = new Set((opts.avoid || []).map((a) => String(a).trim()));
  if (week < CUTOVER_WEEKS && avoid.has(angle)) {
    const others = new Set(Object.entries(dealtWeek(week)).filter(([kk]) => kk !== k).map(([, a]) => a));
    const start = deck.indexOf(angle);
    for (let i = 1; i < deck.length; i++) {
      const c = deck[(start + i) % deck.length];
      if (!avoid.has(c) && !others.has(c)) { angle = c; break; }
    }
  }
  return { angle, week, position: deck.indexOf(angle) + 1, of: deck.length };
}

/**
 * What the slots related to `key` write in week `w`: those sharing a row of
 * the frequency table with it (Tuesday's and Saturday's nutrition posts, say),
 * or for the article, the week's four medical posts. The brief tells the
 * writer not to cover the same ground.
 */
export function siblingAngles(key: string, w: number): string[] {
  const week = dealtWeek(w);
  if (key === BLOG_SLOT_KEY) {
    return ['mon-1', 'mon-2', 'thu-1', 'fri-1'].map((k) => week[k]).filter(Boolean);
  }
  const me = WEEK.find((s) => slotKey(s) === key);
  if (!me) return [];
  const rows = new Set(me.tags.map((t) => t.freqId));
  return WEEK
    .filter((s) => slotKey(s) !== key && s.tags.some((t) => rows.has(t.freqId)))
    .map((s) => week[slotKey(s)])
    .filter(Boolean);
}

/** How many weeks after the switch-over the recent-history guard is consulted. */
export const CUTOVER_WEEKS = 6;

/** Every slot the rotation knows, for tests and views. */
export function rotationSlots(): string[] {
  return [...DEAL_ORDER];
}

// Referenced so a future edit that drops a bank from PILLARS fails loudly here.
void PILLARS;
