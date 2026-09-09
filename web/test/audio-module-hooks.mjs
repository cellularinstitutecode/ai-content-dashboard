// Module-resolution hooks that let the REAL lib/audio-extract.ts load under
// plain `node --test`.
//
// The module imports the `server-only` marker package, which throws by design
// outside a Server Component. Everything else about it — streaming a video to
// disk, driving ffmpeg, refusing a file with no sound, cleaning up after
// itself — is exactly what a test should exercise against real bytes, and it
// was untestable for want of that one shim. Same approach as
// test/image-module-hooks.mjs; kept separate so neither test's stubs can leak
// into the other.
const STUBS = {
  'server-only': 'export {};',
  '@/lib/report': 'export function redact(s) { return String(s); }\nexport function reportError() {}',
};

const WEB_ROOT = new URL('../', import.meta.url);

export async function resolve(specifier, context, next) {
  if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) {
    return { url: 'stub:' + specifier, shortCircuit: true };
  }
  if (specifier.startsWith('@/')) {
    const bare = specifier.slice(2);
    const withExt = /\.[cm]?[jt]sx?$/.test(bare) ? bare : bare + '.ts';
    return next(new URL(withExt, WEB_ROOT).href, context);
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith('stub:')) {
    return { format: 'module', source: STUBS[url.slice('stub:'.length)], shortCircuit: true };
  }
  return next(url, context);
}
