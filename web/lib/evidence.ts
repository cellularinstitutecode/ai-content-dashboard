// web/lib/evidence.ts
// Finding real papers for a video, before the copy is written.
//
// Two sources, deliberately in this order.
//
// PubMed first. It is the curated biomedical index — MeSH terms, abstracts,
// publication types — and for a regenerative-medicine clinic making claims
// under COFEPRIS, "what does the biomedical literature say" is the actual
// question. Free, no key.
//
// Crossref second, because it is PROVEN reachable from this deployment: the
// citation badge in the dashboard comes from a live Crossref call today, so a
// fallback there is a fallback to something known to work rather than to a
// second hope. It indexes everything rather than curating, which is exactly
// why it is not first.
//
// Fail open, always and everywhere. A video that cannot be researched is a
// video written the way every video was written until now — the badge says so
// (the same way it already says "NO keyword data") and nothing is blocked. The
// alternative is a clinic unable to publish because a public API was slow.
import 'server-only';

import { evidenceQuery, filterRelevant } from '@/lib/evidence-query';
import { reportError } from '@/lib/report';
import { parseCrossrefWork, parsePubmedArticle, type EvidenceItem } from '@/lib/evidence-parse';

/** The whole step, start to finish. Beyond this it is not worth the clock. */
const TOTAL_MS = 9000;
/** How many candidates to offer the writer. */
const WANT = 3;

const PUBMED = () => (process.env.PUBMED_API_BASE || 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils').replace(/\/$/, '');
const CROSSREF = () => (process.env.CROSSREF_API_BASE || 'https://api.crossref.org').replace(/\/$/, '');
/** NCBI asks for a contact on automated requests; Crossref rewards one with better service. */
const UA = 'ContentStudio/1 (mailto:cellularhopeinstitute@gmail.com)';

async function getJson(url: string, signal: AbortSignal): Promise<any> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA }, signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function getText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function fromPubmed(term: string, signal: AbortSignal): Promise<EvidenceItem[]> {
  const search = await getJson(
    PUBMED() + '/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=' + WANT +
    '&term=' + encodeURIComponent(term),
    signal,
  );
  const ids: string[] = search?.esearchresult?.idlist || [];
  if (!ids.length) return [];
  const xml = await getText(PUBMED() + '/efetch.fcgi?db=pubmed&retmode=xml&id=' + ids.join(','), signal);
  const articles = xml.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g) || [];
  return articles.map(parsePubmedArticle).filter((x): x is EvidenceItem => Boolean(x));
}

async function fromCrossref(term: string, signal: AbortSignal): Promise<EvidenceItem[]> {
  const j = await getJson(
    CROSSREF() + '/works?rows=' + WANT + '&filter=type:journal-article,has-abstract:true' +
    '&select=DOI,title,abstract,container-title,issued,author' +
    '&query.bibliographic=' + encodeURIComponent(term),
    signal,
  );
  const items: unknown[] = j?.message?.items || [];
  return items
    .map((it) => parseCrossrefWork(it as Record<string, unknown>))
    .filter((x): x is EvidenceItem => Boolean(x));
}

/**
 * Papers worth showing the writer for this video.
 *
 * Never throws and never blocks: every failure path returns [], and the caller
 * writes the post exactly as it would have before.
 */
export async function findEvidence(subject: string, keywords: readonly string[] = []): Promise<EvidenceItem[]> {
  const q = evidenceQuery(subject, keywords);
  if (!q.primary) return [];

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), TOTAL_MS);
  try {
    // Primary query, then the deliberately shorter one — see lib/evidence-query.ts
    // for why length is the thing most likely to return nothing.
    for (const term of [q.primary, q.broad].filter(Boolean)) {
      // ABOUT THE SUBJECT, OR NOT OFFERED. The broad two-word retry on an
      // index that matches anything is how a tadalafil trial reached a
      // peptides post (the September audit, point 3). A hit that shares none
      // of the subject's words is not a weaker candidate; it is not one.
      try {
        const found = filterRelevant(await fromPubmed(term, ctl.signal), q.terms);
        if (found.length) return found;
      } catch (e) {
        // Reported once, not per query: PubMed being unreachable is one fact.
        if (term === q.primary) reportError('evidence:pubmed', e, { term });
      }
      try {
        const found = filterRelevant(await fromCrossref(term, ctl.signal), q.terms);
        if (found.length) return found;
      } catch (e) {
        if (term === q.primary) reportError('evidence:crossref', e, { term });
      }
    }
    return [];
  } catch (e) {
    reportError('evidence:find', e);
    return [];
  } finally {
    clearTimeout(to);
  }
}

/**
 * One paper, by its DOI, with its abstract — so a citation the writer
 * recalled on its own can be judged the way a fetched one is.
 *
 * The judge (lib/claim-support.ts) reads abstracts, and until now it could
 * only read the abstracts of papers the search had returned: a DOI the writer
 * brought from elsewhere was 'unchecked', which every door then waved
 * through. PubMed first (by DOI), Crossref second, and null when neither has
 * an abstract: an unverifiable citation stays unverified rather than judged
 * on its title alone. Never throws.
 */
export async function findByDoi(doi: string): Promise<EvidenceItem | null> {
  const id = String(doi || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(id)) return null;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), TOTAL_MS);
  try {
    try {
      const search = await getJson(
        PUBMED() + '/esearch.fcgi?db=pubmed&retmode=json&retmax=1&term=' + encodeURIComponent(id + '[DOI]'),
        ctl.signal,
      );
      const ids: string[] = search?.esearchresult?.idlist || [];
      if (ids.length) {
        const xml = await getText(PUBMED() + '/efetch.fcgi?db=pubmed&retmode=xml&id=' + ids[0], ctl.signal);
        const article = (xml.match(/<PubmedArticle>[\s\S]*?<\/PubmedArticle>/g) || [])[0];
        const item = article ? parsePubmedArticle(article) : null;
        if (item && item.abstract) return item;
      }
    } catch (e) {
      reportError('evidence:pubmed-doi', e, { doi: id });
    }
    try {
      const j = await getJson(CROSSREF() + '/works/' + encodeURIComponent(id), ctl.signal);
      const item = parseCrossrefWork((j?.message || {}) as Record<string, unknown>);
      if (item && item.abstract) return item;
    } catch (e) {
      reportError('evidence:crossref-doi', e, { doi: id });
    }
    return null;
  } finally {
    clearTimeout(to);
  }
}
