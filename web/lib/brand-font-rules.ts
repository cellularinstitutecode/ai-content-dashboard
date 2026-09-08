// web/lib/brand-font-rules.ts
// What counts as a usable brand typeface file — pure, so the rules are
// unit-tested and shared by the upload route and the compositor.
//
// Two rules matter beyond "is it a font": trial and demo builds are refused,
// because a foundry's evaluation licence does not cover a clinic's production
// social cards; and a file has to name a face the brand actually uses, so a
// stray upload cannot quietly become the headline type.

export type FontFamily = 'Canela' | 'Nexa' | 'Rische';
export type FontRole = 'headline' | 'body';
export type FontWeight = 300 | 400 | 500 | 600 | 700;
export type FontStyle = 'normal' | 'italic';

export type FontFile = { family: FontFamily; role: FontRole; weight: FontWeight; style: FontStyle };

export const MAX_FONT_BYTES = 2 * 1024 * 1024;
export const FONT_EXT = /\.(otf|ttf|woff)$/i;

/** Family, role, weight and style from a file name like "Rische-Semibold.otf". */
export function describeFontFile(name: string): FontFile | null {
  const lower = String(name || '').toLowerCase();
  if (!FONT_EXT.test(lower)) return null;
  const family: FontFamily | null = /canela/.test(lower) ? 'Canela' : /nexa/.test(lower) ? 'Nexa' : /rische/.test(lower) ? 'Rische' : null;
  if (!family) return null;
  // "semibold" contains "bold", so the finer grades are tested first.
  const weight: FontWeight =
    /semibold|demibold/.test(lower) ? 600
    : /black|xbold|extrabold|heavy|bold/.test(lower) ? 700
    : /medium/.test(lower) ? 500
    : /light|thin|book/.test(lower) ? 300
    : 400;
  const style: FontStyle = /italic|oblique/.test(lower) ? 'italic' : 'normal';
  return { family, role: family === 'Canela' ? 'headline' : 'body', weight, style };
}

/**
 * A variable font (one file, many weights). satori sets type from static
 * instances only, so a variable file is listed and counted but never handed to
 * the renderer — the static weights alongside it are what get used.
 */
export function isVariableFont(name: string): boolean {
  return /variable|\[wght\]|-vf\b/i.test(String(name || ''));
}

/** Trial, demo and evaluation builds carry it in the file name; they are not licensed for production. */
export function isTrialFont(name: string): boolean {
  return /trial|demo|eval|sample|test/i.test(String(name || '').replace(FONT_EXT, ''));
}

export type UploadVerdict = { ok: true; file: FontFile; safeName: string } | { ok: false; reason: string };

/** Decide whether an uploaded font may be stored, and under what name. */
export function validateFontUpload(name: string, bytes: number): UploadVerdict {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  if (!FONT_EXT.test(base)) return { ok: false, reason: base + ': only .otf, .ttf and .woff font files are accepted.' };
  if (bytes <= 0) return { ok: false, reason: base + ': the file is empty.' };
  if (bytes > MAX_FONT_BYTES) return { ok: false, reason: base + ': larger than 2 MB — that is not a text font.' };
  if (isTrialFont(base)) return { ok: false, reason: base + ': this is a trial/demo build. Evaluation licences do not cover production use; upload the purchased family.' };
  const file = describeFontFile(base);
  if (!file) return { ok: false, reason: base + ': not one of the brand typefaces (Canela, Nexa, Rische).' };
  const safeName = base.replace(/[^A-Za-z0-9._-]/g, '_');
  return { ok: true, file, safeName };
}

/**
 * Which faces a set of uploaded files covers, and which role still runs on a
 * stand-in. Nexa outranks Rische for the body when both are present, as the
 * guide's own type page orders them.
 */
export function coverage(names: string[]): { headline: FontFamily | null; body: FontFamily | null; standInFaces: FontRole[] } {
  let headline: FontFamily | null = null;
  let body: FontFamily | null = null;
  for (const n of names) {
    const f = describeFontFile(n);
    if (!f || isTrialFont(n)) continue;
    if (f.role === 'headline') headline = 'Canela';
    else if (f.family === 'Nexa') body = 'Nexa';
    else if (!body) body = 'Rische';
  }
  const standInFaces: FontRole[] = [];
  if (!headline) standInFaces.push('headline');
  if (!body) standInFaces.push('body');
  return { headline, body, standInFaces };
}
