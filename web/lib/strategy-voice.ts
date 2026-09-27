// web/lib/strategy-voice.ts
// How a weekly-planner post is written, as opposed to every other post.
//
// WHY THIS EXISTS. The Brand Brain's guidelines are written for promotion:
// "highlight that treatments are drug-free and surgery-free", "always include a
// clear call to action (See if you are a candidate / Schedule your free
// consultation)". Those are right for the clinic's ads and its video posts. They
// are wrong for the weekly strategy, whose stated aim is to position Cellular
// Institute "as a source of thoughtful, personalized care — not simply a clinic
// promoting procedures". Fed both, the writer obeyed the Brand Brain: a
// Wednesday post on sleep quality came back as a stem-cell sales pitch on every
// channel, with #StemCellTherapy and a free-consultation close.
//
// So posts from slots the strategy seed wrote (strategy.seeded === SEED_MARK)
// get the strategy's own editorial direction instead of the promotional rules.
// Nothing else changes: the Draft page, the Video Library and every template a
// person wrote by hand still get the Brand Brain exactly as it is.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { PILLARS, type Pillar } from './content-strategy.ts';
import { SEED_MARK } from './strategy-seed.ts';
import { negatedAt } from './safety-rules.ts';

/** Is this template one of the weekly strategy's own slots? */
export function isStrategySlot(strategy: { seeded?: unknown } | null | undefined): boolean {
  return String(strategy?.seeded || '') === SEED_MARK;
}

