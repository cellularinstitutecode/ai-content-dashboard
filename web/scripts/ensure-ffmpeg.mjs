// web/scripts/ensure-ffmpeg.mjs
// Make sure the ffmpeg binary is actually present before the app is built.
//
// ffmpeg-static does not ship the binary in its tarball — its `files` list is
// just the JS — and fetches it in an `install` script instead. A build that
// skips lifecycle scripts, or whose network refuses the download, therefore
// installs the package perfectly and leaves `require('ffmpeg-static')`
// pointing at a path with nothing behind it. Next's file tracing cannot
// include a file that does not exist, so the deployment comes up with no
// extractor and the first person to press Prepare finds out.
//
// Runs as `prebuild`, so it happens on every deploy. It re-runs the package's
// own installer rather than reimplementing the download, and it is LOUD when
// it cannot: the build still succeeds, because transcription is one feature
// and the rest of the dashboard should not be held hostage to it, but
// /api/health reports the extractor as unavailable so nobody has to guess.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';

const require = createRequire(import.meta.url);

/** A real ffmpeg build is tens of megabytes; anything tiny is a stub or a truncated download. */
const MIN_BYTES = 1024 * 1024;

function sizeOf(p) {
  try {
    const s = statSync(p);
    return s.isFile() ? s.size : 0;
  } catch {
    return 0;
  }
}

let target;
try {
  target = require('ffmpeg-static');
} catch (e) {
  console.warn('[ensure-ffmpeg] ffmpeg-static is not installed:', e.message);
  process.exit(0);
}

if (!target) {
  console.warn('[ensure-ffmpeg] ffmpeg-static resolved to no path at all.');
  process.exit(0);
}

if (sizeOf(target) >= MIN_BYTES) {
  console.log('[ensure-ffmpeg] ok — ' + (sizeOf(target) / 1048576).toFixed(0) + ' MB at ' + target);
  process.exit(0);
}

console.warn('[ensure-ffmpeg] binary missing at ' + target + ' — running the package installer.');
try {
  execFileSync(process.execPath, [require.resolve('ffmpeg-static/install.js')], { stdio: 'inherit' });
} catch (e) {
  console.warn('[ensure-ffmpeg] installer failed:', e.message);
}

const finalSize = sizeOf(target);
if (finalSize >= MIN_BYTES) {
  console.log('[ensure-ffmpeg] recovered — ' + (finalSize / 1048576).toFixed(0) + ' MB.');
} else {
  // Deliberately not a build failure: the video sweep is one feature, and the
  // rest of the dashboard should still deploy. /api/health carries the news.
  console.warn(
    '\n[ensure-ffmpeg] NO FFMPEG BINARY. Drive videos cannot be transcribed on this\n' +
    '                deployment; the Video Library will ask for a pasted transcript\n' +
    '                instead. Set FFMPEG_PATH to a binary on the image, or allow the\n' +
    '                build network to reach github.com so the installer can fetch it.\n',
  );
}
