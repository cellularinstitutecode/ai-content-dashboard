// web/lib/video-copy.ts
// Two pure decisions about a video's copy: what the keyword brief should
// actually research, and how the finished caption ends.
//
// Both existed as bugs before they existed as functions, and both were
// invisible from inside the code — they only showed up in the output.
import { avisoLine } from './compliance.ts';

// ---------------------------------------------------------------------------
// What to research
// ---------------------------------------------------------------------------

/**
 * The words the keyword brief should be run on.
 *
 * generateContentPack researches `input.topic`, and the topic this pipeline
 * builds is a full instruction plus the entire transcript — twelve thousand
 * characters. Semrush takes that string as a literal search PHRASE, so it
 * matched nothing and every video came back "no keyword data" while the
 * account sat on 48,000 unspent units. The keyword research this whole
 * automation exists for had never once run.
 *
 * What it wants is two or three words naming the subject. The clinic's file
 * names carry exactly that, under a layer of convention:
 *
 *   Reel_MolecularHydrogenRyall_Rodrigo.mp4  →  Molecular Hydrogen
 *   Reel_HyperbaricChamberRyall_Rodrigo.mp4  →  Hyperbaric Chamber
 *   Reel_RedBlue&IfraRedLightxRyall_Rodrigo  →  Red Blue Ifra Red Light
 *
 * When the name yields nothing usable — an untitled row, a bare id — the
 * transcript's opening words are a poorer but real seed.
 */
const FILENAME_PREFIX = /^(reel|video|web|tstm|ci|clip)[\s_-]+/i;
/** The person the file is named after, and the presenter tag the clinic appends. */
const TRAILING_OWNER = /[_\s-][A-Z][a-z]+$/;
const PRESENTER = /x?ryall/gi;

/**
 * What the video is ABOUT, taken from what was said in it.
 *
 * The filenames carry production identity, not subject matter:
 * "Reel_RyallCellgenicScript16_Rodrigo" reduces to "Cellgenic Script16" —
 * a partner's name and a script number. Semrush is given that as a literal
 * search phrase and returns nothing, and the copy is written blind. The badge
 * on the Prepare screen said "NO keyword data" and it was right.
 *
 * The transcript does not have that problem: a video about culture conditions
 * and manufacturing says "regenerative medicine" and "stem cell" out loud,
 * repeatedly. The most frequent meaningful two-word phrase is a far better
 * search seed than anything the filename holds.
 *
 * Bigram first because the clinic's real subjects are two words ("stem cell",
 * "regenerative medicine", "hydrogen water"); a single word only when nothing
 * is said twice.
 */
const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','of','to','in','on','at','for','with','from','by','as','is','are','was','were','be','been','being',
  'this','that','these','those','it','its','you','your','we','our','us','they','their','them','i','me','my','he','she','his','her',
  'not','no','do','does','did','have','has','had','can','could','will','would','should','may','might','must','just','about','what',
  'when','where','which','who','how','why','all','any','more','most','some','such','than','then','there','here','so','very','really',
  'know','get','got','make','made','made','one','two','also','because','into','out','up','down','over','under','only','other','after',
  'before','between','through','during','while',
]);

/**
 * The clinic's own house style, measured rather than imagined.
 *
 * Taken from the 112 posts the clinic's writer produced in the sheet: a median body of
 * about 830 characters, 10–11 lowercase hashtags (exactly ONE of 1,082 was CamelCase),
 * #cellularinstitute on 92 of them, and a question opener on only 19.
 *
 * The reason this exists is the thinness. The shared social instruction says "max ~150
 * words", which at ~900 characters has to hold the REF, the AVISO and eleven hashtags
 * too — leaving no room to say anything specific. So the generated copy reached for
 * "designed to help regulate your central nervous system" where the clinic's writer had
 * written "GMP-quality reagents, monitored biosafety cabinets, careful cell selection".
 * Same length, a fraction of the substance.
 *
 * The substance rule is the one that matters. Length alone just produces more filler.
 */
export const HOUSE_TAGS = [
  'cellularinstitute', 'healthoptimization', 'cellularhealth', 'regenerativemedicine',
  'advancedwellness', 'personalizedmedicine', 'stemcelltherapy', 'regenerativewellness',
  'advancedmedicine', 'longevitymedicine', 'wellnessjourney', 'wellnessclinic',
] as const;

