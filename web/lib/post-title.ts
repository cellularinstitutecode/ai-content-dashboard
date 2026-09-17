// web/lib/post-title.ts
// The title a patient sees, built from the research rather than the file.
//
// THE PROBLEM, AS IT REACHED THE SCREEN. The composer sent the media label as
// the post's title, so YouTube and TikTok were handed
// "Video_RyallxCellgenicxCellularInstitute_Rodrigo.mp4" — two staff names, a
// partner's name, a container word and a file extension. lib/video-title.ts
// cleans a filename well when the filename contains the subject
// ("Reel_RedLightRyall_Rodrigo" -> "Red Light at Cellular Institute"), but it
// can only work with what is in the name, and most of these names are about
// who shot the video rather than what is in it. The example above cleans to
// "Ryallx Cellgenicx Cellular Institute at Cellular Institute", which is worse
// than useless.
//
// THE THING THAT WAS ALREADY THERE. Every prepared row runs a keyword search
// (lib/ai.ts autoKeywordBrief, reseeded from the transcript when the filename
// turns out to be meaningless — lib/reseed.ts). That search already knows what
// this video is about, in the words people actually type: "red light therapy",
// "hbot cancun", "exosome therapy". It shaped the copy and was then thrown away
// as far as the title was concerned.
//
// So the title comes from the research: the primary keyword, title-cased, with
// the clinic's name on the end. "Red Light Therapy at Cellular Institute" —
// which is exactly what was asked for, and is also the phrase the clinic wants
// to be found under.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { CLINIC_SUFFIX, cleanVideoTitle, looksLikeFilename, strippedWords, titleCasePhrase } from './video-title.ts';

/** Where the title that shipped actually came from. */
export type TitleSource = 'written' | 'keyword' | 'spoken' | 'filename' | 'clinic';

export type TitleChoice = { title: string; source: TitleSource };

/** Longer than this is not a title, whatever it is. */
export const MAX_TITLE_CHARS = 90;

/**
 * Is this string internal — a filename, or something carrying a name that must
 * never be published?
 *
 * Substring, not whole word, and that is the fix for a real case: the strip
 * list holds "Ryall", and the file was named "...RyallxCellgenic...", where the
 * name is glued to the next word. Whole-word matching left it in.
 */
export function looksInternal(value: string | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  const v = String(value || '').trim();
  if (!v) return true;
  if (looksLikeFilename(v)) return true;
  const lower = v.toLowerCase();
  // Short entries in the list are not safe to match as substrings — "iv" would
  // match "arrival" — so they keep whole-word matching.
  return strippedWords(env).some((w) => (w.length >= 4 ? lower.includes(w) : new RegExp('\\b' + w + '\\b').test(lower)));
}

/**
 * The subject with the clinic on the end — and only one of it.
 *
 * "Cellular Institute at Cellular Institute" is what happens when a filename
 * already carries the clinic's name and the suffix is appended anyway. It
 * reached production.
 */
export function withClinic(subject: string, suffix: string | null = CLINIC_SUFFIX): string {
  const s = String(subject || '').trim().replace(/\s+/g, ' ');
  const tail = String(suffix || '').trim();
  if (!s) return tail;
  if (!tail) return s;
  if (s.toLowerCase().includes(tail.toLowerCase())) return s;
  return s + ' at ' + tail;
}

/** A keyword or spoken phrase worth putting in a title. */
function usable(value: string | null | undefined): string {
  const v = String(value || '').trim().replace(/\s+/g, ' ');
  if (!v || v.length > MAX_TITLE_CHARS) return '';
  // Must actually say something: letters, and not just the clinic's own name.
  if (!/[A-Za-zÀ-ÿ]{3}/.test(v)) return '';
  return v;
}

/**
 * The public title for a post.
 *
 * In order: what a person wrote, then what the keyword search found, then what
 * the speaker kept saying, then whatever can be salvaged from the filename,
 * then the clinic's name alone — which is plain, but is never wrong, and is
 * incomparably better than publishing an editor's name.
 */
export function professionalTitle(args: {
  /** A title somebody typed — in the sheet, or in the composer. */
  supplied?: string | null;
  /** The primary keyword the research settled on. */
  keyword?: string | null;
  /** What the transcript says the video is about. */
  spoken?: string | null;
  /** The file, as a last resort. */
  filename?: string | null;
  suffix?: string | null;
  env?: Record<string, string | undefined>;
}): TitleChoice {
  const env = args.env || process.env;
  const suffix = args.suffix === undefined ? CLINIC_SUFFIX : args.suffix;

  // A written title is kept in the writer's own words — not title-cased, not
  // rearranged. Somebody typing "Nuestro protocolo de oxígeno" meant that.
  const supplied = usable(args.supplied);
  if (supplied && !looksInternal(supplied, env)) {
    return { title: withClinic(supplied, suffix), source: 'written' };
  }

  const keyword = usable(args.keyword);
  if (keyword && !looksInternal(keyword, env)) {
    return { title: withClinic(titleCasePhrase(keyword), suffix), source: 'keyword' };
  }

  const spoken = usable(args.spoken);
  if (spoken && !looksInternal(spoken, env)) {
    return { title: withClinic(titleCasePhrase(spoken), suffix), source: 'spoken' };
  }

  const fromFile = cleanVideoTitle(args.filename, { suffix, env });
  // cleanVideoTitle returns the suffix alone when nothing survived, which is
  // the same answer as the fallback below — said as 'clinic', because "we could
  // not tell what this is about" and "the filename said so" are different
  // facts and only one of them is worth acting on.
  if (fromFile && fromFile !== suffix && !looksInternal(fromFile, env)) {
    return { title: fromFile, source: 'filename' };
  }
  return { title: String(suffix || '').trim(), source: 'clinic' };
}
