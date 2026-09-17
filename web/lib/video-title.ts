// web/lib/video-title.ts
// The public title of a video, which is NOT its filename.
//
// The clinic's reels are named for whoever shot and edited them:
//
//   Reel_RyallHBOT_Rodrigo        Reel_Shoulder2Ryall_Rodrigo.mp4
//   Reel_RedLightRyall_Rodrigo    Video_FinalCompCorporativo_Rodrigo
//
// Those went straight onto YouTube and TikTok as the post's title, so the
// clinic's channels carried two staff members' names, an internal "Reel_"
// prefix and a file extension. A patient reading "Reel_RedLightRyall_Rodrigo"
// learns nothing and sees something unfinished.
//
// This turns the filename into something a clinic would publish:
//
//   Reel_RedLightRyall_Rodrigo  ->  Red Light at Cellular Institute
//   Reel_RyallHBOT_Rodrigo      ->  HBOT at Cellular Institute
//   Reel_Shoulder2Ryall_Rodrigo ->  Shoulder at Cellular Institute
//
// Names to drop are a SETTING, not a hardcoded list, because the next editor
// will have a different one and nobody should need a deploy to fix a title.
//
// Pure: no imports, so the test runner reads this file directly.

/** Words that are structure, not subject. */
const PREFIXES = ['reel', 'video', 'web', 'clip', 'short', 'final', 'finalcomp', 'comp'];

/** Acronyms that must stay upper-case rather than become "Hbot". */
const ACRONYMS = new Set(['HBOT', 'PRP', 'IV', 'NAD', 'TMJ', 'ACL', 'MSC', 'EMS', 'LED', 'CBD', 'DNA', 'FAQ']);

/** The clinic, as it should read at the end of a title. */
export const CLINIC_SUFFIX = 'Cellular Institute';

/**
 * People and internal words to strip, from VIDEO_TITLE_STRIP (comma-separated).
 *
 * Defaults to the two names on every current file. Matched whole-word and
 * case-insensitively after the name is split into words, so "Ryall" goes
 * whether it is "RyallHBOT", "_Ryall_" or "Shoulder2Ryall".
 */
export function strippedWords(env: Record<string, string | undefined> = process.env): string[] {
  const raw = String(env.VIDEO_TITLE_STRIP ?? 'Rodrigo,Ryall').trim();
  return raw.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
}

/** Split a filename stem into words: underscores, hyphens, digits and camelCase. */
function words(stem: string): string[] {
  return stem
    .replace(/[._\-]+/g, ' ')
    // camelCase and PascalCase, and the boundary where an acronym meets a word
    // ("RedLightRyall" -> "Red Light Ryall", "HBOTSession" -> "HBOT Session").
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    // Letters from digits, or "Shoulder2Ryall" keeps the 2 ("Shoulder2") and
    // "CellgenicScript16" keeps the 16 — take numbers off and they are dropped
    // as the noise they are.
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean);
}

/** Title Case one word, keeping known acronyms shouting. */
function cased(word: string): string {
  const up = word.toUpperCase();
  if (ACRONYMS.has(up)) return up;
  if (word.length <= 2 && /^[A-Za-z]+$/.test(word) && word === up) return up;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * A clean, public title for a video.
 *
 * `fallback` is used when nothing survives the cleaning — a file called
 * `Reel_Rodrigo.mp4` has no subject in it at all, and a post titled
 * "Cellular Institute" alone is better than one titled "Reel Rodrigo".
 */
export function cleanVideoTitle(
  filename: string | null | undefined,
  opts: { fallback?: string | null; suffix?: string | null; env?: Record<string, string | undefined> } = {},
): string {
  const suffix = opts.suffix === undefined ? CLINIC_SUFFIX : (opts.suffix || '');
  const drop = new Set(strippedWords(opts.env));
  const stem = String(filename || '').trim().replace(/\.[A-Za-z0-9]{2,4}$/, '');

  const kept: string[] = [];
  for (const raw of words(stem)) {
    const lower = raw.toLowerCase();
    if (drop.has(lower)) continue;
    // A leading structural word only: "Final Comp Corporativo" keeps
    // "Corporativo", and a video genuinely about a "reel" is not a thing here.
    if (!kept.length && PREFIXES.includes(lower)) continue;
    // A bare number left over from a filename ("Shoulder2") is noise.
    if (/^\d+$/.test(raw)) continue;
    kept.push(cased(raw));
  }

  const subject = kept.join(' ').trim();
  const fallback = String(opts.fallback || '').trim();
  if (!subject) return suffix || fallback || '';
  if (!suffix) return subject;
  return subject + ' at ' + suffix;
}

/** Is this string a raw internal filename rather than a written title? */
export function looksLikeFilename(value: string | null | undefined): boolean {
  const v = String(value || '').trim();
  if (!v) return false;
  return /\.(mp4|mov|m4v|webm|jpg|jpeg|png)$/i.test(v) || /^(reel|video|web|clip|short)[._-]/i.test(v) || /_/.test(v);
}
