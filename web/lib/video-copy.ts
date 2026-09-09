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
