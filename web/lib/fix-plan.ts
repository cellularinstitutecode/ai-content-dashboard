// web/lib/fix-plan.ts
// What the FIX button has to do for a run, decided from the same stamps and
// flags the review card draws its warnings from — so the button appears
// exactly when a warning does, and the server repairs exactly what is shown.
//
//   citation  the REF line: Crossref rejected it, could not check it, or the
//             judge found the paper does not back the copy (or never checked).
//   copy      the words: compliance flags, promotional habits, a repeated opening.
//   image     the picture: the checker flagged it (text, a banned prop, off-topic…).
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
// The repair itself lives in lib/autopilot.ts (fixRun).
import { imageUnshippable } from './image-verdict.ts';

export type FixStep = 'citation' | 'copy' | 'image';

export type FixInput = {
  /** `pack._compliance.citation.status` — Crossref's verdict on the REF line's DOI. */
  citation?: { status?: string | null } | null;
  /** `pack._claimSupport.status` — does the cited paper back the copy? */
  claimSupport?: { status?: string | null } | null;
  safetyFlags?: readonly { code?: string; message?: string }[] | null;
  promotionFlags?: readonly string[] | null;
  openingRepeat?: boolean | null;
  image?: {
    url?: string | null;
    source?: string | null;
    /** A library photo that went through the brand filter (lib/library-cover.ts) — checked like a cover. */
    brandGraded?: boolean | null;
    verification?: { status?: string | null; issues?: readonly string[]; textDetected?: boolean; bannedProp?: boolean } | null;
  } | null;
};

export type FixPlan = {
  /** In the order the repair runs: citation, copy, image. */
  steps: FixStep[];
  /** One short sentence per warning, as the card words it. */
  reasons: string[];
};

/** The statuses the card shows a citation warning for. */
const CITATION_OK = new Set(['verified', 'not_required']);
/** The claim-support verdicts the card shows a warning for. */
const CLAIM_BAD = new Set(['unsupported', 'unchecked']);

/** The run as GET /api/autopilot/runs returns it, reduced to what the plan reads. */
export function runFixInput(run: {
  score?: { safetyFlags?: readonly { code?: string; message?: string }[] | null; promotionFlags?: readonly string[] | null; openingRepeat?: boolean | null } | null;
  pack?: (Record<string, unknown> & {
    _image?: FixInput['image'];
    _compliance?: { citation?: FixInput['citation'] } | null;
    _claimSupport?: FixInput['claimSupport'];
  }) | null;
} | null | undefined): FixInput {
  return {
    citation: run?.pack?._compliance?.citation ?? null,
    claimSupport: run?.pack?._claimSupport ?? null,
    safetyFlags: run?.score?.safetyFlags ?? null,
    promotionFlags: run?.score?.promotionFlags ?? null,
    openingRepeat: run?.score?.openingRepeat ?? false,
    image: run?.pack?._image ?? null,
  };
}

/**
 * Is the picture one the card warns about?
 *
 * A clinic photo chosen as it is (or dropped in) is never generated over. A
 * library photo that went through the brand filter and the title was checked
 * like a cover, and a flag on it (a head under the title, the wrong subject)
 * is one FIX acts on — by making an AI image, since FIX cannot choose a photo.
 * An older "AI image styled after a library photo" is an AI image and is
 * regenerated like any other.
 */
export function imageFlagged(image: FixInput['image']): boolean {
  if (!image?.url) return false;
  if (['library', 'upload'].includes(String(image.source || '')) && !image.brandGraded) return false;
  const v = image.verification;
  return imageUnshippable(v) || v?.status === 'flagged';
}

/** What FIX does about a flagged picture: a fresh AI take, in place of an AI image or of a graded library photo. */
export function fixImageMode(image: FixInput['image']): 'ai' | 'library-to-ai' | null {
  if (!imageFlagged(image)) return null;
  return String(image?.source || '') === 'library' ? 'library-to-ai' : 'ai';
}

