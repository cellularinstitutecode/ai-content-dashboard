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
import { createServer } from 'node:http';

import { extractAudio, extractAudioFromUrl, stripToken, FFMPEG_URL_ARGS, sourceExtension, ffmpegAvailable, ffmpegBinary, resetFfmpegBinary, AUDIO_MAX_BYTES } from '../lib/audio-extract.ts';

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

test('a binary stripped of its execute bit is still usable', async () => {
  // Exactly what a Vercel deployment does to the traced ffmpeg: the file is
  // there, the execute bit is not, and the app directory is read-only. spawn
  // then fails with EACCES before ffmpeg starts, so there is no ffmpeg stderr
  // and the failure reads as "the audio could not be read" with nothing after
  // it — which is precisely how this shipped broken.
  const stripped = path.join(dir, 'ffmpeg-noexec');
  await run('cp', [ffmpegStatic, stripped]);
  await run('chmod', ['444', stripped]);

  const before = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = stripped;
  resetFfmpegBinary();
  try {
    const resolved = await ffmpegBinary();
    assert.ok(resolved, 'must resolve to something runnable');
    assert.notEqual(resolved, stripped, 'must not hand back the unrunnable path');

    const video = await makeVideo('perm.mp4', [
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    ]);
    const got = await extractAudio(await bodyOf(video), 'perm.mp4');
    assert.equal(got.ok, true, got.ok ? '' : got.message);
    await got.audio.release();
  } finally {
    if (before === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = before;
    resetFfmpegBinary();
  }
});

test('a failure that produced no stderr says why anyway', async () => {
  // The message that cost a deployment's worth of guessing: ffmpeg never
  // started, so stderr was empty, so the reason was simply omitted.
  const before = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = path.join(dir, 'does-not-exist');
  resetFfmpegBinary();
  // The previous test left a working copy in /tmp, and a warm instance is
  // SUPPOSED to reuse it — so it has to go for this case to be reachable.
  await rm(path.join(tmpdir(), 'ffmpeg-static-bin'), { force: true });
  try {
    const got = await extractAudio(await bodyOf(path.join(dir, 'perm.mp4')), 'perm.mp4');
    assert.equal(got.ok, false);
    assert.match(got.message, /not runnable|could not be started/i);
  } finally {
    if (before === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = before;
    resetFfmpegBinary();
  }
});


// ---------------------------------------------------------------------------
// Reading the source over HTTP instead of staging it.
//
// The path that removes the size ceiling. It is only ever taken by files too
// big to fit the function's 512 MB scratch disk, so it cannot be exercised with
// a real one here — but everything that makes it RISKY is reproducible at any
// size: the auth header, the redirect, and above all whether ffmpeg can seek
// backwards to find an index that is not at the front of the file.
// ---------------------------------------------------------------------------

const TOKEN = 'ya29.test-token-not-a-real-credential';

/** Drive, reduced to the three behaviours that matter: auth, redirect, ranges. */
async function serveFile(file, { redirectFirst = false } = {}) {
  const bytes = await readFile(file);
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + TOKEN) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    if (redirectFirst && !req.url.startsWith('/storage')) {
      res.writeHead(302, { location: '/storage' }).end();
      return;
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : bytes.length - 1;
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-length': String(end - start + 1),
        'content-range': 'bytes ' + start + '-' + end + '/' + bytes.length,
        'accept-ranges': 'bytes',
      }).end(bytes.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': String(bytes.length),
      'accept-ranges': 'bytes',
    }).end(bytes);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/file';
  return { url, close: () => new Promise((r) => server.close(r)) };
}

