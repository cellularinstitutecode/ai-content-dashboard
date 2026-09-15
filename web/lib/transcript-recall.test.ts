import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_RECALL_CHARS, transcriptFromPacks } from './transcript-recall.ts';

const long = 'A torn rotator cuff always needs surgery eventually — that is what most patients hear the moment imaging shows a tear.';

test('the newest pack with a real transcript wins', () => {
  const got = transcriptFromPacks([
    { transcript: long + ' Newest.', transcriptLanguage: 'en', title: 'Shoulder 2' },
    { transcript: long + ' Older.' },
  ]);
  assert.deepEqual(got, { text: long + ' Newest.', language: 'en', title: 'Shoulder 2' });
});

test('a pack queued from the sheet copy (no transcript) is passed over for an older one that has it', () => {
  const got = transcriptFromPacks([
    { transcript: '', title: 'Queued from the sheet' },
    { transcript: '   ' },
    { transcript: long, transcriptLanguage: '', title: '' },
  ]);
  assert.equal(got?.text, long);
  assert.equal(got?.language, null);
  assert.equal(got?.title, null);
});

test('a few words are not a transcript', () => {
  assert.equal(transcriptFromPacks([{ transcript: 'x'.repeat(MIN_RECALL_CHARS - 1) }]), null);
  assert.equal(transcriptFromPacks([{ transcript: 'x'.repeat(MIN_RECALL_CHARS) }])?.text, 'x'.repeat(MIN_RECALL_CHARS));
});

test('nothing usable, nothing returned — and odd input never throws', () => {
  assert.equal(transcriptFromPacks([]), null);
  assert.equal(transcriptFromPacks([null, undefined, {}, { transcript: 42 }]), null);
});
