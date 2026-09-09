import { test } from 'node:test';
import assert from 'node:assert/strict';

import { claimIsStale, firstLinkIn, fitsNetwork, isCandidate, keywordLineFrom, preparedStatus, rowKeyFor, STATUS_TEXT } from './video-row.ts';

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

test('a link cell that carries a note around the link still works', () => {
  const bare = 'https://drive.google.com/file/d/1s0d6e44yh6hNObVAzbdkBRcIx_Pe8g7N/view?usp=drive_link';
  assert.equal(firstLinkIn(bare), bare);

  // Both shapes are in the real sheet today.
  assert.equal(
    firstLinkIn('SUBS: https://drive.google.com/file/d/1PhDkCeCABiEJaIgN1T8bX5x3KOJiUtLM/view?usp=sharing NO SUBS: https://drive.google.com/file/d/12UPPGgaUiMshAr1ruRUAyOXRSUYfZ9xr/view?usp=sharing'),
    'https://drive.google.com/file/d/1PhDkCeCABiEJaIgN1T8bX5x3KOJiUtLM/view?usp=sharing',
  );
  assert.equal(
    firstLinkIn('1. https://drive.google.com/file/d/1-eCk231FQx1CnmgD6hpfI5vD2WTrvrXh/view?usp=drive_link 2. https://drive.google.com/file/d/1blfHsFULM3vFYdxhR3p-6J6DbOR-HXF8/view?usp=drive_link'),
    'https://drive.google.com/file/d/1-eCk231FQx1CnmgD6hpfI5vD2WTrvrXh/view?usp=drive_link',
  );

  assert.equal(firstLinkIn('Unlisted'), '');
  assert.equal(firstLinkIn(''), '');

  // And such a row is now work to do, rather than silently ineligible.
  assert.equal(isCandidate({ videoLink: 'SUBS: ' + bare, copy: '' }), true);
});

test('a row written without keyword data does not look finished', () => {
  // The failure this exists to catch: Semrush out of units, copy still gets
  // written, and the row reads exactly like one the keyword brief shaped. The
  // one thing this automation adds would stop happening, invisibly.
  assert.equal(preparedStatus({ hasKeywords: true, overLength: false }), 'Listo para revisión');
  assert.equal(preparedStatus({ hasKeywords: false, overLength: false }), 'Listo — SIN keywords');
});

test('copy too long for its network is flagged, not quietly sent', () => {
  assert.equal(preparedStatus({ hasKeywords: true, overLength: true }), 'Listo — copy muy larga, acortar');
  // Length beats keywords: it is the one that stops a post going out at all.
  assert.equal(preparedStatus({ hasKeywords: false, overLength: true }), 'Listo — copy muy larga, acortar');
});

test('each network is measured against its own limit', () => {
  const long = 'x'.repeat(2500);
  assert.equal(fitsNetwork('linkedin', long).ok, true, 'LinkedIn takes 3000');
  assert.equal(fitsNetwork('tiktok', long).ok, false, 'TikTok stops at 2200');
  assert.equal(fitsNetwork('instagram', long).ok, false);
  assert.equal(fitsNetwork('twitter', 'x'.repeat(300)).ok, false);

  const r = fitsNetwork('tiktok', long);
  assert.equal(r.limit, 2200);
  assert.equal(r.length, 2500);

  // A network with no known limit must not be treated as zero.
  assert.equal(fitsNetwork('threads', long).ok, true);
});
