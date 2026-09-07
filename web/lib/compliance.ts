// web/lib/compliance.ts
// The advertising rule for the clinic's Instagram and Facebook posts, as pure
// functions so it can be unit-tested and applied identically everywhere:
//
//   Every Instagram / Facebook post must carry
//     1. an AVISO DE PUBLICIDAD line with the clinic's COFEPRIS advertising
//        permit number (e.g. "AVISO DE PUBLICIDAD: 2623022002A00090"), and
//     2. a "REF:" line citing a scientific study that supports what the post
//        says.
//
// Where it applies: the generator asks the model for the REF line and this
// module appends the AVISO line deterministically (a permit number is not
// something to leave to a language model); the composer shows the state and
// offers a one-click fix for the AVISO; and the two doors to Metricool —
// "Send for review" and "Approve" — refuse an Instagram/Facebook post that is
// missing either line. Nothing about the rule lives in the UI alone.

export const DEFAULT_AVISO_NUMBER = '2623022002A00090';

/** Networks the rule applies to. Metricool's ids and the app's ids both appear. */
const SOCIAL_NETWORKS = new Set(['instagram', 'facebook', 'ig', 'fb']);

export function appliesTo(providers: readonly string[] | string | null | undefined): boolean {
  const list = Array.isArray(providers) ? providers : providers ? [providers] : [];
  return list.some((p) => SOCIAL_NETWORKS.has(String(p || '').trim().toLowerCase()));
}

/**
 * The permit number to use: Brand Brain first, then the AVISO_PUBLICIDAD
 * environment variable, then the clinic's default.
 */
export function avisoNumberFor(brandValue?: string | null): string {
  const b = (brandValue || '').trim();
  if (b) return b.toUpperCase();
  const e = (typeof process !== 'undefined' ? process.env?.AVISO_PUBLICIDAD : '') || '';
  return (e.trim() || DEFAULT_AVISO_NUMBER).toUpperCase();
}

/** The exact AVISO line for a permit number. */
export function avisoLine(avisoNumber: string | null | undefined): string {
  const n = (avisoNumber || '').trim() || DEFAULT_AVISO_NUMBER;
  return 'AVISO DE PUBLICIDAD: ' + n;
}

const AVISO_RE = /AVISO\s+DE\s+PUBLICIDAD\s*[:：]\s*([A-Z0-9]{8,})/i;
// "REF:" (or "REF." / "Ref:") followed by something that looks like a citation:
// at least a handful of characters, not just the label.
const REF_RE = /(^|\n)[ \t]*REF(?:ERENCIA)?[ \t]*[.:：][ \t]*(\S[^\n]{15,})/i;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>)\]]+)/i;

export type ComplianceCheck = {
  ok: boolean;
  /** Which required lines are missing. */
  missing: ('aviso' | 'ref')[];
  /** The permit number found in the text, when an AVISO line is present. */
  avisoFound: string | null;
  /** True when the AVISO line is present but carries a different number. */
  avisoMismatch: boolean;
  /** The REF line's text (without the label), when present. */
  ref: string | null;
  /** The DOI inside the REF line, when it has one. */
  doi: string | null;
};

/**
 * Does this caption satisfy the rule? `expectedAviso` is the permit number the
 * post should carry; a present-but-different number is reported as a mismatch
 * (and counts as missing, because the wrong permit is not compliance).
 */
export function checkCompliance(text: string, expectedAviso?: string | null): ComplianceCheck {
  const t = String(text || '');
  const missing: ('aviso' | 'ref')[] = [];
  const av = AVISO_RE.exec(t);
  const avisoFound = av ? av[1].toUpperCase() : null;
  const expected = (expectedAviso || '').trim().toUpperCase() || DEFAULT_AVISO_NUMBER;
  const avisoMismatch = Boolean(avisoFound && avisoFound !== expected);
  if (!avisoFound || avisoMismatch) missing.push('aviso');
  const rf = REF_RE.exec(t);
  const ref = rf ? rf[2].trim() : null;
  if (!ref) missing.push('ref');
  const doi = ref ? (DOI_RE.exec(ref)?.[1] ?? null) : null;
  return { ok: missing.length === 0, missing, avisoFound, avisoMismatch, ref, doi: doi ? doi.replace(/[.,;]+$/, '') : null };
}

/**
 * Add (or correct) the AVISO line. Idempotent: a correct line is left alone; a
 * wrong number is replaced; otherwise the line is appended after a blank line.
 * The REF line is never invented here — a citation has to come from a source.
 */
export function ensureAviso(text: string, avisoNumber?: string | null): string {
  const t = String(text || '').replace(/\s+$/, '');
  const line = avisoLine(avisoNumber);
  const m = AVISO_RE.exec(t);
  if (m) {
    if (m[1].toUpperCase() === line.slice('AVISO DE PUBLICIDAD: '.length)) return t;
    return t.replace(AVISO_RE, line);
  }
  return t ? t + '\n\n' + line : line;
}

/** Sentence for a person, when a post is refused. */
export function complianceMessage(check: ComplianceCheck): string {
  if (check.ok) return '';
  const parts: string[] = [];
  if (check.missing.includes('aviso')) {
    parts.push(check.avisoMismatch
      ? 'the AVISO DE PUBLICIDAD line carries a different permit number'
      : 'the AVISO DE PUBLICIDAD line is missing');
  }
  if (check.missing.includes('ref')) parts.push('the REF line citing a scientific study is missing');
  return 'Instagram and Facebook posts must carry the advertising notice and a scientific reference — ' + parts.join(', and ') + '.';
}

/** The instruction handed to the writer for Instagram / Facebook copy. */
export const REF_INSTRUCTION =
  ' Compliance (Mexican health-advertising rules for this clinic): the "instagram" and "facebook" values MUST end with' +
  ' a line that starts with "REF: " citing ONE real, peer-reviewed study that supports the post\'s main claim, in the form' +
  ' Author, A.B., et al. (Year). "Title." Journal, volume(issue), pages. DOI: 10.xxxx/xxxxx — only cite a study you are' +
  ' confident exists, with its real DOI; never invent a citation. Put the REF line after the hashtags. Do NOT write an' +
  ' "AVISO DE PUBLICIDAD" line yourself; the app adds it.';
