// web/lib/topic-seed.ts
// Which phrase from the transcript gets searched, when the file name's subject
// returns nothing.
//
// The rule used to be "the most frequent two-word phrase", full stop, with no
// reference to what the video is called. That works until the speaker dwells on
// a DETAIL, and then the detail replaces the subject:
//
//   Reel_RyallOxygenCircuit_Rodrigo — a video about the Oxygen Circuit, in
//   which patients start with hyperbaric oxygen and move into a red light bed.
//   The speaker spends most of the clip on the bed and its wavelengths, so
//   "red light" outscores "hyperbaric oxygen" on raw count. Semrush was asked
//   about red light, answered with "red light therapy near me", "red light
//   therapy at home", "red light therapy devices" — and a post about a clinic's
//   oxygen protocol was researched, and then written, as a post about consumer
//   red-light gear.
//
// The file name is not a guess. Somebody typed "OxygenCircuit" when they named
// the clip, videoSubject() reads it correctly, and the generated copy's own body
// agreed ("Our Oxygen Circuit is a prime example"). The subject was known the
// whole time and the seed simply ignored it.
//
// So: prefer a phrase the speaker repeats AND that the subject corroborates.
// Only when nothing corroborates it does the raw count decide, which is the old
// behaviour and the right fallback for a file name that says nothing useful.
//
// Costs nothing. This changes WHICH phrase is looked up, not how many lookups
// happen — still one retry, still inside the unit-floor guard in lib/semrush.ts.
//
// No imports: the tokenising lives in lib/video-copy.ts, which owns the stopword
// list, and this file is handed the words. That keeps it runnable by
// `node --experimental-strip-types --test` and keeps the two files acyclic.

/**
 * Said once is not a theme — the bar the previous rule already set, and kept
 * for corroborated phrases too.
 *
 * Lowering it for subject-anchored candidates was tempting (the file name is a
 * second witness, so one mention ought to be enough) and wrong in practice: at
 * a bar of one, EVERY adjacent pair touching a subject word qualifies, and
 * "there oxygen" wins on a transcript where "oxygen" is merely present. One
 * mention is not a phrase.
 */
const MIN_REPEATS = 2;

function countBigrams(words: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const key = words[i] + ' ' + words[i + 1];
    out.set(key, (out.get(key) || 0) + 1);
  }
  return out;
}

function countSingles(words: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of words) out.set(w, (out.get(w) || 0) + 1);
  return out;
}

/**
 * The best entry in `counts`, preferring ones the subject corroborates.
 *
 * Two passes rather than a weighted score: a subject-corroborated phrase said
 * twice must beat an unrelated phrase said nine times, and any single formula
 * mixing the two lets sheer repetition win eventually. That is the failure being
 * fixed, so it is ruled out by construction instead of tuned against.
 */
function best(counts: Map<string, number>, subject: ReadonlySet<string>): string {
  let anchored = '';
  let anchoredCount = MIN_REPEATS - 1;
  let overall = '';
  let overallCount = MIN_REPEATS - 1;

  for (const [phrase, count] of counts) {
    if (count > overallCount) { overall = phrase; overallCount = count; }
    if (!subject.size) continue;
    const parts = phrase.split(' ');
    // Restating the subject IN FULL is not a re-seed. This function is only
    // ever reached BECAUSE the subject returned nothing from Semrush — the
    // clinic calls the protocol its "Oxygen Circuit" and nobody searches for
    // that — so "oxygen circuit" is the one anchored phrase guaranteed to be
    // useless, and picking it would spend a second lookup to fail identically.
    //
    // Full restatement, not any subset: "oxygen" on its own is a BROADER query
    // than "oxygen circuit", not the same one, and broadening is exactly what a
    // failed subject needs. Excluding every subset would throw that away too.
    if (parts.length === subject.size && parts.every((w) => subject.has(w))) continue;
    if (parts.some((w) => subject.has(w)) && count > anchoredCount) { anchored = phrase; anchoredCount = count; }
  }
  return anchored || overall;
}

/**
 * The phrase to research, given the transcript's significant words and the
 * subject's.
 *
 * Both lists must already be lowercased and stripped of stopwords by the
 * caller — lib/video-copy.ts owns that list and uses it for two other things.
 *
 * Bigrams before single words, for the same reason as before: a pair carries
 * enough to search on, where one word picked out of a clip is whatever the
 * speaker happened to lean on.
 */
export function pickSeed(words: readonly string[], subjectWords: readonly string[] = []): string {
  if (!words.length) return '';
  // A subject word that IS the whole transcript's vocabulary corroborates
  // nothing, but that costs only a redundant preference, never a wrong one.
  const subject = new Set(subjectWords);
  return best(countBigrams(words), subject) || best(countSingles(words), subject);
}