function key(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The strategy pillar a template name belongs to, or null (the weekly article has none). */
export function pillarForName(name: unknown): Pillar | null {
  const k = key(name);
  return PILLARS.find((p) => key(p.name) === k) ?? null;
}

/** The document's positioning line, used in place of the Brand Brain mission for these posts. */
export const STRATEGY_POSITIONING =
  'Cellular Institute is a medical team in Cancun that evaluates carefully, personalizes responsibly, and ' +
  'supports patients throughout the full care experience — evaluation, personalized planning, treatment ' +
  'preparation, recovery, daily habits and long-term follow-up. It is a trusted guide, not simply a clinic promoting procedures.';

/** "The content should feel" — the document's editorial direction, as writer rules. */
export const EDITORIAL_DIRECTION = [
  'EDITORIAL DIRECTION (the clinic\'s written weekly strategy — must follow):',
  'Educational: clear, useful information a patient can understand and apply today.',
  'Personalized: focus on the individual rather than a universal solution.',
  'Balanced: this is lifestyle and medical education, not an advertisement.',
  'Responsible: no cure claims, no guarantees, no promise of identical outcomes, no "many patients feel better after one session".',
  'Supportive: centred on guidance before, during and after care.',
].join(' ');

/** What these posts must NOT do — the promotional habits the Brand Brain would otherwise add. */
export const NO_PROMOTION_RULES = [
  'DO NOT turn the post into a promotion:',
  'do not pitch stem cells, exosomes, NK cells, peptides or any named therapy unless this week\'s angle is about it;',
  'do not say "drug-free", "surgery-free" or "science-backed" as selling points;',
  'do not use "See if you are a candidate" or "free consultation";',
  'do not use treatment hashtags such as #StemCellTherapy or #RegenerativeMedicine — use 3-5 hashtags about the topic itself.',
  'do not ask readers to book, call, DM or "contact us", and never attach a price, package or offer to a service;',
  'there is no source for this post: do not quote, paraphrase or describe any individual patient\'s experience;',
  'Mention Cellular Institute at most once, naturally, as the team sharing the advice.',
  'Close with a gentle, useful next step instead of a sales call to action — e.g. save this, share it with someone who needs it, or talk it through with your physician.',
].join(' ');

/**
 * The brand the writer sees for a strategy post.
 *
 * Name and voice are kept — they ARE the brand. Mission, audience keywords and
 * guidelines are replaced, because those are where the procedure-selling
 * instructions live. The COFEPRIS aviso and the visual identity are kept, so the
 * compliance gate and the images behave exactly as before.
 */
export function strategyBrand<T extends Record<string, unknown>>(brand: T | undefined | null): T {
  const b = (brand || {}) as T;
  return {
    ...b,
    mission: STRATEGY_POSITIONING,
    keywords: [],
    guidelines:
      EDITORIAL_DIRECTION + ' ' + NO_PROMOTION_RULES +
      ' Write in English. Keep claims responsible and evidence-based; cite one real, relevant study.',
  } as T;
}

/** The brief for one occurrence of a strategy slot. */
export function strategyTopicPrompt(opts: {
  angle: string;
  pillarName: string;
  rule?: string;
  reviewerNote?: string;
  supportingPhrase?: string;
}): string {
  const parts = [
    'Write about: ' + opts.angle + '.',
    'This is the weekly "' + opts.pillarName + '" post. Stay on this pillar and on this exact angle — the rest of the week covers the other topics.',
    EDITORIAL_DIRECTION,
    NO_PROMOTION_RULES,
  ];
  if (opts.supportingPhrase) {
    parts.push('If it reads naturally, use the search phrase "' + opts.supportingPhrase + '" once; never force it.');
  }
  if (opts.rule) parts.push('STANDING RULE for this pillar (must follow): ' + opts.rule);
  if (opts.reviewerNote) parts.push('REVIEWER FEEDBACK (must address): ' + opts.reviewerNote);
  return parts.join(' ');
}

/** A gentle next step counts as a call to action for a strategy post. */
export const SOFT_CTA_RE =
  /\b(save (this|it)|share (this|it)|tag someone|talk (it )?(through )?with your (physician|doctor)|ask your (physician|doctor)|comment|let us know|learn more|read more|what('s| is) your)\b/i;

/** The recovery services the document names: to be introduced, never promoted. */
const SERVICE = '(?:hbot|hyperbaric(?: oxygen)?(?: therapy| chamber)?|red[- ]light(?: therapy)?|pemf|hydrogen(?: inhalation)?|recovery lounge)';
const SELLING = '(?:book|booking|package|packages|pricing|price|prices|\\$\\s?\\d|discount|offer|special|promo|try our|ask about our|available now|reserve|sessions? (?:from|for|starting))';

/**
 * Phrases that make an educational post read as an advert. Each one found
 * costs the draft points, forces a rewrite, and holds an auto-scheduled post.
 *
 * `negatable` patterns pass after a negation ("not everyone will respond the
 * same way" is the Personalization pillar's whole message, not an outcome
 * promise). `sentence` patterns are checked only inside a sentence that
 * mentions what they are about, so "walking is better than nothing" is not a
 * destination claim.
 */
const PROMO_PATTERNS: { re: RegExp; label: string; negatable?: boolean; sentence?: RegExp }[] = [
  { re: /free consultation/i, label: 'free-consultation pitch' },
  { re: /\bsee if you('| a)re a candidate|\bif you('| a)re a candidate/i, label: 'candidate pitch' },
  { re: /drug[- ]free|surgery[- ]free/i, label: '"drug-free / surgery-free" selling point' },
  { re: /#stemcell|#regenerativemedicine|#exosome/i, label: 'treatment hashtag' },
  { re: /\bstem[- ]cell|\bexosome|\bNK cells?\b|\bpeptide/i, label: 'therapy pitch' },
  { re: /many patients (feel|see|notice)/i, label: 'outcome claim' },
  // The standing recovery rule: services may be introduced, never sold.
  {
    re: new RegExp('\\b' + SERVICE + '\\b[^.!?\\n]{0,80}\\b' + SELLING + '|\\b' + SELLING + '[^.!?\\n]{0,80}\\b' + SERVICE + '\\b', 'i'),
    label: 'service promotion',
  },
  // A sales close. Bare "schedule" is left alone: "sleep schedule" is common here.
  {
    re: /\bbook (a|an|your|now|today|online)\b|\bschedule (a|an|your) (free )?(consult\w*|appointment|session|visit|call|evaluation)\b|\bcall us\b|\bcontact us\b|\bdm us\b|\blink in (our )?bio\b|\breach out to (us|our team)\b|\bsign up\b/i,
    label: 'booking call to action',
  },
  // There is no source for a strategy post, so any patient quote is invented.
  {
    re: /\b(one of )?our patients? (said|says|told|tells|shared|shares|felt|reported|put it)\b|\bas (a|one) (of our )?patients? (put it|said|told us|shared)\b|\bpatients (often |frequently |regularly )?(tell|say to) us\b|\bone (of our )?patients? (said|told|shared|put it|described)\b/i,
    label: 'patient testimonial',
  },
  // The Cancún positioning note: specific advantages, never superiority.
  {
    re: /\b(best|top|#1|number one|leading|premier|ultimate|perfect)\b[^.!?\n]{0,40}\b(destination|place|city|spot|location|choice)\b|\bbetter than\b|\bunlike (other|any)\b|\bnowhere else\b|\bonly place\b|\bno other (destination|place|city)\b/i,
    label: 'destination superiority claim',
    negatable: true,
    sentence: /\b(canc[uú]n|mexico|m[eé]xico|riviera|quintana roo|destination)\b/i,
  },
  // "No cure claims, guarantees, or promises of identical outcomes."
  {
    re: /\b(everyone|everybody|every patient|all patients|anyone)\b[^.!?\n]{0,30}\b(will|can expect|is guaranteed|gets the same)\b|\breverses? (aging|ageing|disease|damage|the (effects|signs|clock))\b|\breversed (aging|ageing|disease|damage)\b|\bwill (heal|cure|fix|reverse|eliminate)\b|\b\d{2,3}\s?% (success|improvement|of (our )?patients)\b/i,
    label: 'outcome promise',
    negatable: true,
  },
];

function sentencesOf(text: string): string[] {
  return String(text || '').split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
}

function hits(p: (typeof PROMO_PATTERNS)[number], text: string): boolean {
  const scopes = p.sentence ? sentencesOf(text).filter((s) => p.sentence!.test(s)) : [text];
  for (const scope of scopes) {
    const re = new RegExp(p.re.source, p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(scope))) {
      if (!p.negatable || !negatedAt(scope, m.index)) return true;
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return false;
}

/**
 * The recovery rule's other half: "do not build the post around one of them".
 * One service named three or more times is the post being about it.
 */
function builtAroundOneService(text: string): boolean {
  const counts = new Map<string, number>();
  const re = new RegExp('\\b' + SERVICE + '\\b', 'gi');
  for (const m of String(text || '').matchAll(re)) {
    const k = m[0].toLowerCase().startsWith('hyperbaric') ? 'hbot' : m[0].toLowerCase().split(/[\s-]/)[0];
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.values()].some((n) => n >= 3);
}

/**
 * Promotional habits found in a strategy post.
 *
 * A therapy name is allowed when the week's angle itself is about it, so a
 * future angle on, say, recovery technologies is not penalised for naming one.
 * Selling it is never allowed.
 */
export function promotionFlags(text: string, angle = ''): string[] {
  const found: string[] = [];
  for (const p of PROMO_PATTERNS) {
    if (!hits(p, text)) continue;
    if (p.label === 'therapy pitch' && p.re.test(angle)) continue;
    if (!found.includes(p.label)) found.push(p.label);
  }
  if (builtAroundOneService(text) && !found.includes('post built around one service')) found.push('post built around one service');
  return found;
}
