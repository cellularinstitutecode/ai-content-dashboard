import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCrossrefWork, parsePubmedArticle, plain } from './evidence-parse.ts';

/**
 * Shaped on the real record for PMID 37143116 — the multicentre MSC
 * manufacturing study found while designing this feature. Structured abstract,
 * because that is what clinical papers actually return.
 */
const PUBMED_XML = `<PubmedArticle>
  <MedlineCitation>
    <Article>
      <Journal>
        <Title>Stem cell research &amp; therapy</Title>
        <ISOAbbreviation>Stem Cell Res Ther</ISOAbbreviation>
        <JournalIssue><PubDate><Year>2023</Year><Month>05</Month></PubDate></JournalIssue>
      </Journal>
      <ArticleTitle>Harmonised culture procedures minimise but do not eliminate mesenchymal stromal cell donor and tissue variability.</ArticleTitle>
      <Abstract>
        <AbstractText Label="BACKGROUND">Clinical potency can vary depending on tissue source and culture conditions.</AbstractText>
        <AbstractText Label="RESULTS">Harmonised procedures reduce but do not eliminate inter-lab differences.</AbstractText>
      </Abstract>
      <AuthorList>
        <Author><LastName>Calcat-i-Cervera</LastName><ForeName>Sandra</ForeName><Initials>S</Initials></Author>
        <Author><LastName>Rendra</LastName><Initials>E</Initials></Author>
      </AuthorList>
    </Article>
  </MedlineCitation>
  <PubmedData><ArticleIdList>
    <ArticleId IdType="pubmed">37143116</ArticleId>
    <ArticleId IdType="doi">10.1186/s13287-023-03352-1</ArticleId>
  </ArticleIdList></PubmedData>
</PubmedArticle>`;

test('a real PubMed record yields every field the REF line needs', () => {
  const got = parsePubmedArticle(PUBMED_XML);
  assert.ok(got, 'must parse');
  assert.match(got.title, /^Harmonised culture procedures/);
  assert.equal(got.doi, '10.1186/s13287-023-03352-1');
  assert.equal(got.year, 2023);
  assert.equal(got.journal, 'Stem cell research & therapy', 'entity decoded');
  assert.equal(got.firstAuthor, 'Calcat-i-Cervera, S., et al.');
});

test('a structured abstract keeps the finding, not just the background', () => {
  // Clinical abstracts arrive as labelled blocks. Taking only the first hands
  // over the setup and drops the result — the one part worth quoting.
  const got = parsePubmedArticle(PUBMED_XML);
  assert.match(String(got?.abstract), /Clinical potency can vary/);
  assert.match(String(got?.abstract), /reduce but do not eliminate/, 'the RESULTS block must survive');
});

test('the DOI is taken from its own id type, not the PMID next to it', () => {
  const got = parsePubmedArticle(PUBMED_XML);
  assert.notEqual(got?.doi, '37143116');
});

test('a paper that cannot be safely quoted is dropped rather than offered', () => {
  // No DOI means no verifiable REF line; no abstract means nothing to quote
  // from. Either way the writer must not be handed it.
  assert.equal(parsePubmedArticle(PUBMED_XML.replace(/<ArticleId IdType="doi">[\s\S]*?<\/ArticleId>/, '')), null);
  assert.equal(parsePubmedArticle(PUBMED_XML.replace(/<Abstract>[\s\S]*?<\/Abstract>/, '')), null);
  assert.equal(parsePubmedArticle('<PubmedArticle></PubmedArticle>'), null);
  assert.equal(parsePubmedArticle(''), null);
});

test('markup and entities are stripped without decoding twice', () => {
  // "&amp;lt;" must become "&lt;", not "<" — decoding the ampersand first would
  // turn escaped text back into a tag and then delete it.
  assert.equal(plain('<i>Nature</i> &amp; Science'), 'Nature & Science');
  assert.equal(plain('a &amp;lt; b'), 'a &lt; b');
  assert.equal(plain('<p>one</p>\n\n<p>two</p>'), 'one two');
});

test('a Crossref work parses to the same shape', () => {
  const got = parseCrossrefWork({
    DOI: '10.1016/j.stem.2011.06.008',
    title: ['The MSC: an injury drugstore'],
    abstract: '<jats:p>Mesenchymal stem cells secrete bioactive factors.</jats:p>',
    'container-title': ['Cell Stem Cell'],
    issued: { 'date-parts': [[2011, 7]] },
    author: [{ family: 'Caplan', given: 'Arnold I.' }],
  });
  assert.ok(got);
  assert.equal(got.doi, '10.1016/j.stem.2011.06.008');
  assert.equal(got.year, 2011);
  assert.equal(got.firstAuthor, 'Caplan, A., et al.');
  assert.equal(got.abstract, 'Mesenchymal stem cells secrete bioactive factors.', 'JATS stripped');
});

test('a Crossref work without an abstract is not offered either', () => {
  assert.equal(parseCrossrefWork({ DOI: '10.1/x', title: ['T'] }), null);
  assert.equal(parseCrossrefWork({}), null);
});
