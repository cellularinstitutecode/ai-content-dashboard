// web/lib/score-pack.ts
// The rubric a drafted pack is scored against, as a pure module.
//
// It lived inside lib/autopilot.ts, which imports `server-only`, so the one
// function that decides whether a post is rewritten — and, under autoschedule,
// whether it may go out unattended — could only ever be grepped. Here it runs.
//
// Pure: `./x.ts` value imports only (types from lib/ai.ts are erased), so the
// test runner reads this file directly.
import type { ContentPack } from './ai.ts';
import { reviewPack, type SafetyFlag } from './safety-rules.ts';
import { promotionFlags, SOFT_CTA_RE } from './strategy-voice.ts';
import { openingLineOf, repeatsOpening } from './opening-line.ts';
import { closingCritique, closingPresent } from './strategy-variety.ts';

export type RunScore = {
  total: number; // 0-100
  breakdown: Record<string, number>;
  safetyFlags: SafetyFlag[];
  critique: string[];
  /** Weekly-strategy posts only: the promotional habits found (lib/strategy-voice.ts). */
  promotionFlags?: string[];
  /** Weekly-strategy posts only: the opening repeats one the clinic already published. */
  openingRepeat?: boolean;
};

/** Enough of an angle to score against. */
export type ScoreAngle = { query: string };

/** Words that carry no subject: a sentence-shaped angle is scored on the rest. */
const STOP = new Set([
  'about', 'after', 'also', 'always', 'before', 'being', 'between', 'does', 'doing', 'during', 'each', 'every', 'from',
  'have', 'help', 'helps', 'into', 'just', 'like', 'many', 'mean', 'means', 'more', 'most', 'much', 'only', 'other',
  'same', 'should', 'some', 'such', 'than', 'that', 'their', 'them', 'there', 'these', 'they', 'this', 'those',
  'through', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'without', 'your', 'body', 'people',
]);

