import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDriveFileId, isDriveUrl } from './drive-url.ts';

// The exact links in Rodrigo's sheet — the Share button's output.
const SHEET_LINKS: [string, string][] = [
  ['https://drive.google.com/file/d/1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N/view?usp=drive_link', '1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N'],
  ['https://drive.google.com/file/d/1BKpgbYVBrk6txwRPp_GT2lFYy8htyHrz/view?usp=drive_link', '1BKpgbYVBrk6txwRPp_GT2lFYy8htyHrz'],
  ['https://drive.google.com/file/d/1oAlBmGpaKgb9ZokKtPW_LNftr_tCagrs/view?usp=drive_link', '1oAlBmGpaKgb9ZokKtPW_LNftr_tCagrs'],
];

for (const [url, id] of SHEET_LINKS) {
  test('reads the id out of ' + url.slice(0, 48) + '…', () => {
    assert.equal(parseDriveFileId(url), id);
  });
}

test('the other shapes a person can paste', () => {
  assert.equal(parseDriveFileId('https://drive.google.com/open?id=1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N'), '1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N');
  assert.equal(parseDriveFileId('https://drive.google.com/uc?id=1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N&export=download'), '1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N');
  // No scheme, as pasted out of a browser bar.
  assert.equal(parseDriveFileId('drive.google.com/file/d/1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N/view'), '1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N');
});

test('anything that is not a Drive file is not one', () => {
  // A YouTube link goes down the caption path instead, so this MUST be null —
  // reading it as a Drive id would send a video to the transcriber that has
  // free, exact captions waiting for it.
  assert.equal(parseDriveFileId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseDriveFileId('https://drive.google.com/drive/folders/1zQdyCBQ'), null);
  assert.equal(parseDriveFileId('not a link'), null);
  assert.equal(parseDriveFileId(''), null);
  // A lookalike host must not be trusted.
  assert.equal(parseDriveFileId('https://drive.google.com.evil.test/file/d/1s0d6e44yh6hNObVAzbdkBRclx_Pe8g7N/view'), null);
  assert.equal(isDriveUrl('https://vimeo.com/123456'), false);
});
