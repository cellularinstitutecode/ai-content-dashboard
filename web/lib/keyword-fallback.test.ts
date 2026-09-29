import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { derivedKeywords, fallbackBriefPrompt, fallbackStamp, hasKeywords, keywordSourceNote, parseKeywords } from './keyword-fallback.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('the model’s keywords are read, cleaned and capped; shopping shapes are dropped', () => {
  const out = parseKeywords('{"primary":"Hyperbaric oxygen therapy","keywords":["HBOT benefits","hyperbaric oxygen near me","#hbot","oxygen therapy recovery","Hyperbaric oxygen therapy","a","b c","d e","f g","h i","j k","l m"]}');
  assert.equal(out.primary, 'hyperbaric oxygen therapy');
  assert.ok(!out.keywords.includes('hyperbaric oxygen near me'));
  assert.ok(out.keywords.includes('hbot'), 'the hash is stripped, the term kept');
  assert.equal(new Set(out.keywords).size, out.keywords.length, 'no duplicates');
  assert.ok(out.keywords.length <= 8);
  assert.deepEqual(parseKeywords('I cannot help with that.'), { primary: null, keywords: [] });
  assert.deepEqual(parseKeywords(''), { primary: null, keywords: [] });
});

test('the last rung takes the terms from the subject and what was said', () => {
  const out = derivedKeywords('Reel_OxygenCircuit_Rodrigo', 'Today we walk through the oxygen circuit: hyperbaric oxygen first, then the oxygen chamber, then red light. Oxygen, oxygen, oxygen.');
  assert.ok(out.primary, 'a primary phrase from the subject');
  assert.ok(out.keywords.includes('oxygen'), 'the word the speaker keeps coming back to');
  assert.ok(!out.keywords.includes('rodrigo'), 'file-name furniture never becomes a keyword');
  assert.ok(out.keywords.length >= 2);
  // A subject with nothing in it gives nothing — never an invented phrase.
  assert.deepEqual(derivedKeywords('', ''), { primary: null, keywords: [] });
});

test('a stamp says where its keywords came from, and none means none', () => {
  const s = fallbackStamp('model', { primary: 'stem cell therapy', keywords: ['stem cell therapy', 'regenerative medicine'] }, 'budget');
  assert.equal(s.source, 'model');
  assert.equal(s.volume, null);
  assert.equal(hasKeywords(s), true);
  assert.equal(fallbackStamp('derived', { primary: null, keywords: [] }).source, 'none');
  assert.equal(hasKeywords({ keywords: [] }), false);
  assert.equal(hasKeywords(null), false);
});

test('the fallback brief keeps the contract: in the body, never leading, never stuffed', () => {
  const p = fallbackBriefPrompt({ source: 'derived', primary: 'oxygen circuit', keywords: ['oxygen circuit', 'hyperbaric oxygen'] });
  assert.match(p, /no live search data/);
  assert.match(p, /PRIMARY keyword: oxygen circuit/);
  assert.match(p, /opening line is NOT the keyword/);
  assert.match(p, /SUPPORTING terms .*hyperbaric oxygen/);
  assert.match(p, /Never keyword-stuff/);
  assert.equal(fallbackBriefPrompt({ source: 'semrush', primary: 'x', keywords: ['x'] }), '', 'Semrush has its own brief');
  assert.equal(fallbackBriefPrompt({ source: 'none', primary: null, keywords: [] }), '');
});

test('the note beside a draft names the source', () => {
  assert.match(keywordSourceNote({ source: 'model', keywords: ['a', 'b'] }), /estimated.*: a, b/);
  assert.match(keywordSourceNote({ source: 'derived', keywords: ['a'] }), /taken from the subject/);
  assert.equal(keywordSourceNote({ source: 'semrush', keywords: ['a'] }), '');
  assert.match(keywordSourceNote({ source: 'none', keywords: [] }), /without keyword data/);
});

test('nothing is written without keywords: every drafting path climbs the ladder', () => {
  const ai = src('lib/ai.ts');
  const gen = ai.slice(ai.indexOf('export async function generateContentPack'));
  assert.match(gen, /await keywordLadder\(/, 'the generator researches through the ladder, not Semrush alone');
  assert.match(gen, /throw new NoKeywordsError\(/, 'and refuses to write when even the ladder has nothing');
  const ladder = ai.slice(ai.indexOf('export async function keywordLadder'), ai.indexOf('export async function generateContentPack'));
  for (const rung of ['autoKeywordBrief(', 'suggestKeywords(', 'derivedKeywords(']) assert.match(ladder, new RegExp(rung.replace('(', '\\(')), 'rung: ' + rung);
  // Semrush itself falls back to an expired cache entry before giving up.
  assert.match(src('lib/semrush.ts'), /STALE_TTL_MS/);
  // The video pipeline and the Autopilot hand their stamp to the writer, so the pack carries it.
  assert.match(src('lib/video-prepare.ts'), /keywordStamp: brief\.stamp/);
  assert.match(src('lib/autopilot.ts'), /keywordStamp/);
  // And the sheet tells estimated keywords from none.
  assert.match(src('lib/video-row.ts'), /estimated_keywords/);
});

test('no post goes out without keywords: every door backfills them', () => {
  for (const p of ['app/api/posts/route.ts', 'app/api/metricool/schedule/route.ts', 'lib/video-publish.ts', 'lib/autopilot.ts']) {
    assert.match(src(p), /ensureKeywords\(/, p);
  }
  const guard = src('lib/keyword-guard.ts');
  assert.match(guard, /skipSemrush: true/, 'a door never spends Semrush units');
  assert.match(guard, /catch \(err\) \{[\s\S]{0,200}return unchanged;/, 'fails open');
});
