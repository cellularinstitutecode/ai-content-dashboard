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
import { PILLARS, citationPolicyForSlot, pillarById, slotByKey, type CitationPolicy, type Pillar } from './content-strategy.ts';
import { SEED_MARK } from './strategy-seed.ts';
import { negatedAt } from './safety-rules.ts';

/**
 * Whether this template's posts must cite a study: the document slot's policy
 * for a seeded slot (lib/content-strategy.ts), 'required' for everything else.
 */
export function citationPolicyFor(strategy: { seeded?: unknown; slot?: unknown } | null | undefined): CitationPolicy {
  if (!isStrategySlot(strategy)) return 'required';
  return citationPolicyForSlot(String(strategy?.slot || ''));
}

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

/**
 * The pillar a seeded template writes about, found through the keys the seed
 * stamped (`pillarId`, then `slot`) and only then through its name.
 *
 * By name alone, a slot somebody renamed — "Nutrition (Tuesday AM)" — lost
 * its pillar in the brief and its picture, and a hand-written template that
 * happened to be called "Nutrition" gained one.
 */
export function pillarForStrategy(strategy: { pillarId?: unknown; slot?: unknown } | null | undefined, name?: unknown): Pillar | null {
  const byId = typeof strategy?.pillarId === 'string' ? pillarById(strategy.pillarId) : null;
  if (byId) return byId;
  const slot = slotByKey(strategy?.slot);
  if (slot) return pillarById(slot.pillarId);
  return pillarForName(name);
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
  'Balanced: medical education supported by lifestyle, recovery, and destination content.',
  'Responsible: no cure claims, no guarantees, no promise of identical outcomes, no "many patients feel better after one session" — this is education, not an advertisement.',
  'Supportive: centred on guidance before, during and after care.',
].join(' ');

