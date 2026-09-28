// web/lib/strategy-variety.ts
// The other things that change when a pillar comes back.
//
// The document's governing rule is "each time a pillar returns, the angle,
// question, format, or audience should change". Until now only the angle did
// (lib/strategy-rotation.ts), so every post was the same shape — one titled
// photograph over an explainer caption closing "save this" — for the same
// reader. And when a bank came round after five or six weeks, the whole post
// recurred: the same angle, the same shape, the same reader, the same close.
//
// So each occurrence of a slot is also dealt:
//
//   FORMAT   the caption's structure: an explainer, a checklist, myth vs fact,
//            a patient's question answered, an everyday scenario, one thing to
//            try this week. Text shapes only — every post keeps its single
//            image, as the clinic chose.
//   AUDIENCE who the post is written for, drawn from the document's own
//            readers for that pillar (adults over 40, 50 or 60; a patient
//            preparing for treatment; a patient back home; someone travelling
//            from the United States or Canada; a companion on the trip).
//   CLOSING  the gentle next step: save it, share it, ask your physician, a
//            question back to the reader, one thing to try. Every post used to
//            be steered to the same line. This one is the clinic's addition —
//            the document does not name closings.
//
// Some shapes do not fit some pillars (PILLAR_FORMAT_EXCLUDE): a "try this"
// or "myth vs fact" post about flights and hotels drifts into a health claim,
// which the destination posts are waived from citing.
//
// The deal is a pure function of the week, like the angle's. Its guarantees:
// a slot never repeats last week's format or closing; an angle that comes
// round again never comes back in the format or for the reader it had last
// time; and formats are spread across the week so the feed is not seven
// checklists in a row.
//
// Pure: imports only ./strategy-rotation.ts, ./content-strategy.ts and ./compliance.ts.
import { BLOG_SLOT_KEY, WEEK, slotKey } from './content-strategy.ts';
import { DEAL_ORDER, dealtWeek } from './strategy-rotation.ts';
import { stripComplianceLines } from './compliance.ts';

export type PostFormat = 'explainer' | 'checklist' | 'myth-fact' | 'q-and-a' | 'scenario' | 'try-this';
export type Audience = 'general' | 'considering' | 'preparing' | 'after-care' | 'over-40' | 'traveller' | 'companion';
export type Closing = 'save' | 'share' | 'ask-physician' | 'reflect' | 'try';

export const FORMATS: Record<PostFormat, { label: string; brief: string }> = {
  explainer: {
    label: 'Explainer',
    brief: 'Shape: a short explainer — what it is, why it matters, and one practical takeaway.',
  },
  checklist: {
    label: 'Checklist',
    brief: 'Shape: a checklist — a one-line lead-in, then 3 to 5 short, practical points, one per line.',
  },
  'myth-fact': {
    label: 'Myth vs fact',
    brief: 'Shape: myth vs fact — open with a common belief, stated as a belief ("Many people think…", never as a claim of your own), then set it straight with what is actually known, calmly and without mocking anyone.',
  },
  'q-and-a': {
    label: 'Q&A',
    brief: 'Shape: a question patients genuinely ask about this, answered plainly in the care team\'s voice.',
  },
  scenario: {
    label: 'Everyday scenario',
    brief: 'Shape: a short, hypothetical everyday situation (no names, no quotes, not a patient\'s story — just "someone who…") that shows the point in real life, then the takeaway. No before and after, and no result or outcome for that person.',
  },
  'try-this': {
    label: 'Try this week',
    brief: 'Shape: one practical thing the reader can try this week, why it helps, and when to check with a physician first.',
  },
};

export const AUDIENCES: Record<Audience, { label: string; brief: string }> = {
  general: { label: 'Everyone', brief: 'anyone who wants to look after their health' },
  considering: { label: 'Considering care', brief: 'someone considering a medical evaluation or treatment for the first time' },
  preparing: { label: 'Preparing', brief: 'a patient preparing for an upcoming treatment' },
  'after-care': { label: 'Back home', brief: 'a patient back home after treatment' },
  'over-40': { label: 'Over 40', brief: 'adults over 40, 50 or 60 who want to keep active' },
  traveller: { label: 'Travelling', brief: 'someone travelling, including from the United States or Canada' },
  companion: { label: 'Companion', brief: 'a family member or friend travelling with a patient' },
};

export const CLOSINGS: Record<Closing, { label: string; brief: string }> = {
  save: { label: 'Save', brief: 'Close by inviting the reader to save the post for when they need it.' },
  share: { label: 'Share', brief: 'Close by inviting the reader to share it with someone it would help.' },
  'ask-physician': { label: 'Ask your physician', brief: 'Close by suggesting they talk it through with their physician.' },
  reflect: { label: 'Question back', brief: 'Close with one short question back to the reader about their own routine or experience (e.g. "What does your evening look like?").' },
  try: { label: 'Try it', brief: 'Close with a simple "try this today" step.' },
};

