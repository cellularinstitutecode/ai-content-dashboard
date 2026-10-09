// web/lib/cover-edit.ts
// The "Edit image" panel's decisions — what can be done to a draft's picture
// WITHOUT spending an image credit, and when a credit needs a second look.
//
//   retitle     a planner cover is a clean, verified photograph with the title
//               painted on top by lib/title-cover.ts, and the clean photo is
//               kept beside it (`_image.titled.photoUrl`). Re-setting the words
//               is therefore a render, not a generation: free. A picture made
//               before covers existed has no clean photo and cannot be retitled.
//   notes       what the team wrote for the picture, kept on `_image.direction`
//               so the next "New image" / "Show me 3 options" reuses it.
//   credits     the panel is open by default, so the buttons that spend credits
//               say so, and after a few takes on one draft they ask first.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { MAX_COVER_TITLE, variedTitle } from './planner-image.ts';

/** As much of `_image` as these decisions read. */
export type EditableImage = {
  url?: string | null;
  source?: string | null;
  titled?: { title: string; photoUrl: string; family?: string; custom?: boolean } | null;
  direction?: string | null;
  takes?: number | null;
  verification?: { headTopPct?: number | null } | null;
};

/** The one line the disabled button shows for a picture with no clean photograph behind it. */
export const NO_CLEAN_PHOTO = 'This picture was made before retitling existed — make a new image first';

export type RetitleDecision =
  | { ok: true; photoUrl: string; headTopPct: number | null }
  | { ok: false; reason: string };

/**
 * Can this picture be retitled for free, and from which photograph?
 *
 * A titled cover keeps its clean photo. A library photo or an upload that was
 * never titled IS the clean photo, so a title can go straight onto it. An AI
 * take from before covers existed has only the picture as generated — the
 * title on it (if any) was painted by the model — so there is nothing to
 * re-render from.
 */
export function retitleDecision(image: EditableImage | null | undefined): RetitleDecision {
  if (!image || !image.url) return { ok: false, reason: 'There is no picture on this draft yet.' };
  const headTopPct = image.verification?.headTopPct ?? null;
  const kept = String(image.titled?.photoUrl || '').trim();
  if (kept) return { ok: true, photoUrl: kept, headTopPct };
  if (['library', 'upload'].includes(String(image.source || ''))) return { ok: true, photoUrl: String(image.url), headTopPct };
  return { ok: false, reason: NO_CLEAN_PHOTO };
}

