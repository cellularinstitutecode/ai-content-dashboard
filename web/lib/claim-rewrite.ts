// web/lib/claim-rewrite.ts
// "Fix citation", last rung: no real study backs the post AS WRITTEN, so the
// sentences that claim more than the best real study shows are rewritten to
// claim what it reports — and nothing else in the post changes. Not a
// redraft: the opening, the voice, the hashtags, the AVISO and the picture
// all stay. A redraft (what FIX used to do here) wrote a new post and made a
// new picture with it, which is how "fix the citation" kept changing the image.
//
// Pure: the prompt and the guard on what comes back decide whether a rewrite
// is taken at all, so they are tested rather than trusted.
import { healthClaimWords, makesHealthClaim } from './health-claim.ts';

export type StudyForRewrite = { title?: string | null; year?: number | null; abstract?: string | null; ref: string };

export const CLAIM_REWRITE_SYSTEM = [
  'You edit social posts and articles for a regenerative-medicine clinic so that what they claim matches the study they cite.',
  'You are given one post and one study. Rewrite ONLY the sentence(s) that claim more than the study shows, so they claim what it reports — softer wording ("research suggests", "a study found", "may") and the study\'s own finding.',
  'Keep every other sentence exactly as it is: the opening line, the structure, the line breaks, the emojis, the hashtags, the call to action, the AVISO DE PUBLICIDAD line.',
  'The post must cite exactly the study given, on its REF line, in the same place the post had one (before the AVISO if there is one, otherwise at the end).',
  'Never add a claim the study does not make. Never mention a cure. Do not explain your edits.',
  'Answer with the full edited post and nothing else.',
].join('\n');

/**
 * The second pass, when the checker still finds the rewrite claiming more than
 * the study shows: every health statement either says only what the study
 * reports, in its own terms, or becomes general advice that claims nothing.
 */
export const CLAIM_REWRITE_STRICT_SYSTEM = CLAIM_REWRITE_SYSTEM + '\n' + [
  'STRICT PASS: a checker found that the post still claims more than the study shows.',
  'Go through every sentence that states or implies a health benefit, effect or outcome.',
  'Either state only what the study itself reports — its population, what was measured and what was found, with "a study found" or "research suggests" — or, when the study does not address it, turn the sentence into practical general advice that claims no benefit at all.',
  'Remove words such as "proven", "improves", "boosts", "reduces", "heals", "treats" unless the study reports exactly that.',
].join('\n');

export function claimRewritePrompt(text: string, study: StudyForRewrite): string {
  const abstract = String(study.abstract || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  return [
    'THE STUDY',
    'Title: ' + String(study.title || '').trim() + (study.year ? ' (' + study.year + ')' : ''),
    abstract ? 'What it reports: ' + abstract : 'What it reports: (no abstract — keep the claim to what the title says)',
    'REF line to use: REF: ' + refBody(study.ref),
    '',
    'THE POST',
    String(text || '').trim(),
  ].join('\n');
}

function refBody(ref: string): string {
  return String(ref || '').trim().replace(/^REF(?:ERENCIA)?\s*[.:：]\s*/i, '').trim();
}

/**
 * The model's rewrite, or null when it is not one to take: empty, a fenced
 * reply, a different post (it shrank or grew by more than half), or one that
 * lost the AVISO line or the study's REF.
 */
export function acceptRewrite(original: string, rewritten: unknown, ref: string): string | null {
  let out = String(rewritten ?? '').trim();
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  const before = String(original || '').trim();
  if (!out || !before) return null;
  const ratio = out.length / before.length;
  if (ratio < 0.5 || ratio > 1.5) return null;
  if (/AVISO\s+DE\s+PUBLICIDAD/i.test(before) && !/AVISO\s+DE\s+PUBLICIDAD/i.test(out)) return null;
  const body = refBody(ref);
  const doi = /10\.\d{4,9}\/\S+/.exec(body)?.[0]?.replace(/[.,;)]+$/, '');
  if (doi && !out.toLowerCase().includes(doi.toLowerCase())) return null;
  return out;
}

