// Unit tests for the attachment preview mapping. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('the Drive player is a DIFFERENT url from the one Metricool is given', () => {
  // The distinction that cost an afternoon. drivePreviewUrl points at Drive's
  // streaming player, which needs Drive to have transcoded the file; Metricool
  // is handed the DOWNLOAD url, which serves the bytes regardless. A freshly
  // copied 149 MB reel therefore shows "This video file is still being
  // processed for playback" in the preview while being perfectly attached.
  const download = 'https://drive.usercontent.google.com/download?id=1AbC_dEfGhIjKlMnOpQrStUvWxYz012345&export=download&confirm=t';
  const player = drivePreviewUrl(download);
  assert.equal(player, 'https://drive.google.com/file/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz012345/preview');
  assert.notEqual(player, download, 'if these were the same url the caption below would be true');
  // Both shapes of download link map to the same player.
  assert.equal(drivePreviewUrl('https://drive.google.com/uc?export=download&id=1AbC_dEfGhIjKlMnOpQrStUvWxYz012345'), player);
});

test('the composer no longer reads a Drive transcode as a missing video', () => {
  // Source check: MediaPicker is a React component. The old caption said "if it
  // plays here, it is attached", which for a Drive video is the opposite of the
  // truth — the preview was built because a MISSING video looked fine, and it
  // had started making a FINE video look missing.
  const picker = readFileSync(new URL('../components/MediaPicker.tsx', import.meta.url), 'utf8');
  assert.match(picker, /kind === 'drive'/, 'the caption must depend on which player is shown');
  assert.match(picker, /still being processed/, 'and name the exact words Drive shows');
  assert.match(picker, /does not wait for it/);
  // The plain-video and image cases keep the original promise, which is true
  // for them: those really are the file itself in the element.
  assert.match(picker, /This is exactly what goes out with the post\. If it plays here, it is attached\./);
});
