import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claimIsStale, isCandidate, keywordLineFrom, rowKeyFor, STATUS_TEXT } from './video-row.ts';

const DRIVE = 'https://drive.google.com/file/d/1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N/view?usp=drive_link';

test('a Drive link with no copy is work to do', () => {
  assert.equal(isCandidate({ videoLink: DRIVE, copy: '' }), true);
  assert.equal(isCandidate({ videoLink: 'https://youtu.be/dQw4w9WgXcQ', copy: '' }), true);
});

test('copy a person already wrote is never touched', () => {
  // The single most important rule in the sweep: the sheet has hundreds of
  // rows of existing work, and turning this on must not put any of it at risk.
  assert.equal(isCandidate({ videoLink: DRIVE, copy: 'Because plasma carries a variety of circulating proteins…' }), false);
  assert.equal(isCandidate({ videoLink: DRIVE, copy: '   ' }), true, 'whitespace is not copy');
});

test('a row with no usable link is skipped', () => {
  assert.equal(isCandidate({ videoLink: '', copy: '' }), false);
  assert.equal(isCandidate({ videoLink: 'Unlisted', copy: '' }), false);
  assert.equal(isCandidate({ videoLink: 'https://vimeo.com/123456', copy: '' }), false);
});

test('a row is identified by its link, not its position', () => {
  const a = rowKeyFor('Reel_#4TPExRyall_Rodrigo.mp4', DRIVE);
  // The same video, retitled and moved down the tab, is still the same video.
  assert.equal(rowKeyFor('Reel_TPE_final.mp4', DRIVE), a);
  // A different video is not.
  assert.notEqual(rowKeyFor('Reel_#4TPExRyall_Rodrigo.mp4', DRIVE.replace('1s0d', '9z9z')), a);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('a row with no link at all falls back to its file name', () => {
  assert.equal(rowKeyFor('Reel_PEMFxRyall_Rodrigo.mp4', ''), rowKeyFor('reel_pemfxryall_rodrigo.mp4', ''));
  assert.notEqual(rowKeyFor('Reel_A.mp4', ''), rowKeyFor('Reel_B.mp4', ''));
});

test('the keyword brief reads as one cell, primary first', () => {
  assert.equal(
    keywordLineFrom({ primary: 'therapeutic plasma exchange', keywords: ['therapeutic plasma exchange', 'TPE therapy', 'plasmapheresis'] }),
    'therapeutic plasma exchange · TPE therapy, plasmapheresis',
  );
  assert.equal(keywordLineFrom({ primary: 'molecular hydrogen', keywords: [] }), 'molecular hydrogen');
  assert.equal(keywordLineFrom({ primary: null, keywords: ['hyperbaric oxygen'] }), 'hyperbaric oxygen');
  // Nothing to say is an empty cell, never the word "null".
  assert.equal(keywordLineFrom(null), '');
  assert.equal(keywordLineFrom({ primary: '', keywords: [] }), '');
});

test('the sheet status column speaks the sheet’s language', () => {
  assert.equal(STATUS_TEXT.prepared, 'Listo para revisión');
  assert.equal(STATUS_TEXT.needs_transcript, 'Falta transcripción');
});

test('a row another sweep is working on right now is left alone', () => {
  const now = Date.parse('2026-09-08T12:00:00Z');
  const fresh = new Date(now - 30_000).toISOString();
  assert.equal(claimIsStale(fresh, now), false, 'claimed 30s ago — still running');

  const abandoned = new Date(now - 45 * 60_000).toISOString();
  assert.equal(claimIsStale(abandoned, now), true, 'claimed 45m ago — the request died');

  // A row with no timestamp at all must be retryable, not locked out forever.
  assert.equal(claimIsStale(null, now), true);
  assert.equal(claimIsStale('not a date', now), true);
});