/** What these posts must NOT do — the promotional habits the Brand Brain would otherwise add. */
export const NO_PROMOTION_RULES = [
  'DO NOT turn the post into a promotion:',
  'do not pitch stem cells, exosomes, NK cells, peptides or any named therapy unless this week\'s angle is about it (the recovery services a STANDING RULE below names may be introduced exactly as that rule allows);',
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
export function strategyBrand<T extends Record<string, unknown>>(
  brand: T | undefined | null,
  opts: { citation?: 'required' | 'if-health-claim' } = {},
): T {
  const b = (brand || {}) as T;
  // A destination or logistics post cites a study only when it makes a health
  // claim (lib/content-strategy.ts citation policy) — and must not invent one
  // to have something to cite.
  const cite = opts.citation === 'if-health-claim'
    ? ' Keep claims responsible and evidence-based; cite one real, relevant study only if the post makes a health claim, and do not add a health claim just to cite one.'
    : ' Keep claims responsible and evidence-based; cite one real, relevant study.';
  return {
    ...b,
    mission: STRATEGY_POSITIONING,
    keywords: [],
    guidelines: EDITORIAL_DIRECTION + ' ' + NO_PROMOTION_RULES + ' Write in English.' + cite,
  } as T;
}

/** The brief for one occurrence of a strategy slot. */
export function strategyTopicPrompt(opts: {
  angle: string;
  pillarName: string;
  rule?: string;
  reviewerNote?: string;
  supportingPhrase?: string;
  /** The day page's subtitle, e.g. "Understand before treating". */
  dayTheme?: string;
  /** The frequency-table rows this slot counts as, when it is more than one. */
  alsoCovers?: string[];
  /** A pillar the table integrates into this slot without making it the subject. */
  integrated?: string[];
  /** What the related slots write this same week — ground not to repeat. */
  coveredThisWeek?: string[];
  /** Varies the brief's own example sentences from week to week (the dealt week). */
  variant?: number;
  /** This occurrence's shape, reader and close (lib/strategy-variety.ts briefs). */
  formatBrief?: string;
  audienceBrief?: string;
  closingBrief?: string;
  /** The opening line this same angle had the last time it was published. */
  previousOpening?: string;
}): string {
  const parts = [
    'Write about: ' + opts.angle + '.',
    'This is the weekly "' + opts.pillarName + '" post. Stay on this pillar and on this exact angle — the rest of the week covers the other topics.',
  ];
  if (opts.dayTheme) parts.push('The day\'s theme is "' + opts.dayTheme + '"; let the post sit inside it.');
  // "Each time a pillar returns, the angle, question, format, or audience
  // should change." The angle is dealt by the rotation; these are the rest.
  if (opts.audienceBrief) parts.push('Write it for ' + opts.audienceBrief + ' — speak to their situation, and make no assumptions about their diagnosis or their results.');
  if (opts.formatBrief) parts.push(opts.formatBrief);
  if (opts.previousOpening) {
    parts.push('This angle has been published before, opening with: "' + opts.previousOpening.slice(0, 200) +
      '". Come at it from a different question or entry point this time, and do not reuse that opening.');
  }
  if (opts.alsoCovers && opts.alsoCovers.length > 1) {
    parts.push('This slot counts for both ' + opts.alsoCovers.map((n) => '"' + n + '"').join(' and ') + ' in the clinic\'s weekly mix, so the post should speak to both.');
  }
  if (opts.integrated && opts.integrated.length) {
    // Varied by week, so the same connecting sentence is not handed over every
    // Monday — the one place the brief itself risked repeating its wording.
    const examples = INTEGRATED_EXAMPLES;
    const example = examples[Math.abs(Math.trunc(opts.variant ?? 0)) % examples.length];
    parts.push('Where it fits naturally, connect the angle to ' + opts.integrated.map((n) => '"' + n + '"').join(' and ') +
      ' — for example, ' + example + ' One sentence is enough; do not change the subject.');
  }
  if (opts.coveredThisWeek && opts.coveredThisWeek.length) {
    // The document's own example: Monday explains why medical history
    // matters, Thursday why follow-up testing measures progress — the same
    // pillar, complementary points. So: build on them, do not repeat them.
    parts.push('Related posts this week cover: ' + opts.coveredThisWeek.map((a) => '"' + a + '"').join('; ') +
      '. Build on them from a different point or step in the patient\'s journey; do not repeat their points.');
  }
  parts.push(EDITORIAL_DIRECTION, NO_PROMOTION_RULES);
  // After the general rule, so the specific close for this post wins.
  if (opts.closingBrief) parts.push('For this post: ' + opts.closingBrief);
  if (opts.supportingPhrase) {
    parts.push('If it reads naturally, use the search phrase "' + opts.supportingPhrase + '" once; never force it.');
  }
  if (opts.rule) parts.push('STANDING RULE for this pillar (must follow): ' + opts.rule);
  if (opts.reviewerNote) parts.push('REVIEWER FEEDBACK (must address): ' + opts.reviewerNote);
  return parts.join(' ');
}

/** Ways to tie follow-up into an assessment post; one per week, in turn. */
const INTEGRATED_EXAMPLES = [
  'how what is learned at the first evaluation becomes the baseline later follow-ups measure progress against.',
  'why a follow-up test means more when there is a careful first result to compare it with.',
  'how the questions asked at the first visit shape what is checked again at 1, 3, 6 and 12 months.',
];

/** A gentle next step counts as a call to action for a strategy post. */
export const SOFT_CTA_RE =
  /\b(save (this|it)|share (this|it)|tag someone|talk (it )?(through )?with your (physician|doctor)|ask your (physician|doctor)|comment|let us know|learn more|read more|what('s| is) your|what does your|how do you|try (this|it) (today|tonight|this week))\b/i;

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
  // The everyday-scenario shape (lib/strategy-variety.ts) is a hypothetical,
  // never a result: "someone who… felt better after" is a testimonial with
  // the name taken off.
  {
    re: /\b(someone|a person|a patient|a friend|a woman|a man)\b[^.!?\n]{0,100}\b(felt|feels|was|were|got|gets|became|is now|was now|ended up)\s+(?:(?:so |much |a lot |finally |far )+)?(better(?=\s*(?:[.,!;:)]|$|\s+(?:after|within|in (?:a|one|two|three|just)|by the end|than (?:before|ever))))|cured|healed|pain[- ]free|transformed|back to normal|like new|symptom[- ]free)\b/i,
    label: 'scenario outcome',
    negatable: true,
  },
  // The Cancún positioning note: specific advantages, never superiority.
  {
    re: /\b(best|top|#1|number one|leading|premier|ultimate|perfect)\b[^.!?\n]{0,40}\b(destination|place|city|spot|location|choice)\b|\bbetter than\b|\bunlike (other|any)\b|\bnowhere else\b|\bonly place\b|\bno other (destination|place|city)\b|\b(ideal|paradise|world[- ]class|unmatched|unrivall?ed|unbeatable|second to none)\b/i,
    label: 'destination superiority claim',
    negatable: true,
    sentence: /\b(canc[uú]n|mexico|m[eé]xico|riviera|quintana roo|destination)\b/i,
  },
  // "Personalized: focused on the individual rather than a universal
  // solution." A blanket instruction to every reader is the opposite. Advice
  // to talk it through with a physician is not.
  {
    re: /\beveryone should (?!(talk|consult|ask|speak|check))\w+|\bworks for everyone\b|\bone[- ]size[- ]fits[- ]all\b|\byou must (take|do|start|try|stop|avoid|eat)\b/i,
    label: 'universal prescription',
    negatable: true,
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
 * The recovery rule's third clause: "do not compare them". Two of the named
 * services in one sentence with a comparative is the comparison.
 */
function comparesServices(text: string): boolean {
  const service = new RegExp('\\b' + SERVICE + '\\b', 'gi');
  for (const sentence of sentencesOf(text)) {
    const names = new Set([...sentence.matchAll(service)].map((m) => m[0].toLowerCase().split(/[\s-]/)[0]));
    if (names.size >= 2 && /\b(better|more effective|less effective|superior|inferior|stronger|weaker|than|versus|vs\.?)\b/i.test(sentence)) return true;
  }
  return false;
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
  if (comparesServices(text) && !found.includes('service comparison')) found.push('service comparison');
  return found;
}

/** Therapies, services and the clinic itself: never a supporting phrase for an educational post. */
const OFF_LIMITS_PHRASE = /\b(stem[- ]?cells?|exosomes?|nk cells?|peptides?|prp|platelet|hbot|hyperbaric|red[- ]light|pemf|hydrogen|ozone|iv therapy|infusion|clinic|cellular institute|cellular hope|price|cost|near me|best|top)\b/i;

const PHRASE_STOP = new Set([
  'about', 'after', 'also', 'before', 'being', 'between', 'does', 'doing', 'during', 'each', 'every', 'from', 'have',
  'help', 'helps', 'into', 'just', 'like', 'many', 'mean', 'means', 'more', 'most', 'much', 'only', 'other', 'same',
  'should', 'some', 'such', 'than', 'that', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'through',
  'very', 'what', 'when', 'where', 'which', 'while', 'with', 'without', 'your', 'body', 'people', 'why', 'how',
]);

function subjectWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9áéíóúñü]+/)) {
    if (w.length >= 4 && !PHRASE_STOP.has(w)) {
      out.add(w);
      // "supplements" and "supplement", "sleeping" and "sleep": a crude stem is enough here.
      out.add(w.replace(/(ing|es|s)$/, ''));
    }
  }
  return out;
}

