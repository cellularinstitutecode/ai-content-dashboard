// web/lib/draft-defect.ts
// What is wrong with this draft, and what to tell the writer about it.
//
// prepareVideo asked the writer for copy exactly once and then refused the
// whole video if that single draft was unusable — no REF line, or a person
// named in it. Both are model-output failures, not facts about the video: the
// prompt is identical, the temperature is 0.4, and the transcript is already
// paid for and cached by the time either is discovered. Asking again is
// cheap and usually enough.
//
// Two of those refusals are classified TERMINAL in lib/failure-kind.ts, so
// nothing ever comes back to them — which made a single bad draft the end of
// that video until a person noticed. This is the check that decides whether a
// second draft is worth asking for, and what to say when asking.
//
// No imports, deliberately: the test runner strips types and runs this file
// directly. It is handed the facts (the extracted REF, the names that leaked)
// rather than the text, so the compliance and naming regexes stay in the one
// place each already lives.

export type DefectKind = 'no_citation' | 'named_a_person';

export type DraftDefect = {
  /**
   * Which refusal this becomes if the re-roll does not fix it.
   *
   * A leaked name outranks a missing citation: a clinic appearing to quote a
   * patient who never spoke is the worse of the two to publish.
   */
  kind: DefectKind;
  /** Appended to the writer's brief on the next attempt. */
  corrective: string;
};

/**
 * Phrased like the corrective already in lib/ai.ts for a DOI Crossref rejects:
 * name what the previous draft did, then say what to do instead. Vague
 * encouragement ("remember the citation") is what the original prompt already
 * said, and it did not work the first time.
 */
const REF_CORRECTIVE =
  'IMPORTANT: your previous draft contained no REF line at all. Every draft MUST cite a real, published study — ' +
  'a line beginning "REF:" naming the authors, journal and year, with a real DOI. It is not optional: this is a ' +
  'medical advertisement and it cannot be published without one.';

function nameCorrective(leaked: readonly string[]): string {
  return (
    'IMPORTANT: your previous draft named ' + leaked.map((n) => '"' + n + '"').join(' and ') + '. ' +
    'That is the person who filmed or uploaded the video, not somebody speaking in it. Never name any individual — ' +
    'no patient, presenter, staff member or uploader — and never attribute a quote or an experience to a named person. ' +
    'Write as the clinic sharing its own video.'
  );
}

/**
 * Is this draft publishable, and if not, what should the writer be told?
 *
 * Both problems are reported together when both are present, so one more
 * attempt can fix both rather than trading one refusal for the other.
 *
 * @param ref the citation extracted from the composed copy; empty means none
 * @param leaked names the guard found in the copy
 */
export function draftDefect(ref: string, leaked: readonly string[]): DraftDefect | null {
  const correctives: string[] = [];
  if (leaked.length) correctives.push(nameCorrective(leaked));
  if (!String(ref || '').trim()) correctives.push(REF_CORRECTIVE);
  if (!correctives.length) return null;
  return {
    kind: leaked.length ? 'named_a_person' : 'no_citation',
    corrective: correctives.join('\n\n'),
  };
}