/**
 * Openings that are structurally DIFFERENT from one another.
 *
 * There used to be exactly one example here, and one example in a prompt is not
 * an illustration — it is a template. Every caption came back as a variation on
 * "Safety in regenerative medicine starts long before a therapy reaches the
 * patient": abstract noun, "in regenerative medicine", temporal claim. The
 * clinic's complaint was that the posts "started very similarly" and read like
 * duplicates of each other when the videos were nothing alike.
 *
 * Four shapes rather than one, each anchored on a different KIND of concrete
 * thing — a measurement, an action, a correction, a decision — so that there is
 * no single sentence to fill in and the transcript decides which fits.
 */
const OPENING_SHAPES = [
  'a measurement or setting the speaker names — "The chamber holds 1.3 atmospheres for sixty minutes."',
  'something being physically done — "Ozone runs through the dialyser before the blood goes back in."',
  'a correction of what people assume — "Most people think the cold is the point. It is the recovery afterwards."',
  'a decision the clinic makes and why — "We screen every donor line twice before a single cell is expanded."',
];

export function houseStyleHint(recentOpenings: readonly string[] = []): string {
  const lines = [
    'HOUSE STYLE (this clinic writes to a settled pattern — follow it over any general length guidance above):',
    '- Length: 800-1,100 characters of BODY for both instagram and linkedin, before the REF line, the AVISO line and the hashtags. This overrides the word counts given earlier.',
    '- OPENING LINE, and this is the rule that matters most for variety: open on something CONCRETE and specific to THIS video — a measurement, a material, a piece of equipment, a step, something the speaker physically does. Never open on a general statement about the field, and never on a keyword or a search phrase. If a keyword brief above disagrees with the transcript about what this video is about, the transcript is right. Do not open with a question.',
    '- Vary the SHAPE of that opening between posts. Any of these is good, and they are examples to choose between, not a template to fill in:\n  * ' + OPENING_SHAPES.join('\n  * '),
    '- Vary how the middle is built too. Usually 3-4 short paragraphs, one idea each, separated by a blank line — but not every post is four even paragraphs: some are best as a short sequence of steps in the order the speaker does them, some as one idea developed across two longer paragraphs, some as a claim followed by the evidence for it. Let the video decide, and do not build two posts the same way in a row.',
    '- SUBSTANCE, the most important rule: name at least three concrete things the speaker actually said — a step in the protocol, a material, a piece of equipment, a named therapy, a measurement, a condition being controlled for. Specifics are what make the post worth reading.',
    '- Never pad with wellness filler. Phrases like "designed to help", "supports your wellness", "reconnect with yourself", "holistic approach" say nothing; if the transcript does not say it, do not write it.',
    '- Close with a short values line, then a soft invitation — the clinic uses "See if you are a candidate."',
    '- Hashtags: 10-11, all lowercase, no CamelCase and no spaces. Draw most from: #' + HOUSE_TAGS.join(' #') + '. Add at most two specific to this video. Always include #cellularinstitute.',
  ];

  // What the clinic has already published, so this post can avoid repeating it.
  //
  // Shown rather than summarised, and paired with the positive rule above: a
  // model handed a list to avoid, and nothing to reach for instead, writes the
  // list. The real guarantee is not this paragraph — it is lib/opening-line.ts
  // measuring the result and lib/draft-defect.ts sending it back. This only
  // makes the first attempt likely to be right.
  const used = recentOpenings.map((o) => String(o || '').trim()).filter(Boolean).slice(0, 10);
  if (used.length) {
    lines.push(
      '- ALREADY USED. These are the opening lines of the clinic\u2019s most recent posts. Yours must not repeat any of them, ' +
      'must not reuse their opening words, and must not be the same sentence with the nouns swapped:\n  * ' +
      used.map((o) => '"' + o + '"').join('\n  * '),
    );
  }

  return lines.join('\n');
}

/**
 * Any forbidden name that survived into the copy.
 *
 * The last line of defence, and the only one that does not depend on the model doing as
 * it is told. A post went out reading "As our patient Rodrigo shares:" over a quote from
 * a video; Rodrigo uploads the videos. The prompt now says not to, and the file name is
 * no longer handed over — but a clinic publishing a testimonial from a patient who does
 * not exist is not a thing to leave resting on a prompt.
 *
 * Word boundaries, case-insensitive: "Rodrigo's" and "RODRIGO" are the same leak, while
 * a name that happens to sit inside a longer word is not one.
 */