/**
 * The one search phrase a strategy post may use, if any.
 *
 * Research on the week's angle returns a primary keyword, related searches and
 * questions. The first that is ON the angle's subject (shares a content word
 * with it or its pillar), not commercial or transactional, and names no
 * therapy, service, price or the clinic, is offered to the writer — "use it
 * once if it reads naturally". Nothing else is: the phrase used to come from
 * whichever angle type the rotation landed on, and one week in four that was
 * a domain-wide procedure search on a post about sleep.
 */
export function pickSupportingPhrase(
  angle: string,
  pillarName: string,
  candidates: readonly { keyword: string; intents?: readonly string[] | null }[],
): string | undefined {
  const subject = subjectWords(angle + ' ' + pillarName);
  const angleKey = String(angle || '').trim().toLowerCase();
  for (const c of candidates) {
    const phrase = String(c?.keyword || '').trim();
    if (!phrase || phrase.toLowerCase() === angleKey) continue;
    const intents = (c.intents || []).map((i) => String(i).toLowerCase());
    if (intents.includes('commercial') || intents.includes('transactional')) continue;
    if (OFF_LIMITS_PHRASE.test(phrase) || promotionFlags(phrase, '').length) continue;
    const words = [...subjectWords(phrase)];
    if (!words.some((w) => subject.has(w))) continue;
    return phrase;
  }
  return undefined;
}
