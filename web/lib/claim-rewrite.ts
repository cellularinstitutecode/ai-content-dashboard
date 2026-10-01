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

export type StudyForRewrite = { title?: string | null; year?: number | null; abstract?: string | null; ref: string };

export const CLAIM_REWRITE_SYSTEM = [
  'You edit social posts and articles for a regenerative-medicine clinic so that what they claim matches the study they cite.',
  'You are given one post and one study. Rewrite ONLY the sentence(s) that claim more than the study shows, so they claim what it reports — softer wording ("research suggests", "a study found", "may") and the study\'s own finding.',
  'Keep every other sentence exactly as it is: the opening line, the structure, the line breaks, the emojis, the hashtags, the call to action, the AVISO DE PUBLICIDAD line.',
  'The post must cite exactly the study given, on its REF line, in the same place the post had one (before the AVISO if there is one, otherwise at the end).',
  'Never add a claim the study does not make. Never mention a cure. Do not explain your edits.',
  'Answer with the full edited post and nothing else.',
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