export function namesLeaked(copy: string, forbidden: readonly string[]): string[] {
  const text = String(copy || '');
  if (!text) return [];
  const hits: string[] = [];
  for (const raw of forbidden || []) {
    const name = String(raw || '').trim();
    // Two characters is not a name, and a one-letter "name" would match everything.
    if (name.length < 3) continue;
    const re = new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
    if (re.test(text)) hits.push(name);
  }
  return Array.from(new Set(hits));
}

/**
 * The names this video must never mention: the owner suffix on the file, the presenter
 * tag, and whoever the sheet records as the creator.
 *
 * Drawn from the same conventions videoSubject already strips, so the two cannot drift
 * apart: whatever is cleaned out of the subject is exactly what must not reappear.
 */
export function forbiddenNames(title: string, creator?: string | null): string[] {
  const out: string[] = [];
  const base = String(title || '').replace(/\.(mp4|mov|m4v|webm|mpeg)$/i, '');
  // Only a FILE name carries an owner suffix. The sheet's titles are a mix — some are
  // "Reel_FloatingBedRyall_Rodrigo", some are "Safety Matters" — and reading the last
  // word of the second kind as a person would ban "Matters" from the copy and fail a
  // perfectly good row. The underscore is what distinguishes the convention from a
  // sentence somebody typed.
  const owner = base.includes('_') ? TRAILING_OWNER.exec(base) : null;
  if (owner) out.push(owner[0].replace(/^[_\s-]+/, ''));
  if (/x?ryall/i.test(String(title || ''))) out.push('Ryall');
  const by = String(creator || '').trim();
  if (by) out.push(by);
  return Array.from(new Set(out.filter((n) => n.length >= 3)));
}

/**
 * How much of a keyword set the video actually talks about, 0 to 1.
 *
 * A search seed can succeed and still be wrong. "Reel_FloatingBedRyall" gives
 * Semrush "floating bed", which is a real phrase with real volume — for
 * FURNITURE. It came back with "floating bed frame" (12,100/mo), "floating bed
 * frame queen", "diy floating bed frame", and the copy was written to them:
 * the headline on a nervous-system reset became "Why a Floating Bed Frame Is
 * Part of Our Regenerative Care Protocol". Nothing failed. The badge was
 * green. The post was aimed at people shopping for a bedstead.
 *
 * Seeding from what the speaker says instead returns "vagus nerve reset"
 * (22,200/mo) and "how to regulate nervous system" — more volume AND the
 * people the clinic is actually talking to.
 *
 * The tell is vocabulary the video never uses. "frame", "queen", "diy",
 * "bedroom", "mattress" appear nowhere in a three-minute piece about
 * parasympathetic activation, and that is measurable without knowing anything
 * about beds or medicine — which matters, because the next mismatch will not
 * be about beds.
 *
 * Words, not whole phrases: one shared word ("floating bed") would otherwise
 * carry a set that is six-sevenths about carpentry.
 */
export function keywordGrounding(keywords: readonly string[], transcript: string): number {
  const said = new Set(
    String(transcript || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(singular),
  );
  if (!said.size) return 0;

  const terms = new Set<string>();
  for (const k of keywords || []) {
    for (const w of String(k || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)) {
      if (w.length > 2 && !STOPWORDS.has(w)) terms.add(singular(w));
    }
  }
  if (!terms.size) return 0;

  let hit = 0;
  for (const t of terms) if (said.has(t)) hit++;
  return hit / terms.size;
}

/** Crude plural folding, so "beds" and "bed" are the same word. */
function singular(w: string): string {
  return w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
}

/**
 * The transcript, cut to fit, at a sentence boundary and saying so.
 *
 * It used to be a bare slice(0, 12000): mid-word, no marker, and no way for the writer to
 * tell a whole transcript from half of one — so a long video could be summarised
 * confidently from a sentence that stopped in the middle.
 */
export function transcriptExcerpt(text: string, maxChars: number): string {
  const t = String(text || '').trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  // Back up to the last sentence that finished. Only if one did reasonably near the end —
  // a transcript with no punctuation at all should still be cut rather than discarded.
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  const body = lastStop > maxChars * 0.6 ? cut.slice(0, lastStop + 1) : cut;
  return body.trim() + '\n\n[Transcript truncated here — the video continues.]';
}

export function topicFromTranscript(text: string): string {
  const words = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  if (!words.length) return '';

  const bigrams = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const key = words[i] + ' ' + words[i + 1];
    bigrams.set(key, (bigrams.get(key) || 0) + 1);
  }
  let best = '';
  let bestCount = 1; // said once is not a theme
  for (const [phrase, count] of bigrams) {
    if (count > bestCount) { best = phrase; bestCount = count; }
  }
  if (best) return best;

  // A single word gets the same bar as a pair: said once is not a theme, it
  // is whatever happened to open the video. Nothing repeated means there is no
  // signal here, and '' says so — the caller keeps the filename's subject
  // rather than searching for a word picked at random.
  const singles = new Map<string, number>();
  for (const w of words) singles.set(w, (singles.get(w) || 0) + 1);
  let word = '';
  let wordCount = 1;
  for (const [w, count] of singles) {
    if (count > wordCount) { word = w; wordCount = count; }
  }
  return word;
}

