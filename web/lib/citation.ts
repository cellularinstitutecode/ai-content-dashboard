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

export type CitationStatus = 'verified' | 'not_found' | 'no_doi' | 'unavailable';

export type CitationCheck = {
  status: CitationStatus;
  doi: string | null;
  /** Crossref's title for the work, when verified. */
  title: string | null;
  year: number | null;
};

const CROSSREF_BASE = () => (process.env.CROSSREF_API_BASE || 'https://api.crossref.org').replace(/\/$/, '');

export async function verifyDoi(doi: string | null | undefined, opts: { timeoutMs?: number } = {}): Promise<CitationCheck> {
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
    case 'no_doi': return 'Reference has no DOI — check it by hand';
    default: return 'Citation could not be verified right now';
  }
}