/**
 * Who each day page's bank is written for, from the document's own words:
 * "Maintaining muscle mass after 40, 50, or 60", "How to prepare the body
 * nutritionally before treatment", "What happens after a patient returns
 * home", "Air connectivity from the United States and Canada", "What a
 * companion can do during the trip".
 */
export const PILLAR_AUDIENCES: Record<string, Audience[]> = {
  diagnosis: ['considering', 'general', 'preparing'],
  protocols: ['considering', 'preparing', 'general'],
  nutrition: ['general', 'preparing', 'after-care'],
  supplementation: ['general', 'considering', 'preparing'],
  movement: ['over-40', 'general', 'after-care'],
  sleep: ['general', 'after-care', 'preparing'],
  prevention: ['over-40', 'general', 'considering'],
  cancun: ['traveller', 'companion', 'general'],
  'follow-up': ['after-care', 'preparing', 'general'],
  recovery: ['after-care', 'preparing', 'general'],
  'active-living': ['over-40', 'general', 'traveller'],
  'practical-nutrition': ['general', 'traveller', 'after-care'],
  stress: ['general', 'after-care', 'preparing'],
  'recovery-cancun': ['traveller', 'companion', 'after-care'],
};

/**
 * Closings that do not fit a pillar. "Talk it through with your physician"
 * or "try this today" reads oddly at the end of a post about flights and
 * hotels, or about what a companion can do during the trip.
 */
export const PILLAR_CLOSING_EXCLUDE: Record<string, Closing[]> = {
  cancun: ['ask-physician', 'try'],
  'recovery-cancun': ['ask-physician'],
};

/**
 * Shapes that do not fit a pillar.
 *
 *   Cancun: "try this", "myth vs fact" and an everyday scenario each pull the
 *   writer toward a health claim, which a destination post is waived from
 *   citing — so the post would then need a REF it was told not to reach for,
 *   and be refused at approval.
 *   Recovery and supplementation: "one thing to try this week" becomes a
 *   recommendation of a service or a supplement, which the document says to
 *   introduce, never to promote, and to personalise.
 */
export const PILLAR_FORMAT_EXCLUDE: Record<string, PostFormat[]> = {
  cancun: ['try-this', 'myth-fact', 'scenario'],
  'recovery-cancun': ['try-this', 'myth-fact', 'scenario'],
  recovery: ['try-this'],
  supplementation: ['try-this'],
};

const FORMAT_ORDER = Object.keys(FORMATS) as PostFormat[];
const CLOSING_ORDER = Object.keys(CLOSINGS) as Closing[];

export type Variety = { format: PostFormat; audience: Audience; closing: Closing };
export type DealtVariety = Record<string, Variety>;

type SlotMemory = {
  last: Variety | null;
  /** What each angle had the last time this slot wrote it. */
  byAngle: Map<string, Variety>;
};

const cache: { weeks: DealtVariety[]; memory: Record<string, SlotMemory> } = { weeks: [], memory: {} };

/** Rotation order starting at `start`, as a list. */
function rotated<T>(items: readonly T[], start: number): T[] {
  const n = items.length;
  const s = ((start % n) + n) % n;
  return [...items.slice(s), ...items.slice(0, s)];
}

function formatsExcludedFor(key: string): number {
  const slot = WEEK.find((s) => slotKey(s) === key);
  return slot ? (PILLAR_FORMAT_EXCLUDE[slot.pillarId] || []).length : 0;
}