/** A title as typed, made fit for the cover: one line, no quotes, no trailing stop, at most MAX_COVER_TITLE characters. */
export function cleanCoverTitle(input: unknown): string {
  const t = String(input ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (t.length <= MAX_COVER_TITLE) return t;
  return t.slice(0, MAX_COVER_TITLE).replace(/\s+\S*$/, '').replace(/[,;:\-–—]\s*$/, '').trim();
}

/** The words on the cover now: the set title (possibly ''), else the planner's. */
export function currentCoverTitle(image: EditableImage | null | undefined, plannerTitle: string | null | undefined): string {
  if (image?.titled) return String(image.titled.title ?? '');
  return String(plannerTitle || '');
}

/** True when the picture is shown without a title on purpose. */
export function titleOff(image: EditableImage | null | undefined): boolean {
  return Boolean(image?.titled) && String(image!.titled!.title ?? '') === '';
}

/**
 * Would "Apply title" change the picture? True when the words differ from
 * the ones painted on it, when the title is off, and — the case the button
 * used to miss — when NOTHING is painted yet: a library photo or an upload
 * has no cover, and the field opens pre-filled with the draft's title, so
 * "unchanged words" was read as nothing to do while the photo still had no
 * title at all.
 */
export function titleApplyable(image: EditableImage | null | undefined, title: string, shown: string): boolean {
  const words = cleanCoverTitle(title);
  if (!words) return false;
  if (!image?.titled || titleOff(image)) return true;
  return words !== cleanCoverTitle(shown);
}

/** The notes the last take was made with, for the panel to show again. */
export function notesOf(image: EditableImage | null | undefined): string {
  return String(image?.direction || '').trim();
}

// --- CREDITS ----------------------------------------------------------------

/** From this many generations on one draft, a credit-spending button asks first. */
export const CONFIRM_CREDITS_AFTER = 3;

/** How many image generations this draft has had (counted on `_image.takes`). */
export function takesOf(image: EditableImage | null | undefined): number {
  const n = Number(image?.takes);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Ask before spending? Only once a draft has already had CONFIRM_CREDITS_AFTER generations. */
export function needsCreditConfirm(takes: number): boolean {
  return takes >= CONFIRM_CREDITS_AFTER;
}

/** The one question asked before a credit is spent on a much-rerolled draft. */
export function creditConfirmText(credits: number, takes: number): string {
  const c = Math.max(1, Math.round(credits));
  return `This draft has already had ${takes} image generation${takes === 1 ? '' : 's'}. Spend ${c} more credit${c === 1 ? '' : 's'} on a new one?`;
}

/** The label suffix every credit-spending button carries. */
export function creditLabel(credits: number): string {
  const c = Math.max(1, Math.round(credits));
  return `· ${c} credit${c === 1 ? '' : 's'}`;
}

// --- TITLE SUGGESTIONS --------------------------------------------------------

/**
 * The feed is the baseline: its covers read "Evening Routines Matter",
 * "Everyday Habits Shape How You Feel", "The Connection Between Food and
 * Energy", "Fiber First", "Start With What You Drink" — a plain, calm
 * statement of what the post is about, never a claim. Titles are written in
 * that voice, from the post itself, so no two posts wear the same words.
 */
export const TITLE_STYLE_EXAMPLES = ['Evening Routines Matter', 'Everyday Habits Shape How You Feel', 'The Connection Between Food and Energy', 'Fiber First', 'Start With What You Drink', 'Organized. Professional. Human.'] as const;

export const SUGGEST_TITLES_SYSTEM =
  'You write cover titles for a clinic\'s educational social posts. The title is set in large serif type over a photograph, ' +
  'in the voice of the clinic\'s own feed — plain, calm statements of what the post is about, like ' + TITLE_STYLE_EXAMPLES.map((t) => '"' + t + '"').join(', ') + '. ' +
  'Two to seven words in title case, written from THIS post\'s own subject (its first lines carry it). Rules: no claim, ' +
  'no number, no promise, no outcome; never name a person or a therapy; no question marks, no emoji, no quotation marks, no ' +
  'trailing full stop; at most ' + MAX_COVER_TITLE + ' characters and ideally under 34. Answer with a JSON array of the titles asked for and nothing else.';

/** The material the suggester reads: the angle, the pillar, and what the post says. */
export function suggestTitlesPrompt(input: { angle: string; pillarName?: string | null; copy?: string | null; current?: string | null; avoid?: readonly string[]; count?: number }): string {
  const count = Math.max(1, Math.min(5, Math.round(input.count ?? 3)));
  const parts: string[] = [];
  parts.push('ANGLE: ' + String(input.angle || '').trim());
  if (input.pillarName) parts.push('THEME: ' + String(input.pillarName).trim());
  const avoid = [String(input.current || '').trim(), ...(input.avoid || []).map((a) => String(a || '').trim())].filter(Boolean);
  if (avoid.length) parts.push('ALREADY USED (do not repeat these, or near-copies): ' + avoid.map((a) => '"' + a + '"').join(', '));
  // Hashtags keep their words: "#recovery" says what the post is about.
  const copy = String(input.copy || '').replace(/#(?=[\w-])/g, '').replace(/\s+/g, ' ').trim();
  if (copy) parts.push('THE POST: ' + copy.slice(0, 1200));
  parts.push((count === 1 ? 'One title' : count + ' different titles') + ', as a JSON array:');
  return parts.join('\n');
}

/**
 * The titles out of the model's answer. A JSON array first; lines as a
 * fallback. Cleaned like a typed title, deduplicated, never the one already on
 * the cover, at most `max`.
 */
export function parseTitleList(raw: unknown, opts: { max?: number; avoid?: readonly string[] } = {}): string[] {
  const max = opts.max ?? 3;
  const avoid = new Set((opts.avoid || []).map((a) => cleanCoverTitle(a).toLowerCase()).filter(Boolean));
  const text = String(raw ?? '').trim();
  let items: unknown[] = [];
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) {
    try { items = JSON.parse(arr[0]); } catch { items = []; }
    if (!Array.isArray(items)) items = [];
  }
  if (!items.length) {
    items = text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  }
  const out: string[] = [];
  for (const it of items) {
    const t = cleanCoverTitle(typeof it === 'string' ? it : (it && typeof it === 'object' && 'title' in it ? (it as { title: unknown }).title : ''));
    if (!t || /[?!]/.test(t) || /^(i\b|sure|here|okay|ok\b|as an|sorry)/i.test(t)) continue;
    const k = t.toLowerCase();
    if (avoid.has(k) || out.some((o) => o.toLowerCase() === k)) continue;
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Suggestions with no model at hand: the same framings the planner steps through. */
export function fallbackTitles(current: string, max = 3): string[] {
  const base = cleanCoverTitle(current);
  if (!base) return [];
  const out: string[] = [];
  for (let i = 1; out.length < max && i <= 8; i++) {
    const t = variedTitle(base, i);
    if (t !== base && !out.includes(t)) out.push(t);
  }
  return out;
}
