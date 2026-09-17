// web/lib/title-writer.ts
// A title written from what was actually said.
//
// The title came from the filename, then (once the filename turned out to say
// nothing) from the keyword search. Both are guesses about a video from
// outside it. The words the speaker used are in the transcript, and the post's
// own copy has already been written from them — so the title can come from the
// same place the post did:
//
//   "Instead of the keyword search I want to make sure it drafts it with AI
//    taking into consideration what was said from the copy and the
//    transcription of the video."
//
// WHAT THIS DOES NOT DO. It does not get to decide what is publishable. Its
// answer goes through lib/post-title.ts exactly like a title typed by a person:
// a name from the strip list is refused, the clinic's name is added once, and
// anything absurd falls through to the rung below. A model writing the title is
// a better guess, not a trusted one.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.

/** All the transcript worth reading for six words of title. */
export const MAX_TRANSCRIPT_CHARS = 3000;
/** And all the copy. */
export const MAX_COPY_CHARS = 1500;
/** Longer than this is a sentence, not a title. */
export const MAX_TITLE_CHARS = 70;

export const TITLE_SYSTEM =
  'You write the public title of a short clinic video for YouTube and TikTok. ' +
  'You are given what the speaker actually said and the post that was written from it.\n\n' +
  'Write ONE title, and nothing else. Rules:\n' +
  '- Say what the video is ABOUT, in the words a patient would use. Six words or fewer is ideal; never more than ten.\n' +
  '- Take it from the material given. Do not add a claim, a number, an outcome or a promise that is not in it.\n' +
  '- NEVER name a person: no patient, presenter, staff member or uploader, and no partner company.\n' +
  '- No file names, no "Reel", no hashtags, no emoji, no quotation marks, no trailing full stop.\n' +
  '- Do not add the clinic’s name — it is appended afterwards.\n' +
  '- Plain title case. Not a question, not a slogan, not clickbait.\n\n' +
  'Answer with the title alone, on one line.';

/** The material, in the order that matters: what was said, then what was written. */
export function titlePrompt(input: { transcript?: string | null; copy?: string | null; subject?: string | null }): string {
  const parts: string[] = [];
  const subject = String(input.subject || '').trim();
  if (subject) parts.push('SUBJECT (may be unreliable — it often comes from a file name): ' + subject);
  const transcript = String(input.transcript || '').replace(/\s+/g, ' ').trim();
  if (transcript) {
    parts.push('');
    parts.push('WHAT THE SPEAKER SAID:');
    parts.push(transcript.slice(0, MAX_TRANSCRIPT_CHARS));
  }
  const copy = String(input.copy || '').replace(/\r\n/g, '\n').trim();
  if (copy) {
    parts.push('');
    parts.push('THE POST WRITTEN FROM IT:');
    parts.push(copy.slice(0, MAX_COPY_CHARS));
  }
  parts.push('');
  parts.push('The title, on one line:');
  return parts.join('\n');
}

/**
 * The title out of the model's answer.
 *
 * Defensive in the same way lib/claim-support.ts is: everything ambiguous
 * becomes '' — which means "use the rung below" — rather than a title. A model
 * that explains itself, apologises, or answers in three lines must not have its
 * first sentence published on the clinic's channel.
 */
export function readTitle(text: string | null | undefined): string {
  const first = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  const cleaned = first
    // Quotes, a leading "Title:", a trailing full stop, stray markdown.
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/^(title|título)\s*[:\-—]\s*/i, '')
    .replace(/^[*#\s]+/, '')
    // Trailing emphasis as well as leading: a model that answers
    // "**Peptide Formulations**" was otherwise titled with the asterisks still
    // on the end, which is the kind of thing nobody notices until it is public.
    .replace(/[*_\s]+$/, '')
    .replace(/[.\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length > MAX_TITLE_CHARS) return '';
  // A refusal, a preamble, or a model talking about the task rather than doing it.
  if (/^(i\b|sure|here|okay|ok\b|as an|sorry)/i.test(cleaned)) return '';
  if (/[#@]|https?:\/\//i.test(cleaned)) return '';
  // Must contain actual words.
  if (!/[A-Za-zÀ-ÿ]{3}/.test(cleaned)) return '';
  return cleaned;
}