function dealVarietyWeek(w: number): DealtVariety {
  const angles = dealtWeek(w);
  const out: DealtVariety = {};
  const formatCount = new Map<PostFormat, number>();
  // The slots with the fewest shapes to choose from pick first, so the spread
  // across the week is not left to them at the end. The rotation offset stays
  // each slot's place in DEAL_ORDER.
  const order = DEAL_ORDER.map((key, index) => ({ key, index }))
    .sort((a, b) => formatsExcludedFor(b.key) - formatsExcludedFor(a.key) || a.index - b.index);
  order.forEach(({ key, index }) => {
    if (key === BLOG_SLOT_KEY) return;
    const slot = WEEK.find((s) => slotKey(s) === key);
    const angle = angles[key];
    if (!slot || !angle) return;
    const mem = cache.memory[key] || (cache.memory[key] = { last: null, byAngle: new Map() });
    const before = mem.byAngle.get(angle);

    // Format: never last week's, never what this angle had last time; among
    // the rest, the one used least so far this week, in rotation order.
    const formatExcluded = PILLAR_FORMAT_EXCLUDE[slot.pillarId] || [];
    const formats = rotated(FORMAT_ORDER, w + index).filter((f) => !formatExcluded.includes(f));
    let options = formats.filter((f) => f !== mem.last?.format && f !== before?.format);
    if (!options.length) options = formats;
    let format = options[0];
    for (const f of options) if ((formatCount.get(f) || 0) < (formatCount.get(format) || 0)) format = f;
    formatCount.set(format, (formatCount.get(format) || 0) + 1);

    // Audience: never the reader this angle was written for last time; if
    // possible not last week's either.
    const pool = rotated(PILLAR_AUDIENCES[slot.pillarId] || ['general'], w + index);
    const audience =
      pool.find((a) => a !== before?.audience && a !== mem.last?.audience) ||
      pool.find((a) => a !== before?.audience) ||
      pool[0];

    // Closing: never last week's, and moving on each week. Never "try this
    // today" under a post that is already one thing to try.
    const excluded = [...(PILLAR_CLOSING_EXCLUDE[slot.pillarId] || []), ...(format === 'try-this' ? (['try'] as Closing[]) : [])];
    const closings = rotated(CLOSING_ORDER, w + index).filter((c) => !excluded.includes(c));
    const closing = closings.find((c) => c !== mem.last?.closing && c !== before?.closing) || closings[0];

    const v: Variety = { format, audience, closing };
    out[key] = v;
    mem.last = v;
    mem.byAngle.set(angle, v);
  });
  return out;
}

/** The format, audience and closing each social slot gets in week `w`. Deterministic; memoised. */
export function dealtVariety(w: number): DealtVariety {
  const target = Math.max(0, Math.trunc(w));
  while (cache.weeks.length <= target) cache.weeks.push(dealVarietyWeek(cache.weeks.length));
  return cache.weeks[target];
}

/** One slot's variety for week `w`, or null (the article, an unknown slot, a week before the epoch). */
export function varietyFor(key: string | null | undefined, w: number | null | undefined): Variety | null {
  if (!key || w == null || w < 0) return null;
  return dealtVariety(w)[String(key)] ?? null;
}

/** The three lines the writer is given for a variety. */
export function varietyBriefs(v: Variety | null | undefined): { format: string; audience: string; closing: string } | null {
  if (!v) return null;
  const f = FORMATS[v.format];
  const a = AUDIENCES[v.audience];
  const c = CLOSINGS[v.closing];
  if (!f || !a || !c) return null;
  return { format: f.brief, audience: a.brief, closing: c.brief };
}

/** Short labels for the review card. */
export function varietyLabels(v: { format?: string | null; audience?: string | null } | null | undefined):{ format: string; audience: string } | null {
  if (!v || !v.format || !v.audience) return null;
  const f = FORMATS[v.format as PostFormat];
  const a = AUDIENCES[v.audience as Audience];
  return f && a ? { format: f.label, audience: a.label } : null;
}

/**
 * Does the post end with the closing it was dealt?
 *
 * Only the last few lines of the body count (no REF, no AVISO, no hashtags):
 * a Q&A that OPENS "How do you know if…" has not closed with a question back.
 * And each closing has its own words — "Give it a try tonight", "Which of
 * these do you already do?" — which the one shared pattern missed, so a post
 * that did exactly what it was told lost its fifteen points and was rewritten
 * toward "save this".
 */
const CLOSING_RE: Record<Closing, RegExp> = {
  save: /\b(save|bookmark|keep) (this|it)\b|\bsave\b/i,
  share: /\b(share|send|forward|pass) (this|it)\b|\bshare (with|it)\b|\btag someone\b/i,
  'ask-physician': /\b(talk|speak|check|ask|discuss|chat|rais)(s|es|ed|ing|e)?\b[^.?!\n]{0,50}\b(physician|doctor|care team|healthcare provider|medical team)\b/i,
  reflect: /\?\s*$/m,
  try: /\btry\b|\bgive it a go\b/i,
};

export function closingPresent(text: string, closing: Closing | string | null | undefined): boolean {
  const re = closing ? CLOSING_RE[closing as Closing] : undefined;
  if (!re) return false;
  const lines = stripComplianceLines(String(text || ''))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(#\S+\s*)+$/.test(l));
  const tail = lines.slice(-3).join('\n');
  return re.test(tail);
}

/** The critique line for a missing closing: the one the post was dealt. */
export function closingCritique(closing: Closing | string | null | undefined): string | null {
  const c = closing ? CLOSINGS[closing as Closing] : undefined;
  return c ? 'End with the step this post was given. ' + c.brief : null;
}