// ---------------------------------------------------------------------------
// IS THE STUDY EVEN ABOUT THIS? Asked before any rewrite toward it. Without it
// a post about keeping a journal was rewritten, on four channels, around
// "Coding Telemedicine Visits for Proper Reimbursement" — the best real paper
// the search happened to return, on a different subject entirely.
// ---------------------------------------------------------------------------

export const RELEVANCE_SYSTEM = [
  'You decide whether a study is about the same subject as a social post for a regenerative-medicine clinic.',
  'Answer "yes" only when the study is about what the post talks about — the same practice, condition, behaviour or outcome — so that citing it would make sense to a reader.',
  'A study that only shares a word, a setting (telemedicine, billing, a hospital) or a general field is "no".',
  'Answer with JSON only: {"onTopic": true} or {"onTopic": false}.',
].join('\n');

export function relevancePrompt(text: string, study: StudyForRewrite): string {
  const abstract = String(study.abstract || '').replace(/\s+/g, ' ').trim().slice(0, 900);
  return ['THE POST', String(text || '').trim().slice(0, 2500), '', 'THE STUDY', 'Title: ' + String(study.title || '').trim(), abstract ? 'Abstract: ' + abstract : ''].filter(Boolean).join('\n');
}

/** true / false from the model's answer; null when it said neither. */
export function parseRelevance(raw: unknown): boolean | null {
  const t = String(raw ?? '').trim();
  const m = /"onTopic"\s*:\s*(true|false)/i.exec(t);
  if (m) return m[1].toLowerCase() === 'true';
  if (/^\s*yes\b/i.test(t)) return true;
  if (/^\s*no\b/i.test(t)) return false;
  return null;
}

// ---------------------------------------------------------------------------
// NO STUDY ON THIS SUBJECT: the post claims nothing, and carries no citation.
// Allowed only where the template cites a study when the post makes a health
// claim (refPolicy 'if-health-claim'); the compliance rules then waive the REF
// line for a post that makes none (lib/health-claim.ts decides).
// ---------------------------------------------------------------------------

export const NO_CLAIM_SYSTEM = [
  'You edit a social post for a regenerative-medicine clinic so that it makes NO health claim and carries NO citation, because no study backs what it says.',
  'Turn every sentence that states or implies a health effect, benefit or outcome into practical, everyday advice that claims nothing — what to do, notice, write down or ask about, not what it will achieve.',
  'Delete the REF / REFERENCIA line entirely. Keep the AVISO DE PUBLICIDAD line exactly as it is.',
  'Keep the opening idea, the tone, the structure, the line breaks, the emojis, the hashtags and the call to action as far as possible.',
  'Avoid words that read as a health claim: heal, cure, improve, reduce, lower, boost, prevent, protect, relieve, restore, strengthen, enhance, faster, benefit, effective, safe; inflammation, immune, metabolism, hormone, cortisol, blood, circulation, muscle, joint, bone, tissue, cells, brain, heart, oxygen, recovery, repair, longevity, aging, energy levels; pain, symptoms, disease, condition, disorder, injury, arthritis, diabetes, treatment, therapy, protocol, diagnosis, clinical, medical, medication, supplement, vitamin, nutrient, protein, stem cells, regenerative; study, research, evidence, science, proven.',
  // "Whole foods are not a cure-all" kept the word, twice, and the checker
  // reads the word, not the sentence: a denial is still a claim-word in the
  // copy. The sentence goes, or is said another way.
  'Do not use any of those words even to say that something is NOT one — no "not a cure", no "not a cure-all", no "no quick fix for a condition". Say it another way, or leave the sentence out.',
  'Plain words such as "your care team", "your follow-up visit", "how you feel day to day", "your progress", "your plan" are fine.',
  'Answer with the full edited post and nothing else.',
].join('\n');

