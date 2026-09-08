// A video's own words are the basis of everything the Video Library writes,
// so the track choice and the text assembly are pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickTrack, eventsToText } from './youtube-captions.ts';

test('a human English track beats auto-generated ones; Spanish is next; auto is the fallback', () => {
  const asrEn = { baseUrl: 'a', languageCode: 'en', kind: 'asr' };
  const es = { baseUrl: 'b', languageCode: 'es' };
  const en = { baseUrl: 'c', languageCode: 'en-US' };
  const fr = { baseUrl: 'd', languageCode: 'fr' };
  assert.equal(pickTrack([asrEn, es, en])?.baseUrl, 'c');
  assert.equal(pickTrack([asrEn, es])?.baseUrl, 'b');
  assert.equal(pickTrack([asrEn, fr])?.baseUrl, 'd'); // any human track before an auto one
  assert.equal(pickTrack([asrEn])?.baseUrl, 'a');
  assert.equal(pickTrack([]), null);
});

test('json3 events become one clean text', () => {
  const json = { events: [
    { segs: [{ utf8: 'Welcome to ' }, { utf8: 'Cellular Institute' }] },
    { segs: [{ utf8: '\n' }] },
    { segs: [{ utf8: ' .' }] },
    { segs: [{ utf8: 'Today we talk about   exosomes' }] },
  ] };
  assert.equal(eventsToText(json), 'Welcome to Cellular Institute. Today we talk about exosomes');
  assert.equal(eventsToText(null), '');
});
