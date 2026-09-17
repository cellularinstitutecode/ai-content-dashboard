import test from 'node:test';
import assert from 'node:assert/strict';
import { TIKTOK_TITLE_MAX, tiktokDataFor, tiktokTitleFrom } from './tiktok-meta.ts';

test('the preset is public with comments, duet and stitch on, and no paid-partnership flag', () => {
  const d = tiktokDataFor({ title: 'Reel_RyallCellgenicScript16_Rodrigo', body: 'Quality in regenerative medicine…' }, {});
  assert.equal(d.privacyOption, 'PUBLIC_TO_EVERYONE');
  assert.equal(d.disableComment, false);
  assert.equal(d.disableDuet, false);
  assert.equal(d.disableStitch, false);
  assert.equal(d.commercialContentOwnBrand, false);
  assert.equal(d.commercialContentThirdParty, false);
  // The FILENAME is not the title. This used to assert the raw Drive name went
  // through untouched, which is exactly what put "Reel_..._Rodrigo" on the
  // clinic's TikTok. See lib/video-title.ts.
  assert.equal(d.title, 'Cellgenic Script at Cellular Institute');
});

test('the own-brand disclosure is an explicit setting, not a default', () => {
  assert.equal(tiktokDataFor({ body: 'x' }, { TIKTOK_COMMERCIAL_OWN_BRAND: 'on' }).commercialContentOwnBrand, true);
  assert.equal(tiktokDataFor({ body: 'x' }, { TIKTOK_COMMERCIAL_OWN_BRAND: 'off' }).commercialContentOwnBrand, false);
});

test('the title falls back to the caption’s first line and stays within the limit', () => {
  assert.equal(tiktokTitleFrom(null, '\n  First line here.\nSecond line'), 'First line here.');
  const long = 'word '.repeat(60).trim();
  const t = tiktokTitleFrom(long);
  assert.ok(t.length <= TIKTOK_TITLE_MAX);
  assert.ok(!t.endsWith(' '));
  assert.equal(tiktokDataFor({}, {}).title, undefined);
});
