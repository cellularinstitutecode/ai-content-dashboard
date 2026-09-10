// Unit tests for the attachment preview mapping. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drivePreviewUrl, looksLikeImage, previewKindOf } from './media-preview.ts';

// The stored media URL is Drive's webContentLink. It downloads; it does not play.
test('a Drive download link maps to a player that actually plays', () => {
  const id = '1VdYNpu63QCWjwm1d6aliP0PkGlG2jDNj';
  assert.equal(
    drivePreviewUrl('https://drive.google.com/uc?export=download&id=' + id),
    'https://drive.google.com/file/d/' + id + '/preview',
  );
  assert.equal(
    drivePreviewUrl('https://drive.google.com/file/d/' + id + '/view?usp=drive_link'),
    'https://drive.google.com/file/d/' + id + '/preview',
  );
});

test('anything that is not a Drive file has no Drive player', () => {
  assert.equal(drivePreviewUrl('https://cdn.example.com/clip.mp4'), '');
  assert.equal(drivePreviewUrl(''), '');
  assert.equal(drivePreviewUrl(null), '');
});

test('images are told apart from videos by label first, then extension', () => {
  assert.equal(looksLikeImage('https://x/y', 'AI hero image'), true);
  assert.equal(looksLikeImage('https://x/photo.PNG', ''), true);
  assert.equal(looksLikeImage('https://x/clip.mp4', 'Reel'), false);
});

test('previewKindOf picks the element that will actually render', () => {
  const drive = 'https://drive.google.com/uc?export=download&id=1VdYNpu63QCWjwm1d6aliP0PkGlG2jDNj';
  // A Drive video needs the iframe player: a <video src> on this URL is a
  // black box, because Drive answers it with Content-Disposition: attachment.
  assert.equal(previewKindOf(drive, 'Reel'), 'drive');
  // An Opus clip is a direct file a <video> tag plays on its own.
  assert.equal(previewKindOf('https://cdn.example.com/clip.mp4', 'Clip video'), 'video');
  assert.equal(previewKindOf('https://x/hero.jpg', 'AI hero image'), 'image');
  assert.equal(previewKindOf('', ''), 'none');
});