export function fixPlan(input: FixInput | null | undefined): FixPlan {
  const steps: FixStep[] = [];
  const reasons: string[] = [];
  const add = (step: FixStep, why: string) => { if (!steps.includes(step)) steps.push(step); reasons.push(why); };

  const citation = String(input?.citation?.status || '');
  if (citation && !CITATION_OK.has(citation)) {
    add('citation', citation === 'not_found' ? 'the cited study was not found'
      : citation === 'mismatch' ? 'the DOI points to a different paper'
      : citation === 'no_doi' ? 'the reference has no DOI'
      : 'the citation could not be verified');
  }
  const claim = String(input?.claimSupport?.status || '');
  if (CLAIM_BAD.has(claim)) {
    add('citation', claim === 'unsupported' ? 'the cited study does not clearly support the copy' : 'the citation was not checked against the copy');
  }

  const flags = input?.safetyFlags || [];
  if (flags.length) add('copy', flags.length + ' compliance flag(s)');
  const promo = input?.promotionFlags || [];
  if (promo.length) add('copy', 'reads as promotion');
  if (input?.openingRepeat) add('copy', 'opens like a recent post');

  if (imageFlagged(input?.image)) {
    const v = input?.image?.verification;
    add('image', fixImageMode(input?.image) === 'library-to-ai'
      ? 'the library photo was flagged (' + ((v?.issues || [])[0] || 'by the checker') + ') — FIX makes an AI image in its place; pick another library photo to keep a real one'
      : v?.textDetected ? 'text in the image' : imageUnshippable(v) ? 'a banned prop in the image' : 'the image was flagged');
  }

  const order: FixStep[] = ['citation', 'copy', 'image'];
  return { steps: order.filter((s) => steps.includes(s)), reasons };
}

/**
 * The two buttons a card shows: FIX for the copy and the picture, and "Fix
 * citation" for the citation alone (lib/autopilot.ts fixCitationOnly) — so
 * pressing for the citation never redrafts the post or changes its picture.
 */
export function splitFixPlan(plan: FixPlan): { general: FixPlan; citation: FixPlan } {
  const citationWhy = /cit|DOI|study|reference/i;
  return {
    general: { steps: plan.steps.filter((s) => s !== 'citation'), reasons: plan.reasons.filter((r) => !citationWhy.test(r) || /image|photo/i.test(r)) },
    citation: { steps: plan.steps.filter((s) => s === 'citation'), reasons: plan.reasons.filter((r) => citationWhy.test(r) && !/image|photo/i.test(r)) },
  };
}

/** True when the card shows any warning FIX can act on. */
export function needsFix(input: FixInput | null | undefined): boolean {
  return fixPlan(input).steps.length > 0;
}

/** "citation, copy and image" — the steps as the button's caption names them. */
export function fixStepsLabel(steps: readonly FixStep[]): string {
  if (steps.length <= 1) return steps[0] || '';
  return steps.slice(0, -1).join(', ') + ' and ' + steps[steps.length - 1];
}

/**
 * The redraft note FIX hands the writer, quoting each flag so the rewrite is
 * targeted: the flagged passages change and nothing else does.
 */
