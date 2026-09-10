// web/lib/evidence-parse.ts
// Reading a paper out of PubMed's XML and Crossref's JSON.
//
// Split out of lib/evidence.ts, which imports `server-only` and so cannot be
// loaded by `node --experimental-strip-types --test`. That matters more here
// than anywhere else in this feature: parsing is done with regexes against a
// document shape nobody controls, and the failure mode is not an error — it is
// an empty result, which is indistinguishable from "there is no research on
// this subject". Untested, it could return nothing for months and look like the
// literature simply had nothing to say.
//
// Regexes rather than an XML parser on purpose. Five fields are needed out of a
// document whose shape NCBI has kept stable for two decades; a dependency would
// have to earn its place against that, and the tests below pin the shapes that
// actually arrive — including the structured abstracts, which are several
// labelled blocks rather than one.

export type EvidenceItem = {
  title: string;
  journal: string;
  year: number | null;
  doi: string;
  firstAuthor: string;
  abstract: string;
};

/** Strip inline markup and entities; collapse whitespace. */
export function plain(xml: string): string {
  return String(xml || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    // Ampersand last, or "&amp;lt;" would decode twice into a tag.
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function inside(xml: string, name: string): string {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>').exec(xml);
  return m ? m[1] : '';
}

/** "Calcat-i-Cervera, S., et al." from the first author, when there is one. */
function authorLabel(surname: string, initials: string): string {
  if (!surname) return '';
  const inits = initials ? ', ' + initials.split('').filter(Boolean).map((c) => c + '.').join('') : '';
  return surname + inits + ', et al.';
}

/**
 * One `<PubmedArticle>`.
 *
 * Returns null unless title, DOI and abstract are all present — a paper missing
 * any of them is one the copy must not quote anyway, so dropping it here saves
 * the writer from being offered something it cannot safely use.
 */
export function parsePubmedArticle(xml: string): EvidenceItem | null {
  const title = plain(inside(xml, 'ArticleTitle'));
  // Structured abstracts arrive as several labelled blocks — BACKGROUND,
  // METHODS, RESULTS, CONCLUSIONS — and taking only the first would hand over
  // the setup and drop the finding.
  const blocks = xml.match(/<AbstractText(?:\s[^>]*)?>[\s\S]*?<\/AbstractText>/g) || [];
  const abstract = plain(blocks.join(' '));
  const doi = (/<ArticleId\s+IdType="doi">([\s\S]*?)<\/ArticleId>/.exec(xml)?.[1] || '').trim();
  // <Title> is the journal's full name; ISOAbbreviation is the fallback.
  const journal = plain(inside(xml, 'Title')) || plain(inside(xml, 'ISOAbbreviation'));
  const yearRaw = plain(inside(xml, 'Year'));
  const year = /^\d{4}$/.test(yearRaw) ? Number(yearRaw) : null;

  if (!title || !doi || !abstract) return null;
  return {
    title,
    journal: journal || 'PubMed',
    year,
    doi,
    firstAuthor: authorLabel(plain(inside(xml, 'LastName')), plain(inside(xml, 'Initials'))),
    abstract,
  };
}

/** One item from a Crossref `/works` search. */
export function parseCrossrefWork(it: Record<string, any>): EvidenceItem | null {
  const title = plain(String((it?.title || [])[0] || ''));
  // Crossref abstracts are JATS XML inside a JSON string.
  const abstract = plain(String(it?.abstract || ''));
  const doi = String(it?.DOI || '').trim();
  if (!title || !doi || !abstract) return null;
  const a = (it?.author || [])[0] || {};
  const surname = String(a.family || '').trim();
  return {
    title,
    journal: plain(String((it['container-title'] || [])[0] || '')) || 'Crossref',
    year: Number(it?.issued?.['date-parts']?.[0]?.[0]) || null,
    doi,
    firstAuthor: authorLabel(surname, a.given ? String(a.given)[0] : ''),
    abstract,
  };
}
