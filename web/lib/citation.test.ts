// A REF line is only worth something if the study exists. Crossref answers
// that; these tests pin how each answer (and no answer) is reported, against
// a local stand-in so nothing here reaches the internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyDoi, citationLabel, refTitle, titlesDisagree } from './citation.ts';

let server: http.Server;
let base = '';

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.includes('10.3390%2Fnu13072421') || url.includes('10.3390/nu13072421')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: { title: ['Beneficial Outcomes of Omega-6 and Omega-3'], issued: { 'date-parts': [[2021, 7, 15]] } } }));
    }
    if (url.includes('10.3390%2Fnu10040478')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: { title: ['Vitamin D Deficiency and Antenatal and Postpartum Depression: A Systematic Review'], issued: { 'date-parts': [[2018]] } } }));
    }
    if (url.includes('10.1503%2Fcmaj.051351')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: { title: ['Health benefits of physical activity: the evidence'], issued: { 'date-parts': [[2006, 3, 14]] } } }));
    }
    if (url.includes('10.1787%2Fhealth_glance-2023-en')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: { title: ['Health at a Glance 2023: OECD Indicators'], issued: { 'date-parts': [[2023, 11, 7]] } } }));
    }
    if (url.includes('10.9999')) { res.writeHead(404); return res.end('Resource not found.'); }
    res.writeHead(500); res.end('boom');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  base = 'http://127.0.0.1:' + addr.port;
  process.env.CROSSREF_API_BASE = base;
});

after(() => { server.close(); delete process.env.CROSSREF_API_BASE; });

test('a real DOI is verified, with the title and year Crossref knows', async () => {
  const c = await verifyDoi('10.3390/nu13072421');
  assert.equal(c.status, 'verified');
  assert.equal(c.year, 2021);
  assert.match(c.title || '', /Omega/);
  assert.match(citationLabel(c), /verified \(2021\)/);
});

test('a DOI Crossref does not know is reported as not found — the human is told to check', async () => {
  const c = await verifyDoi('10.9999/made.up.2024');
  assert.equal(c.status, 'not_found');
  assert.match(citationLabel(c), /not found/);
});

test('no DOI and an unreachable Crossref are reported honestly, never as invalid', async () => {
  assert.equal((await verifyDoi('')).status, 'no_doi');
  assert.equal((await verifyDoi(null)).status, 'no_doi');
  const c = await verifyDoi('10.1000/server.error');
  assert.equal(c.status, 'unavailable');
  assert.match(citationLabel(c), /could not be verified/);
  process.env.CROSSREF_API_BASE = 'http://127.0.0.1:1';
  const down = await verifyDoi('10.3390/nu13072421', { timeoutMs: 1500 });
  assert.equal(down.status, 'unavailable');
  process.env.CROSSREF_API_BASE = base;
});

// --- the DOI must be the paper the REF line names -----------------------------

const WRONG_REF = 'REF: Smith, J., et al. (2018). "Evidence-based criteria in the nutritional context." Nutrients, 10(4), 478. DOI: 10.3390/nu10040478';
const RIGHT_REF = 'REF: Warburton DER et al. (2006). Health benefits of physical activity: the evidence. CMAJ. DOI: 10.1503/cmaj.051351';

test('the title is read from both REF forms', () => {
  assert.equal(refTitle(WRONG_REF), 'Evidence-based criteria in the nutritional context');
  assert.equal(refTitle(RIGHT_REF), 'Health benefits of physical activity: the evidence');
  assert.equal(refTitle('REF: DOI 10.1000/x'), null);
});

test('a DOI that resolves to a different paper is a mismatch, and says which paper', async () => {
  const c = await verifyDoi('10.3390/nu10040478', { expectedTitle: refTitle(WRONG_REF) });
  assert.equal(c.status, 'mismatch');
  assert.equal(c.title, 'Vitamin D Deficiency and Antenatal and Postpartum Depression: A Systematic Review');
  assert.equal(citationLabel(c), 'The DOI in the REF line points to a different paper: "Vitamin D Deficiency and Antenatal and Postpartum Depression: A Systematic Review"');
});

test('a DOI whose paper matches the quoted title passes', async () => {
  const c = await verifyDoi('10.1503/cmaj.051351', { expectedTitle: refTitle(RIGHT_REF) });
  assert.equal(c.status, 'verified');
  assert.equal(c.year, 2006);
});

test('a non-PubMed source Crossref knows (OECD) passes', async () => {
  const c = await verifyDoi('10.1787/health_glance-2023-en', { expectedTitle: 'Health at a Glance 2023' });
  assert.equal(c.status, 'verified');
});

test('titles are compared on their words, loosely, and only when there is enough to compare', () => {
  assert.equal(titlesDisagree('Health benefits of physical activity', 'Health Benefits of Physical Activity: The Evidence'), false);
  assert.equal(titlesDisagree('Nutritional context and evidence-based criteria', 'Evidence-based criteria in the nutrition context'), false);
  assert.equal(titlesDisagree('Evidence-based criteria in the nutritional context', 'Vitamin D Deficiency and Antenatal and Postpartum Depression: A Systematic Review'), true);
  assert.equal(titlesDisagree('Sleep', 'Vitamin D Deficiency and Antenatal and Postpartum Depression'), false, 'too little to judge');
  assert.equal(titlesDisagree('<i>In vivo</i> effects of sleep restriction on glucose', 'In vivo effects of sleep restriction on glucose tolerance'), false);
});
