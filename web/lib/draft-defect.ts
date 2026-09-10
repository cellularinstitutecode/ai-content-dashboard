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

export type DefectKind = 'no_citation' | 'named_a_person' | 'repeats_opening';

export type DraftDefect = {
  /**
   * Which refusal this becomes if the re-roll does not fix it.
   *
   * A leaked name outranks a missing citation: a clinic appearing to quote a
   * patient who never spoke is the worse of the two to publish.
   *
   * 'repeats_opening' is the exception and does NOT become a refusal. A caption
   * that opens like last week's is worth one more attempt and nothing more —
   * refusing the video over it would hold back a perfectly publishable post
   * over a matter of style, and leave the row waiting on a person who never
   * asked to be involved. See `blocking` below and its use in
   * lib/video-prepare.ts.
   */
  kind: DefectKind;
  /** Appended to the writer's brief on the next attempt. */
  corrective: string;
  /**
   * Should the video be REFUSED if the last attempt still has this defect?
   *
   * Explicit rather than derived from `kind`, because the refusal in
   * lib/video-prepare.ts used to read "if (defect) ... else no_citation" — an
   * else-branch that turns any future defect kind into a bogus "no verifiable
   * citation" message. Adding a third kind without this flag would have
   * refused a repeated opening line by telling the clinic its citation was
   * missing.
   */
  blocking: boolean;
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

/**
 * Deliberately does NOT quote the name back.
 *
 * The obvious phrasing — 'your draft named "Rodrigo", do not name "Rodrigo"' —
 * puts the banned name straight back into the prompt, and a model told to
 * avoid a token is a well-known way to make it produce that token. It is also
 * the exact regression this pipeline already paid for once: the file name used
 * to be handed over, the model read "Reel_MolecularHydrogen_Rodrigo", and it
 * wrote "As our patient Rodrigo shares:" over a line of the transcript.
 * lib/video-copy.ts strips the owner suffix before the topic is built for that
 * reason, and a corrective that reintroduces it would undo the fix.
 *
 * The rule is categorical anyway. The writer does not need to know which name
 * it used; it needs to know it must not use any.
 */
function nameCorrective(count: number): string {
  return (
    'IMPORTANT: your previous draft named ' + (count === 1 ? 'a person' : 'people') + ' — ' +
    (count === 1 ? 'someone' : 'people') + ' who filmed or uploaded this video, not anybody speaking in it. ' +
    'Never name any individual: no patient, presenter, staff member or uploader. Never attribute a quote, a result ' +
    'or an experience to a named person. Write only as the clinic sharing its own video.'
  );
}

/**
 * Deliberately does NOT quote the offending sentence back.
 *
 * The same reasoning as nameCorrective above, for the same reason it was
 * learned: handing a model a sentence and telling it not to write that sentence
 * is a well-known way to get that sentence back, lightly reworded — which is
 * precisely the failure being corrected, since "the same sentence with the
 * nouns swapped" is what the clinic was already seeing.
 *
 * So this names the SHAPE that failed and demands a different anchor. The
 * writer does not need to know which opening it echoed; it needs to be told to
 * start from something in this video that no other video contains.
 */
const OPENING_CORRECTIVE =
  'IMPORTANT: your previous draft opened almost exactly like a post this clinic has already published. ' +
  'Do not adjust that sentence — throw it away and write a different one. Open instead on something ' +
  'CONCRETE that appears only in THIS video: a number the speaker says, a piece of equipment they name, ' +
  'a material, a setting, a step they physically perform. Do not open on a general statement about ' +
  'regenerative medicine, safety, wellness or the field — that is the shape that repeated.';

/**
 * Is this draft publishable, and if not, what should the writer be told?
 *
 * Both problems are reported together when both are present, so one more
 * attempt can fix both rather than trading one refusal for the other.
 *
 * @param ref the citation extracted from the composed copy; empty means none
 * @param leaked names the guard found in the copy
 * @param repeatsOpening lib/opening-line.ts found this opening in a recent post
 */
export function draftDefect(
  ref: string,
  leaked: readonly string[],
  repeatsOpening = false,
): DraftDefect | null {
  const correctives: string[] = [];
  if (leaked.length) correctives.push(nameCorrective(leaked.length));
  if (!String(ref || '').trim()) correctives.push(REF_CORRECTIVE);
  if (repeatsOpening) correctives.push(OPENING_CORRECTIVE);
  if (!correctives.length) return null;

  const blocking = Boolean(leaked.length) || !String(ref || '').trim();
  return {
    kind: leaked.length ? 'named_a_person' : (blocking ? 'no_citation' : 'repeats_opening'),
    corrective: correctives.join('\n\n'),
    blocking,
  };
}