/** Lower-cased words of four letters or more that say what the angle is about. */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9áéíóúñü]+/)) {
    if (w.length >= 4 && !STOP.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

export const CTA_RE = /\b(book|schedule|contact|call|visit|learn more|read more|watch|subscribe|sign up|reach out|dm us|link in bio)\b/i;

export function channelText(pack: ContentPack, provider: string): string {
  const key = provider === 'twitter' ? 'instagram' : provider; // closest fit
  const p = pack as unknown as Record<string, string>;
  return String(p[key] || p.instagram || p.blog || '');
}

export function scorePack(
  pack: ContentPack,
  providers: string[],
  angle: ScoreAngle,
  opts: { strategySlot?: boolean; recentOpenings?: readonly string[]; closing?: string | null } = {},
): RunScore {
  const texts = (providers.length ? providers : ['instagram']).map((p) => channelText(pack, p));
  const joined = texts.join('\n').toLowerCase();
  const critique: string[] = [];
  const breakdown: Record<string, number> = {};

  // Keyword coverage (0-30): primary phrase (or most of its words) present.
  const query = angle.query.toLowerCase().trim();
  if (opts.strategySlot) {
    // A weekly-strategy angle is a SENTENCE from the clinic's document, not a
    // search phrase. Rewarding the exact sentence — and telling the rewrite to
    // "work the exact phrase into the opening" — pushed every post, and every
    // return of the same angle five weeks later, towards the same opening
    // words: the one thing the strategy's governing rule forbids. So coverage
    // is measured on the angle's content words, and half of them is full marks.
    const content = contentWords(query);
    const hit = content.length ? content.filter((w) => joined.includes(w)).length / content.length : 0;
    breakdown.keyword = !query ? 0 : Math.round(30 * Math.min(1, hit / 0.5));
    if (breakdown.keyword < 18) critique.push('Cover this week\'s angle — ' + angle.query + ' — in your own words; do not copy the sentence.');
  } else {
    const words = query.split(/\s+/).filter((w) => w.length > 2);
    const covered = words.length ? words.filter((w) => joined.includes(w)).length / words.length : 0;
    // `joined.includes('')` is TRUE, so a blank query — reachable from a Semrush
    // row with an empty keyword — scored a perfect 30/30 for covering nothing.
    breakdown.keyword = !query ? 0 : Math.round(30 * (joined.includes(query) ? 1 : covered));
    if (breakdown.keyword < 18) critique.push('Work the exact phrase "' + angle.query + '" naturally into the opening.');
  }

  // Channel completeness (0-25): every requested channel has real copy.
  const complete = texts.filter((t) => t.trim().length >= 80).length;
  breakdown.channels = Math.round(25 * (texts.length ? complete / texts.length : 0));
  if (breakdown.channels < 25) critique.push('One or more channels came back empty or too short — write full copy for each.');

  // Hook (0-20): first line short and strong.
  const firstLine = (texts[0] || '').split('\n').find((l) => l.trim()) || '';
  breakdown.hook = firstLine && firstLine.length <= 140 ? 20 : firstLine ? 10 : 0;
  if (breakdown.hook < 20) critique.push('Open with a one-line scroll-stopping hook under 140 characters.');

  // CTA (0-15).
  // A weekly-strategy post closes with a gentle next step (save, share, ask
  // your physician), and ONLY that counts. It used to be either: a strategy
  // post ending "Book your HBOT session today" collected the full fifteen for
  // exactly the sales close its rules forbid. A booking close is now a
  // promotion flag below instead.
  // Phase 3 deals each strategy post its closing (lib/strategy-variety.ts); a
  // post that was dealt one is measured on that one, at its end.
  const dealtClosing = opts.strategySlot ? closingCritique(opts.closing) : null;
  breakdown.cta = (
    dealtClosing
      ? texts.some((t) => closingPresent(t, opts.closing))
      : opts.strategySlot ? SOFT_CTA_RE.test(joined) : CTA_RE.test(joined)
  ) ? 15 : 0;
  if (!breakdown.cta) {
    critique.push(dealtClosing ? dealtClosing : opts.strategySlot
      ? 'Close with a gentle, useful next step (save this, share it, talk it through with your physician) — not a sales pitch.'
      : 'Close with a clear, compliant call to action.');
  }

  // Safety (0-10): advisory flags cost points and surface to the reviewer.
  const safetyFlags = reviewPack(pack as unknown as Record<string, unknown>);
  breakdown.safety = Math.max(0, 10 - safetyFlags.length * 5);
  if (safetyFlags.length) critique.push('Rephrase flagged passages: ' + safetyFlags.map((f) => f.code).join(', ') + '.');

  // Strategy posts are educational: every promotional habit costs 10 points
  // and is named. Points alone never forced anything — a post that otherwise
  // scored 100 dropped to 90, above the rewrite threshold, and could be
  // auto-scheduled with the pitch in it — so stepScore also rewrites on ANY
  // flag, and autoScheduleVerdict holds on one.
  let promo: string[] | undefined;
  if (opts.strategySlot) {
    promo = promotionFlags(texts.join('\n'), angle.query);
    breakdown.promotion = -Math.min(40, promo.length * 10);
    if (promo.length) critique.push('This is an educational post, not an advert — remove: ' + promo.join(', ') + '.');
  }

  // "Repeat the content pillar, not the wording." Fourteen posts a week from
  // one writer drift toward the same first words; an opening that repeats
  // one of the recent posts costs points and forces the rewrite (stepScore).
  // The same guard the video captions have had (lib/opening-line.ts).
  let openingRepeat = false;
  // Not the weekly article: its first text is the blog, whose first line is a
  // headline, and headlines are not what the social openings are made of.
  const article = (providers[0] || '').toLowerCase() === 'blog';
  if (opts.strategySlot && !article && opts.recentOpenings?.length) {
    const opening = openingLineOf(texts[0] || '');
    const repeat = repeatsOpening(opening, opts.recentOpenings);
    if (repeat) {
      openingRepeat = true;
      breakdown.opening = -15;
      critique.push('The opening line repeats a recent post — start this post a different way, with a different first sentence.');
    }
  }

  const total = Math.max(0, Object.values(breakdown).reduce((s, v) => s + v, 0));
  const out: RunScore = { total, breakdown, safetyFlags, critique };
  if (promo) out.promotionFlags = promo;
  if (openingRepeat) out.openingRepeat = true;
  return out;
}
