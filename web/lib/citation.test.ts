// A REF line is only worth something if the study exists. Crossref answers
// that; these tests pin how each answer (and no answer) is reported, against
// a local stand-in so nothing here reaches the internet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { verifyDoi, citationLabel } from './citation.ts';

let server: http.Server;
let base = '';

before(async () => {
  server = http.createServer((req, res) => {
    const url = req.url || '';
    if (url.includes('10.3390%2Fnu13072421') || url.includes('10.3390/nu13072421')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: { title: ['Beneficial Outcomes of Omega-6 and Omega-3'], issued: { 'date-parts': [[2021, 7, 15]] } } }));
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
