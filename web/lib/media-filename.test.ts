import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filenameFor } from './media-filename.ts';

// The transcription endpoint decides how to demux from the FILENAME, and
// rejects a file whose name has no extension it recognises. Rodrigo's files
// are named "Reel_#4TPExRyall_Rodrigo.mp4" — a '#' in a multipart filename is
// exactly the sort of thing that comes back as an unhelpful 400.
test('keeps a usable name, minus the characters that upset a multipart upload', () => {
  assert.equal(filenameFor('Reel_#4TPExRyall_Rodrigo.mp4', 'video/mp4'), 'Reel__4TPExRyall_Rodrigo.mp4');
  assert.equal(filenameFor('Reel_MolecularHydrogenRyall_Rodrigo.mp4', 'video/mp4'), 'Reel_MolecularHydrogenRyall_Rodrigo.mp4');
});

test('adds the extension the content type implies when the name has none', () => {
  assert.equal(filenameFor('Reel PEMF', 'video/mp4'), 'Reel_PEMF.mp4');
  assert.equal(filenameFor('interview', 'video/quicktime'), 'interview.mov');
  assert.equal(filenameFor('voice note', 'audio/mpeg'), 'voice_note.mp3');
});

test('never produces an empty or extensionless name', () => {
  assert.equal(filenameFor('', 'video/mp4'), 'video.mp4');
  assert.equal(filenameFor('###', 'video/mp4'), '_.mp4');
  // An unknown container still gets a name the endpoint will attempt.
  assert.match(filenameFor('clip', 'application/octet-stream'), /\.mp4$/);
});