export function videoSubject(title: string, transcript = ''): string {
  let s = String(title || '').trim();
  s = s.replace(/\.(mp4|mov|m4v|webm|mpeg)$/i, '');
  s = s.replace(FILENAME_PREFIX, '');
  s = s.replace(PRESENTER, ' ');
  // "_Rodrigo", "_Kevin" — whose video it is, not what it is about.
  s = s.replace(TRAILING_OWNER, '');
  // Numbering and separators: "#4TPE" is the fourth take, not a keyword.
  s = s.replace(/#\d+/g, ' ').replace(/[_&]+/g, ' ');
  // PascalCase and camelCase are how the names carry their words.
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  s = s.replace(/\s+/g, ' ').trim();

  // One word is often the RIGHT answer here: EBOO, PEMF, TPE are the searchable
  // terms, not fragments of a longer one. Requiring two pushed exactly those
  // into the transcript fallback and diluted them with its opening sentence.
  if (s.length >= 3) return s;

  // Nothing usable in the name. The first words actually spoken are a seed —
  // weaker, but incomparably better than the whole prompt.
  const opening = String(transcript || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/[.!?]/)[0] || '';
  const words = opening.split(' ').filter(Boolean).slice(0, 8).join(' ');
  return (s + ' ' + words).trim() || s;
}

// ---------------------------------------------------------------------------
// How the caption ends
// ---------------------------------------------------------------------------

/**
 * Every shape the advertising notice turns up in.
 *
 * lib/compliance.ts's own matcher requires "AVISO DE PUBLICIDAD:" with a
 * colon. The writer produced "AVISO DE PUBLICIDAD COFEPRIS 2425N2SSA01827" —
 * no colon, an extra word, and a permit number it had invented — so the
 * matcher did not see it, appended the real one underneath, and the post went
 * out carrying TWO permit numbers, one of them fictional. On a medical
 * advertisement.
 */
const ANY_AVISO = /^[ \t]*AVISO\s+DE\s+PUBLICIDAD\b.*$/gim;
const REF_LINE = /^[ \t]*REF(?:ERENCIA)?[ \t]*[.:：][ \t]*\S.*$/gim;
/** A line that is only hashtags — the block the clinic ends every caption with. */
const HASHTAG_LINE = /^[ \t]*(?:#[^\s#]+[ \t]*)+$/gim;

/**
 * Assemble the caption the way the clinic writes them:
 *
 *   body
 *   REF: …
 *   AVISO DE PUBLICIDAD: <the one real number>
 *   #hashtags
 *
 * Every part is lifted out and put back deliberately rather than trusted where
 * the model left it. That is the only way to guarantee ONE notice, carrying
 * the clinic's own permit number, with the hashtags last as the house style
 * has always had them.
 */
export function composeCaption(text: string, avisoNumber?: string | null): string {
  const raw = String(text || '').replace(/\r\n/g, '\n');

  const refs = raw.match(REF_LINE) || [];
  const tags = raw.match(HASHTAG_LINE) || [];

  const body = raw
    .replace(ANY_AVISO, '')
    .replace(REF_LINE, '')
    .replace(HASHTAG_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const parts = [body];
  // The first citation only: a second one is the model repeating itself.
  const firstRef = refs[0];
  if (firstRef) parts.push(firstRef.trim());
  parts.push(avisoLine(avisoNumber));
  if (tags.length) parts.push(tags.map((t) => t.trim()).join(' ').replace(/\s+/g, ' ').trim());

  return parts.filter(Boolean).join('\n\n');
}
