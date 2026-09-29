import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_CLAIMS, cleanQuery, claimsPrompt, parseClaims } from './claim-extract.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a post comes apart into claims, each with a search PubMed can run', () => {
  const out = parseClaims('{"claims":[' +
    '{"claim":"Fat-soluble vitamins A, D, E and K can accumulate in the body and cause harm in excess.","query":"fat-soluble vitamin toxicity accumulation"},' +
    '{"claim":"The supplement industry is largely self-regulated and products are not tested before sale.","query":"dietary supplement regulation \\"FDA\\" AND oversight"},' +
    '{"claim":"Whole foods provide better absorption than isolated pills.","query":"whole food vs supplement nutrient bioavailability"},' +
    '{"claim":"A fourth one.","query":"one two three"}]}');
  assert.equal(out.length, MAX_CLAIMS);
  assert.equal(out[0].query, 'fat-soluble vitamin toxicity accumulation');
  // Quotes and operators go; PubMed ANDs everything anyway.
  assert.equal(out[1].query, 'dietary supplement regulation fda oversight');
  assert.equal(out[2].query, 'whole food supplement nutrient bioavailability');
});

test('prose, a fenced answer, or an empty list is no claim at all — never an invented one', () => {
  assert.deepEqual(parseClaims('I could not find any claims.'), []);
  assert.deepEqual(parseClaims('```json\n{"claims":[]}\n```'), []);
  assert.deepEqual(parseClaims('{"claims":[{"claim":"x","query":"y"}]}'), [], 'too short to be a statement');
  assert.deepEqual(parseClaims('{"claims":[{"claim":"A real claim with no query at all here"}]}'), []);
  assert.deepEqual(parseClaims(''), []);
  assert.deepEqual(parseClaims(null), []);
});

test('duplicate claims and queries are kept once', () => {
  const out = parseClaims('{"claims":[{"claim":"Vitamin D accumulates in fat.","query":"vitamin d toxicity"},{"claim":"Vitamin D accumulates in fat.","query":"vitamin d toxicity"}]}');
  assert.equal(out.length, 1);
});

test('a query is at most six search words', () => {
  assert.equal(cleanQuery('one two three four five six seven eight').split(' ').length, 6);
  assert.equal(cleanQuery('a of to'), '');
});

test('the prompt carries the post and asks for JSON only', () => {
  assert.match(claimsPrompt('Fat-soluble vitamins accumulate.'), /Fat-soluble vitamins accumulate\./);
  assert.match(claimsPrompt('x'), /\{"claims":\[/);
});

test('"Verify / fix" asks about each statement before giving up on the post whole', () => {
  const fix = src('lib/post-citation-fix.ts');
  const ladder = fix.slice(fix.indexOf('export async function fixPostCitation'));
  const rung2 = ladder.indexOf('await findBackingByClaims(');
  const subjects = ladder.indexOf('searchSubjectsFor(pack, text)');
  assert.ok(rung2 > -1 && subjects > rung2, 'the statements come before the subject searches');
  const byClaims = fix.slice(fix.indexOf('export async function findBackingByClaims'), fix.indexOf('export async function fixPostCitation'));
  assert.match(byClaims, /extractCheckableClaims\(input\.text\)/);
  assert.match(byClaims, /judgeClaimSupport\(\{ claim: c\.claim, items: candidates \}\)/, 'the papers in hand are judged against each statement');
  assert.match(byClaims, /findEvidence\(c\.query\)/, 'and each statement has its own search');
  // The model call fails open, in the file that talks to the provider.
  const ai = src('lib/ai.ts');
  const call = ai.slice(ai.indexOf('export async function extractCheckableClaims'));
  assert.match(call.slice(0, 3000), /catch \(e\) \{[\s\S]{0,120}return \[\];/);
  assert.match(call.slice(0, 3000), /temperature: 0,/);
});
