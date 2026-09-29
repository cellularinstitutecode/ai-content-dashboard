// web/lib/citation.ts
// Is the study in a REF line real? Language models invent plausible
// citations, and a made-up reference under a health-advertising notice is
// worse than none. Crossref resolves DOIs for free and without a key, so every
// REF line with a DOI is looked up before the draft is shown.
//
// Advisory by design: a verified citation is shown as verified, a DOI Crossref
// does not know is flagged for a human to fix, and an unreachable Crossref is
// reported as "could not verify" — never as "invalid". The hard rule at the
// approval gate is that the REF line exists; whether it checks out is a badge
// the reviewer sees, because Crossref being down must not stop the clinic
// from posting a caption it has already read.

/**
 * 'not_required': the post carries no REF line and needs none — it is under the
 * "only when it makes a health claim" policy and makes no claim (lib/health-claim.ts).
 * 'mismatch': the DOI resolves, but to a paper whose title shares almost nothing
 * with the title the REF line quotes. Blocked like 'not_found'.
 */
export type CitationStatus = 'verified' | 'not_found' | 'no_doi' | 'unavailable' | 'not_required' | 'mismatch';

export type CitationCheck = {
  status: CitationStatus;
  doi: string | null;
  /** Crossref's title for the work, when verified. */
  title: string | null;
  year: number | null;
};

const CROSSREF_BASE = () => (process.env.CROSSREF_API_BASE || 'https://api.crossref.org').replace(/\/$/, '');

/** Function words dropped before titles are compared (English and Spanish). */
const TITLE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'its', 'their', 'among', 'versus', 'via', 'are', 'was', 'were', 'this', 'that',
  'del', 'los', 'las', 'una', 'con', 'por', 'para', 'sobre',
]);

/** A title as comparable tokens: lower case, no accents, tags or punctuation, no function words. */
export function titleTokens(title: string | null | undefined): string[] {
  const plain = String(title || '')
    .replace(/<[^>]+>/g, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  return [...new Set(plain.split(' ').filter((t) => t.length >= 3 && !TITLE_STOPWORDS.has(t)))];
}

/** Same word, allowing for an ending ("nutrition" / "nutritional"). */
function sameWord(a: string, b: string): boolean {
  return a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
}

/** Share of the shorter title's tokens found in the other, 0..1. */
export function titleOverlap(a: string | null | undefined, b: string | null | undefined): number {
  const x = titleTokens(a);
  const y = titleTokens(b);
  if (!x.length || !y.length) return 0;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  const hits = short.filter((t) => long.some((u) => sameWord(t, u))).length;
  return hits / short.length;
}

/**
 * Do the quoted title and the resolved one name clearly different papers?
 * Only judged when both have at least three content words; below that there is
 * too little to go on and nothing is flagged.
 */
export function titlesDisagree(quoted: string | null | undefined, resolved: string | null | undefined): boolean {
  if (titleTokens(quoted).length < 3 || titleTokens(resolved).length < 3) return false;
  return titleOverlap(quoted, resolved) < 0.34;
}

/**
 * The paper title a REF line gives: the quoted one ("Title."), else the
 * sentence after "(Year)." in the `Author et al. (Year). Title. Journal.` form.
 * Null when neither is there.
 */
export function refTitle(ref: string | null | undefined): string | null {
  const text = String(ref || '').replace(/^\s*REF:\s*/i, '');
  const quoted = /["\u201c\u201d]([^"\u201c\u201d]{8,300})["\u201c\u201d]/.exec(text);
  if (quoted) return quoted[1].trim().replace(/[.,;:]+$/, '');
  const beforeDoi = text.split(/\bdoi\s*:|https?:\/\/(?:dx\.)?doi\.org\/|\b10\.\d{4,9}\//i)[0];
  const afterYear = /\(\s*(?:19|20)\d{2}[a-z]?\s*\)\.?\s*(.+)$/i.exec(beforeDoi);
  if (!afterYear) return null;
  const title = afterYear[1].split(/\.\s+(?=[A-Z0-9])/)[0].replace(/[.\s]+$/, '').trim();
  return title.length >= 8 ? title : null;
}

export async function verifyDoi(
  doi: string | null | undefined,
  /** `expectedTitle`: the title the REF line quotes; a resolved title that clearly differs is 'mismatch'. */
  opts: { timeoutMs?: number; expectedTitle?: string | null } = {},
): Promise<CitationCheck> {
  const d = (doi || '').trim();
  if (!d) return { status: 'no_doi', doi: null, title: null, year: null };
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 6000);
  try {
    const res = await fetch(CROSSREF_BASE() + '/works/' + encodeURIComponent(d), {
      headers: { accept: 'application/json', 'user-agent': 'ContentStudio/1 (mailto:cellularhopeinstitute@gmail.com)' },
      signal: ctl.signal,
    });
    if (res.status === 404) return { status: 'not_found', doi: d, title: null, year: null };
    if (!res.ok) return { status: 'unavailable', doi: d, title: null, year: null };
    const j: any = await res.json().catch(() => null);
    const msg = j?.message;
    const title = Array.isArray(msg?.title) && msg.title[0] ? String(msg.title[0]) : null;
    const yearParts = msg?.issued?.['date-parts']?.[0] ?? msg?.published?.['date-parts']?.[0];
    const year = Array.isArray(yearParts) && Number.isFinite(Number(yearParts[0])) ? Number(yearParts[0]) : null;
    if (opts.expectedTitle && title && titlesDisagree(opts.expectedTitle, title)) return { status: 'mismatch', doi: d, title, year };
    return { status: 'verified', doi: d, title, year };
  } catch {
    return { status: 'unavailable', doi: d, title: null, year: null };
  } finally {
    clearTimeout(to);
  }
}

/** One short phrase for the badge next to a REF line. */
export function citationLabel(c: CitationCheck | null | undefined): string {
  if (!c) return '';
  switch (c.status) {
    case 'verified': return 'Citation verified' + (c.year ? ' (' + c.year + ')' : '');
    case 'not_found': return 'Citation not found — check the reference';
    case 'mismatch': return 'The DOI in the REF line points to a different paper: ' + (c.title ? '"' + c.title + '"' : 'not the study it names');
    case 'no_doi': return 'Reference has no DOI — check it by hand';
    case 'not_required': return 'No citation needed — this post makes no health claim';
    default: return 'Citation could not be verified right now';
  }
}
