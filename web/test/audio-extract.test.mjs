// The audio-extraction step, against real video bytes.
//
// This is the piece that made the whole automation possible: the clinic's
// reels are 76–283 MB and the transcriber refuses anything over 25 MB, so
// every video in the sheet was unreadable until the audio could be lifted out
// on its own. Mocking ffmpeg here would test nothing worth testing, so the
// fixtures are generated with the same binary that runs in production.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import ffmpegStatic from 'ffmpeg-static';
import { extractAudio, sourceExtension, ffmpegAvailable, AUDIO_MAX_BYTES } from '../lib/audio-extract.ts';

const run = promisify(execFile);
let dir;

/** A video, made the way ffmpeg makes them, so the test reads real containers. */
async function makeVideo(name, args) {
  const out = path.join(dir, name);
  await run(ffmpegStatic, ['-nostdin', '-loglevel', 'error', '-y', ...args, out], { maxBuffer: 4 * 1024 * 1024 });
  return out;
}

/** The file as a web stream — the shape Drive's response body arrives in. */
async function bodyOf(file) {
  const bytes = await readFile(file);
  return new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
  });
}

before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'chi-audio-test-')); });
after(async () => { await rm(dir, { recursive: true, force: true }).catch(() => undefined); });

test('ffmpeg ships with the app', () => {
  assert.equal(ffmpegAvailable(), true, 'without the binary every Drive video is untranscribable');
});

test('a spoken .mp4 becomes a small audio file', async () => {
  const video = await makeVideo('reel.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=300',
    '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6000k', '-c:a', 'aac', '-b:a', '256k',
  ]);
  const videoSize = (await stat(video)).size;

  const got = await extractAudio(await bodyOf(video), 'Reel_#4TPExRyall_Rodrigo.mp4');
  assert.equal(got.ok, true, got.ok ? '' : got.message);

  // The point of the whole exercise: what gets uploaded is a fraction of what
  // came down, and comfortably inside the transcriber's ceiling.
  assert.ok(got.audio.sizeBytes < videoSize / 5, `audio ${got.audio.sizeBytes} vs video ${videoSize}`);
  assert.ok(got.audio.sizeBytes < AUDIO_MAX_BYTES);
  assert.ok(got.audio.sizeBytes > 0);
  assert.ok(existsSync(got.audio.path));

  // 16 kHz mono MP3 — what the transcriber works in.
  const probe = await run(ffmpegStatic, ['-nostdin', '-i', got.audio.path, '-f', 'null', '-'], { maxBuffer: 4 * 1024 * 1024 })
    .catch((e) => ({ stderr: String(e.stderr || '') }));
  assert.match(String(probe.stderr), /16000 Hz, mono/);

  await got.audio.release();
  assert.equal(existsSync(got.audio.path), false, 'scratch files must not survive the call');
});

test('a .mov works too — the sheet has both', async () => {
  const video = await makeVideo('clip.mov', [
    '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
  ]);
  const got = await extractAudio(await bodyOf(video), 'Reel 1 andrea julio.mov');
  assert.equal(got.ok, true, got.ok ? '' : got.message);
  assert.ok(got.audio.sizeBytes > 0);
  await got.audio.release();
});

test('a video with no sound is reported as such, not as an error', async () => {
  // B-roll with no voiceover. A person has to write that one, and the sweep
  // needs to say so rather than mark the row failed.
  const video = await makeVideo('silent.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30',
    '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-an',
  ]);
  const got = await extractAudio(await bodyOf(video), 'silent.mp4');
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'no_audio');
});

test('bytes that are not a video fail without leaving anything behind', async () => {
  const before = (await run('sh', ['-c', 'ls -d /tmp/chi-audio-* 2>/dev/null | wc -l'])).stdout.trim();
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('this is not a video')); c.close(); } });
  const got = await extractAudio(body, 'notes.mp4');
  assert.equal(got.ok, false);
  const after = (await run('sh', ['-c', 'ls -d /tmp/chi-audio-* 2>/dev/null | wc -l'])).stdout.trim();
  assert.equal(after, before, 'a failed extraction must clean up its scratch directory');
});

test('the source keeps an extension ffmpeg can demux from', () => {
  assert.equal(sourceExtension('Reel_#4TPExRyall_Rodrigo.mp4'), '.mp4');
  assert.equal(sourceExtension('Reel 1 andrea julio.mov'), '.mov');
  assert.equal(sourceExtension('Reel 2 andrea julio.mov.mov'), '.mov');
  // Unknown or absent: assume mp4, which is what the sheet is full of.
  assert.equal(sourceExtension('Reel_PEMF'), '.mp4');
  assert.equal(sourceExtension(''), '.mp4');
});