export function noClaimPrompt(text: string, flagged: readonly string[] = [], sentences: readonly string[] = []): string {
  const again = flagged.length
    ? 'A first edit still used these words, which read as a health claim — replace every one, even where the sentence says something is NOT one (drop the sentence if need be): ' + flagged.join(', ') + '\n\n'
    : '';
  // The sentences themselves, quoted: an edit told only the words kept the
  // sentence and swapped a synonym in; told the sentence, it rewrites or
  // drops it.
  const where = sentences.length
    ? 'These sentences must be rewritten so they claim nothing, or left out entirely:\n' + sentences.map((s) => '- "' + s + '"').join('\n') + '\n\n'
    : '';
  return again + where + 'THE POST\n' + String(text || '').trim();
}

/** Split the body of a post into sentences, line breaks respected, hashtags and the compliance lines left out. */
function sentencesOf(text: string): string[] {
  return stripRefLine(String(text || ''))
    .split('\n')
    .filter((l) => !/AVISO\s+DE\s+PUBLICIDAD/i.test(l) && !/^\s*(#\S+\s*)+$/.test(l))
    .flatMap((l) => l.split(/(?<=[.!?])\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The sentences of a post that use any of these words (each once, up to five), for the prompt. */
export function sentencesWith(text: string, words: readonly string[]): string[] {
  const list = words.map((w) => String(w || '').trim().toLowerCase()).filter(Boolean);
  if (!list.length) return [];
  const out: string[] = [];
  for (const s of sentencesOf(text)) {
    const low = s.toLowerCase();
    if (list.some((w) => low.includes(w)) && !out.includes(s)) out.push(s);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * THE LAST RESORT when no model edit claims nothing: the sentences that read
 * as a health claim are taken out, deterministically, and the REF line with
 * them. The AVISO, the hashtags, the line breaks and every other sentence
 * stay. The caller judges the result with acceptNoClaim — a post that lost
 * most of itself is not taken.
 */
export function dropClaimSentences(text: string): string {
  const lines = stripRefLine(String(text || '')).split('\n');
  const kept = lines.map((line) => {
    if (/AVISO\s+DE\s+PUBLICIDAD/i.test(line) || /^\s*(#\S+\s*)+$/.test(line) || !line.trim()) return line;
    const parts = line.split(/(?<=[.!?])\s+/);
    const clean = parts.filter((s) => !healthClaimWords(s).length);
    return clean.join(' ').trim();
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const REF_LINE_RE = /^[ \t]*REF(?:ERENCIA)?[ \t]*[.:：]/im;

/** The copy without its REF line(s), the rest untouched: a post that makes no health claim carries none. */
export function stripRefLine(text: string): string {
  return String(text || '').replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !/^[ \t]*REF(?:ERENCIA)?[ \t]*[.:：][ \t]*\S/i.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The no-claim rewrite, or why it is not one to take: it must keep the AVISO,
 * drop the REF line, stay the same post (half to one and a half its length),
 * and claim nothing by the rule the compliance check uses.
 */
export function acceptNoClaim(original: string, rewritten: unknown): { text: string | null; flagged: string[] } {
  let out = String(rewritten ?? '').trim();
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  const before = String(original || '').trim();
  if (!out || !before) return { text: null, flagged: [] };
  const ratio = out.length / before.length;
  if (ratio < 0.4 || ratio > 1.5) return { text: null, flagged: [] };
  if (/AVISO\s+DE\s+PUBLICIDAD/i.test(before) && !/AVISO\s+DE\s+PUBLICIDAD/i.test(out)) return { text: null, flagged: [] };
  if (REF_LINE_RE.test(out)) return { text: null, flagged: [] };
  // A notice with no post left above it is not a post: nothing but the AVISO
  // and hashtags survived.
  const bodyLeft = out.split('\n').filter((l) => !/AVISO\s+DE\s+PUBLICIDAD/i.test(l) && !/^\s*(#\S+\s*)+$/.test(l)).join('').trim();
  if (!bodyLeft) return { text: null, flagged: [] };
  if (makesHealthClaim(out)) return { text: null, flagged: healthClaimWords(out) };
  return { text: out, flagged: [] };
}
