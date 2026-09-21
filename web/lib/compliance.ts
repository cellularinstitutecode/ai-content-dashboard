// web/lib/compliance.ts
// The advertising rule for the clinic's SOCIAL posts, as pure functions so it
// can be unit-tested and applied identically everywhere.
//
// It started as an Instagram and Facebook rule and is not one any more:
// LinkedIn and TikTok were added on 9 September and YouTube on 10 September,
// because complianceGate was answering "does not apply" for the very networks
// the clinic's video work goes to. SOCIAL_NETWORKS below is the list, and
// complianceNetworksLabel() builds every sentence from it so the wording can
// never again claim a narrower rule than the one being enforced.
//
//   Every post on one of those networks must carry
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

/**
 * Networks the rule applies to. Metricool's ids and the app's ids both appear.
 *
 * LinkedIn and TikTok were missing, so complianceGate answered "does not apply" for the
 * two networks the video pipeline actually publishes to — the gate that exists to stop an
 * uncited medical claim reaching a queue was never consulted for them. The rule is about
 * advertising a clinic's therapies in Mexico, which does not stop being true because the
 * post is on LinkedIn.
 *
 * YouTube joined them for exactly the same reason once it became selectable in the
 * composer. A video description making a therapeutic claim is advertising; the platform
 * it is hosted on has never been what the rule turns on.
 */
const SOCIAL_NETWORKS = new Set(['instagram', 'facebook', 'ig', 'fb', 'linkedin', 'tiktok', 'youtube']);

/**
 * And the blog, which is not a social network and was therefore exempt from a
 * rule that has nothing to do with social networks.
 *
 * The same reasoning as LinkedIn's and YouTube's, one step further: the rule is
 * about advertising a clinic's therapies in Mexico, and an 800-word article
 * making a therapeutic claim is advertising by any reading. It was the ONE
 * format that skipped the AVISO and the citation — and the longest-lived thing
 * the clinic publishes, sitting on its own domain being indexed, long after a
 * post has scrolled away.
 *
 * Kept separate from SOCIAL_NETWORKS only so the refusal sentence can say
 * "blog articles" rather than listing it among the networks.
 */
const ARTICLE_CHANNELS = new Set(['blog']);

/** Every channel the rule covers. */
const GATED_CHANNELS = new Set([...SOCIAL_NETWORKS, ...ARTICLE_CHANNELS]);

/** Proper names for the channel ids, for a sentence a person reads. */
const NETWORK_NAMES: Record<string, string> = {
  instagram: 'Instagram', ig: 'Instagram', facebook: 'Facebook', fb: 'Facebook',
  linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube', blog: 'blog article',
};

/**
 * The networks this rule covers, named, for the sentence shown when a post is
 * refused — derived from SOCIAL_NETWORKS rather than typed out beside it.
 *
 * Every message used to say "Instagram and Facebook posts…" and kept saying it
 * for a week after LinkedIn, TikTok and YouTube joined the set, so somebody
 * with none of those two selected was told their post failed a rule about two
 * networks they were not posting to. Reading the set is what stops that
 * happening again the next time it changes.
 *
 * `only` narrows it to the networks actually selected, which is what the
 * composer wants; with no argument it names them all.
 */
export function complianceNetworksLabel(only?: readonly string[] | null): string {
  const ids = (only && only.length ? only.map((p) => String(p || '').trim().toLowerCase()).filter((p) => GATED_CHANNELS.has(p)) : [...GATED_CHANNELS]);
  const names: string[] = [];
  for (const id of ids) {
    const name = NETWORK_NAMES[id] || id;
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length) return 'These';
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

export function appliesTo(providers: readonly string[] | string | null | undefined): boolean {
  const list = Array.isArray(providers) ? providers : providers ? [providers] : [];
  return list.some((p) => GATED_CHANNELS.has(String(p || '').trim().toLowerCase()));
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
//
// Shape only, deliberately — the DOI is what makes it checkable, and that is tested
// separately below so a citation can be REPORTED as present-but-unverifiable rather than
// silently accepted. verifyDoi only ever sees citations that carry one.
const REF_RE = /(^|\n)[ \t]*REF(?:ERENCIA)?[ \t]*[.:：][ \t]*(\S[^\n]{15,})/i;
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>)\]]+)/i;

export type ComplianceCheck = {
  ok: boolean;
  /**
   * What is wrong. 'ref' means there is no REF line at all; 'doi' means there
   * IS one and it carries no DOI. Told apart on purpose: one message for both
   * sent people hunting for a line that was already sitting in front of them.
   */
  missing: ('aviso' | 'ref' | 'doi')[];
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
  const missing: ('aviso' | 'ref' | 'doi')[] = [];
  const av = AVISO_RE.exec(t);
  const avisoFound = av ? av[1].toUpperCase() : null;
  const expected = (expectedAviso || '').trim().toUpperCase() || DEFAULT_AVISO_NUMBER;
  const avisoMismatch = Boolean(avisoFound && avisoFound !== expected);
  if (!avisoFound || avisoMismatch) missing.push('aviso');
  const rf = REF_RE.exec(t);
  const ref = rf ? rf[2].trim() : null;
  const doi = ref ? (DOI_RE.exec(ref)?.[1] ?? null) : null;
  // A citation with no DOI is not a citation this app can stand behind. Only a DOI
  // reaches Crossref, so a plausible-looking reference without one was passing every
  // check while nothing had ever confirmed the study exists — the exact failure the
  // "never invent a citation" instruction is there to prevent, with no way to catch it.
  if (!ref) missing.push('ref');
  else if (!doi) missing.push('doi');
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
export function complianceMessage(check: ComplianceCheck, networks?: readonly string[] | null): string {
  if (check.ok) return '';
  const parts: string[] = [];
  if (check.missing.includes('aviso')) {
    parts.push(check.avisoMismatch
      ? 'the AVISO DE PUBLICIDAD line carries a different permit number'
      : 'the AVISO DE PUBLICIDAD line is missing');
  }
  if (check.missing.includes('ref')) parts.push('the REF line citing a scientific study is missing');
  if (check.missing.includes('doi')) parts.push('the REF line has no DOI — it needs one like 10.1016/j.example.2024.01.001, which is what lets the citation be checked');
  return complianceNetworksLabel(networks) + ' posts must carry the advertising notice and a scientific reference \u2014 ' + parts.join(', and ') + '.';
}

/**
 * The instruction handed to the writer for Instagram / Facebook copy.
 *
 * It names those two because they are the two the writer is asked to compose
 * the citation FOR; the app copies the verified REF onto the other gated
 * channels itself (lib/ai.ts), which is why they are not listed here as
 * something to write separately — a second citation would need verifying a
 * second time.
 */
export const REF_INSTRUCTION =
  ' Compliance (Mexican health-advertising rules for this clinic): the "instagram" and "facebook" values MUST each end with' +
  ' a line that starts with "REF: " citing ONE real, peer-reviewed study that supports the post\'s main claim, in the form' +
  ' Author, A.B., et al. (Year). "Title." Journal, volume(issue), pages. DOI: 10.xxxx/xxxxx — only cite a study you are' +
  ' confident exists, and it MUST carry its real DOI, because the DOI is checked against Crossref and a citation without' +
  ' one is rejected; never invent a citation. The same citation also carries the LinkedIn, TikTok and blog-article versions' +
  ' of this post, so it has to support what all of them claim. Put the REF line last, after the hashtags — the app moves it' +
  ' into its final position. Do NOT write an "AVISO DE PUBLICIDAD" line yourself; the app adds it.';