export function fixRedraftNote(input: FixInput | null | undefined, claim?: { title?: string | null; year?: number | null; abstract?: string | null; ref?: string | null } | null): string {
  const parts: string[] = ['Keep the post as it is except for what is listed here.'];
  const flags = (input?.safetyFlags || []).map((f) => String(f.message || f.code || '').trim()).filter(Boolean);
  if (flags.length) parts.push('Rephrase the passages behind these compliance flags: ' + flags.map((f) => '"' + f + '"').join(' '));
  const promo = (input?.promotionFlags || []).map(String).filter(Boolean);
  if (promo.length) parts.push('It reads as promotion — remove: ' + promo.join(', ') + '.');
  if (input?.openingRepeat) parts.push('The opening line repeats a recent post — start with a different first sentence.');
  if (claim) {
    const excerpt = String(claim.abstract || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    parts.push(
      'The cited study does not support what the post claims. Rewrite ONLY the sentence(s) that claim more than this study shows, so the post claims what it reports' +
      (claim.title ? ': "' + String(claim.title).trim() + '"' + (claim.year ? ' (' + claim.year + ')' : '') : '') +
      (excerpt ? ' — ' + excerpt : '') + '.' +
      (claim.ref ? ' Cite exactly this study: ' + String(claim.ref).trim() : ''),
    );
  }
  return parts.join(' ');
}

/** One sentence for the card after FIX ran. */
export function fixNote(result: { fixed: readonly string[]; remaining: readonly string[] }): string {
  const fixed = result.fixed.length ? 'Fixed: ' + result.fixed.join(', ') + '.' : 'Nothing needed fixing.';
  if (!result.remaining.length) return fixed + (result.fixed.length ? ' Everything was re-checked.' : '');
  return fixed + ' Still needs a look: ' + result.remaining.join('; ') + '.';
}

const REF_LINE = /^[ \t]*REF(?:ERENCIA)?[ \t]*[.:：][ \t]*\S.*$/gim;
const AVISO_LINE = /^[ \t]*AVISO\s+DE\s+PUBLICIDAD\b.*$/im;

/**
 * The copy carrying EXACTLY this REF line, in place of the one it had.
 *
 * In place, not recomposed: the article and the captions keep their own
 * layout, and only the reference changes. A second REF line goes; a caption
 * with none gets the line before its AVISO, or at the end.
 */
export function swapRefLine(text: string, refLine: string): string {
  const cite = String(refLine || '').trim().replace(/^REF(?:ERENCIA)?\s*[.:：]\s*/i, '').trim();
  const t = String(text || '').replace(/\r\n/g, '\n');
  if (!cite) return t;
  const line = 'REF: ' + cite;
  let seen = false;
  const swapped = t.replace(REF_LINE, () => { if (seen) return ''; seen = true; return line; });
  if (seen) return swapped.replace(/\n{3,}/g, '\n\n');
  const aviso = AVISO_LINE.exec(t);
  if (aviso) return t.slice(0, aviso.index).replace(/\s+$/, '') + '\n\n' + line + '\n' + t.slice(aviso.index);
  return t.replace(/\s+$/, '') + '\n\n' + line;
}

// ---------------------------------------------------------------------------
// FIX in the background: the status the card reads while it runs.
// ---------------------------------------------------------------------------
//
// FIX takes one to four minutes (a redraft, a citation search, a new picture).
// Held open as one request it covered the card with a loader that sat at 94%
// the whole time, and a request the platform cut off at five minutes left it
// there with nothing said. So the request only starts FIX (POST answers at
// once) and the work continues after the response; its progress lives on the
// run itself (`angle.fix`), which the card already reads and polls.

export type FixStatus = {
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  endedAt?: string;
  /** The step FIX is on right now (written as each one starts), so the card can say "now: the image". */
  step?: FixStep | null;
  /** The steps it set out to do. */
  steps?: FixStep[];
  /** fixNote() of the result, or why it stopped. */
  note?: string;
  /** What still needs a person; empty when everything was resolved. */
  remaining?: string[];
};

/**
 * A FIX still "running" after this long did not finish: the platform stops a
 * function at five minutes and nothing is left to write the result. The card
 * says so, and FIX can be pressed again. Ten minutes, so a slow but live FIX
 * (its budget is a little over four) is never called stuck while it works.
 */
export const FIX_STALE_MS = 10 * 60_000;

/** The one line a run that never finished gets — on the card, and in the run's log when the tick finds it. */
export const FIX_STALLED_NOTE = 'FIX did not finish — press it again. What it completed is saved.';

export type FixView =
  | { kind: 'running'; elapsedSec: number; startedAt: string; step: FixStep | null }
  | { kind: 'done'; note: string; clean: boolean }
  | { kind: 'stalled' }
  | null;

/** Is this FIX stamp a run that started and never wrote its result? */
export function fixStale(fix: FixStatus | null | undefined, now: number = Date.now()): boolean {
  if (!fix || fix.state !== 'running') return false;
  const started = Date.parse(String(fix.startedAt || ''));
  return !Number.isFinite(started) || now - started > FIX_STALE_MS;
}

/** What the card shows for a run's FIX, from `angle.fix`. */
export function fixView(angle: { fix?: FixStatus | null } | null | undefined, now: number = Date.now()): FixView {
  const f = angle?.fix;
  if (!f || !f.state) return null;
  if (f.state === 'running') {
    if (fixStale(f, now)) return { kind: 'stalled' };
    const started = Date.parse(String(f.startedAt || ''));
    return { kind: 'running', elapsedSec: Math.max(0, Math.floor((now - started) / 1000)), startedAt: String(f.startedAt), step: f.step || null };
  }
  const note = String(f.note || '').trim();
  if (!note) return null;
  return { kind: 'done', note, clean: f.state === 'done' && !(f.remaining || []).length };
}

/** Is a FIX working on this run right now (and not stalled)? */
export function fixRunning(angle: { fix?: FixStatus | null } | null | undefined, now: number = Date.now()): boolean {
  return fixView(angle, now)?.kind === 'running';
}
