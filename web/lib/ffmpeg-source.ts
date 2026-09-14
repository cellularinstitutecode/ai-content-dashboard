// web/lib/ffmpeg-source.ts
// Where the ffmpeg binary comes from when the deployment does not carry it.
//
// THE PROBLEM. ffmpeg is a 77 MB static binary, and Next's file tracing put a
// copy of it into every function whose import graph touched lib/audio-extract
// — six of them. Vercel stores every function of every deployment it keeps,
// so each push cost ~500 MB of "Function Storage" and the free allowance
// (10 GB) filled up in a few weeks. Nothing about the videos, the drafts or
// the bucket: a build-output problem.
//
// So the binary is no longer shipped (next.config.mjs excludes it from every
// function). Instead it is fetched ONCE per warm instance, on first use, from
// the same GitHub release asset the ffmpeg-static package installs from —
// pinned by release tag and SHA-256, so what runs in production is
// byte-for-byte the file the tests run against — and cached in /tmp.
//
// This module is the pure part: the URL, the pin, and the verdict on a
// download. The fetch itself lives in lib/audio-extract.ts. No imports, so
// the test runner strips types and runs this file directly.

/** The ffmpeg-static release the pinned asset belongs to (its package manifest's `binary-release-tag`). */
export const FFMPEG_RELEASE_TAG = 'b6.1.1';

/**
 * The Linux x64 asset of that release — the file `ffmpeg-static`'s installer
 * downloads on the build machine. ffmpeg 7.0.2, johnvansickle static build.
 */
export const FFMPEG_ASSET_URL =
  'https://github.com/eugeneware/ffmpeg-static/releases/download/' + FFMPEG_RELEASE_TAG + '/ffmpeg-linux-x64';

/** SHA-256 of that asset, computed from the binary the package installed here. */
export const FFMPEG_ASSET_SHA256 = 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99';

/** Its size, as a sanity floor: anything much smaller is an error page, not ffmpeg. */
export const FFMPEG_ASSET_BYTES = 79_826_272;

export type FfmpegSource = { url: string; sha256: string };

/**
 * The URL and hash to fetch, honouring the two overrides.
 *
 * FFMPEG_DOWNLOAD_URL lets the clinic host its own copy (Supabase Storage,
 * say) without a code change; FFMPEG_SHA256 is its hash. An override URL
 * WITHOUT a hash keeps the pinned hash — right when it is a mirror of the
 * same file, and a loud, immediate refusal when it is not, which is the
 * safer failure. A malformed hash is ignored rather than trusted.
 */
export function ffmpegSource(env: Record<string, string | undefined> = {}): FfmpegSource {
  const url = String(env.FFMPEG_DOWNLOAD_URL || '').trim() || FFMPEG_ASSET_URL;
  const raw = String(env.FFMPEG_SHA256 || '').trim().toLowerCase();
  const sha256 = /^[0-9a-f]{64}$/.test(raw) ? raw : FFMPEG_ASSET_SHA256;
  return { url, sha256 };
}

export type DownloadVerdict =
  | { ok: true }
  | { ok: false; reason: 'empty' | 'too_small' | 'hash_mismatch'; detail: string };

/**
 * Is what came down the wire the binary we asked for?
 *
 * The hash is the real check; the size floor only gives a better sentence
 * when a CDN answered with an HTML error page and a 200.
 */
export function downloadVerdict(input: { bytes: number; sha256: string; expected: string }): DownloadVerdict {
  if (!(input.bytes > 0)) return { ok: false, reason: 'empty', detail: 'the download was empty' };
  if (input.bytes < 1024 * 1024) {
    return { ok: false, reason: 'too_small', detail: 'the download was ' + input.bytes + ' bytes — an error page, not a binary' };
  }
  const got = String(input.sha256 || '').toLowerCase();
  const want = String(input.expected || '').toLowerCase();
  if (got !== want) {
    return {
      ok: false,
      reason: 'hash_mismatch',
      detail: 'the download did not match the pinned SHA-256 (got ' + got.slice(0, 12) + '…, expected ' + want.slice(0, 12) + '…)',
    };
  }
  return { ok: true };
}

/**
 * The file name the verified binary is cached under.
 *
 * Carries the hash so a changed pin (or a changed override) never reuses a
 * stale binary from a previous deployment on a reused instance, and so a
 * test with a fake pin can never collide with a real one.
 */
export function cachedBinaryName(sha256: string): string {
  return 'ffmpeg-' + String(sha256 || '').toLowerCase().slice(0, 16);
}