test('the credential never appears in anything that leaves the function', () => {
  // ffmpeg echoes its input, and sometimes its headers, into stderr on failure.
  // lib/report.ts's redact() does not know the shape of a Google access token,
  // so this is the guard that does.
  assert.equal(stripToken('opening http://x/?a=1 with Bearer ' + TOKEN + ' failed', TOKEN),
    'opening http://x/?a=1 with Bearer [token] failed');
  assert.equal(stripToken('nothing sensitive here', TOKEN), 'nothing sensitive here');
  assert.equal(stripToken('text', ''), 'text', 'an empty token must not blank the message');

  // And the header really is CRLF-terminated: without it ffmpeg runs the next
  // header onto this line and Drive rejects the request.
  const args = FFMPEG_URL_ARGS('http://example/f', TOKEN, '/tmp/out.mp3');
  const header = args[args.indexOf('-headers') + 1];
  assert.equal(header, 'Authorization: Bearer ' + TOKEN + '\r\n');
  assert.equal(args[args.indexOf('-seekable') + 1], '1');
});

test('audio is lifted straight off a URL, through a redirect, with auth', async () => {
  const video = await makeVideo('over-http.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
  ]);
  const server = await serveFile(video, { redirectFirst: true });
  try {
    const got = await extractAudioFromUrl(server.url, TOKEN, { timeoutMs: 60_000 });
    assert.equal(got.ok, true, got.ok ? '' : got.message);
    assert.ok(got.audio.sizeBytes > 0);
    await got.audio.release();
    assert.equal(existsSync(got.audio.path), false, 'only the audio is written, and it is cleaned up');
  } finally {
    await server.close();
  }
});

/** Where the MP4 index sits. 'end' is the one that forces a backwards seek. */
async function moovPosition(file) {
  const bytes = await readFile(file);
  const moov = bytes.indexOf(Buffer.from('moov'));
  const mdat = bytes.indexOf(Buffer.from('mdat'));
  assert.ok(moov > 0 && mdat > 0, 'not an MP4 this check understands');
  return moov < mdat ? 'front' : 'end';
}

test('an MP4 whose index sits at the END still works — the whole risk of this path', async () => {
  // Exports without faststart keep the moov atom AFTER the media data, so
  // ffmpeg must range-request backwards to find it. Anything that can only read
  // forwards — piping the download into ffmpeg's stdin, say — fails on exactly
  // these files, which is why this path reads a URL rather than a pipe.
  //
  // The position is asserted rather than assumed: a test that believes it is
  // exercising a backwards seek while the index sits at the front proves
  // nothing, and ffmpeg's default for mp4 is not obvious from the arguments.
  const video = await makeVideo('moov-at-end.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
  ]);
  assert.equal(await moovPosition(video), 'end', 'this fixture must be the hard case');

  const server = await serveFile(video);
  try {
    const got = await extractAudioFromUrl(server.url, TOKEN, { timeoutMs: 60_000 });
    assert.equal(got.ok, true, got.ok ? '' : got.message);
    assert.ok(got.audio.sizeBytes > 0);
    await got.audio.release();
  } finally {
    await server.close();
  }
});

test('and a faststart export, where the index is at the front, works too', async () => {
  const video = await makeVideo('moov-at-front.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
    '-movflags', '+faststart',
  ]);
  assert.equal(await moovPosition(video), 'front');

  const server = await serveFile(video);
  try {
    const got = await extractAudioFromUrl(server.url, TOKEN, { timeoutMs: 60_000 });
    assert.equal(got.ok, true, got.ok ? '' : got.message);
    await got.audio.release();
  } finally {
    await server.close();
  }
});

test('a wrong credential fails as a failure, not as a video with no sound', async () => {
  const video = await makeVideo('auth.mp4', [
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
  ]);
  const server = await serveFile(video);
  try {
    const got = await extractAudioFromUrl(server.url, 'wrong-token', { timeoutMs: 30_000 });
    assert.equal(got.ok, false);
    assert.notEqual(got.reason, 'no_audio', '401 must not be reported as a silent clip');
    assert.ok(!/wrong-token/.test(got.message), 'the credential must not come back in the message');
  } finally {
    await server.close();
  }
});
