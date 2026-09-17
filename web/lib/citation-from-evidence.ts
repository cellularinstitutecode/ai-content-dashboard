// web/lib/citation-from-evidence.ts
// A REF line built from a paper that actually exists.
//
// THE PROBLEM. Every post on the clinic's networks must carry a REF line with
// a DOI, and the writer was asked for one only on the Instagram and Facebook
// variants. When it produced none — or produced a citation with no DOI — the
// row was prepared anyway and the post was refused at the door, with nothing
// to do but write a citation by hand.
//
// THE THING THAT MAKES THIS SAFE. The pipeline ALREADY searches PubMed for
// real papers on the video's subject (lib/evidence.ts findEvidence) and hands
// them to the writer as background. Those items carry a title, a journal, a
// year, a first author and a DOI, straight from PubMed. They were then thrown
// away. So nothing here invents a citation: it uses a paper that was already
// found, and the caller verifies the DOI against Crossref before it is used.
//
// If no paper was found, this returns null and the post is refused exactly as
// it is today. A missing citation is a problem; a fabricated one on a medical
// advertisement is a different and much worse thing, and no amount of
// convenience is worth it.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import type { EvidenceItem } from './evidence-parse.ts';

/** A DOI as it really looks. The same shape lib/compliance.ts accepts. */
const DOI_RE = /^10\.\d{4,9}\/\S+$/;

/** Is this item usable as a citation — a real paper with a real DOI? */
export function citable(item: EvidenceItem | null | undefined): boolean {
  if (!item) return false;
  const doi = String(item.doi || '').trim();
  return DOI_RE.test(doi) && Boolean(String(item.title || '').trim());
}

/**
 * The best paper to cite from what the search found.
 *
 * Newest first among those with a DOI: a 2024 trial reads better on a clinic's
 * post than a 1998 one, and the search already ranked for relevance, so recency
 * is the only tie-break worth applying on top.
 */
export function pickCitation(items: readonly EvidenceItem[] | null | undefined): EvidenceItem | null {
  const usable = (items || []).filter(citable);
  if (!usable.length) return null;
  return [...usable].sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0))[0];
}

/**
 * The REF line for a paper: author, year, title, journal, DOI.
 *
 * Shaped to pass lib/compliance.ts's check — a "REF:" label, more than sixteen
 * characters, and a DOI it can find — because a citation this app writes and
 * its own gate then refuses would be worse than useless.
 */
export function refLineFrom(item: EvidenceItem): string {
  const author = String(item.firstAuthor || '').trim();
  const year = Number(item.year) || null;
  const title = String(item.title || '').trim().replace(/\s+/g, ' ').replace(/\.*$/, '');
  const journal = String(item.journal || '').trim();
  const doi = String(item.doi || '').trim();

  const parts: string[] = [];
  if (author) parts.push(year ? author + ' et al. (' + year + ').' : author + '.');
  else if (year) parts.push('(' + year + ').');
  if (title) parts.push(title + '.');
  if (journal) parts.push(journal + '.');
  parts.push('DOI: ' + doi);
  return 'REF: ' + parts.join(' ');
}

/** The REF line for the best paper found, or null when nothing is citable. */
export function refLineFromEvidence(items: readonly EvidenceItem[] | null | undefined): string | null {
  const best = pickCitation(items);
  return best ? refLineFrom(best) : null;
}
