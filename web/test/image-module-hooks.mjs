// Module-resolution hooks that let the REAL lib/images.ts load under plain
// `node --test`, with no bundler and no new dependency.
//
// lib/images.ts imports two things a test process cannot satisfy: the
// `server-only` marker package (which throws by design outside a Server
// Component) and `@/lib/supabase-admin` (which needs live Supabase
// credentials). Everything else about the module — the generate/verify/retry
// loop, the candidate ranking, the no-text hard rule — is pure logic worth
// testing, and it was previously untestable for want of these two shims.
//
// The stubs are virtual modules: no files on disk, nothing for the app build
// to trip over. The Supabase stub records uploads so a test can assert that an
// image was actually stored, and exposes a reset for isolation between cases.
import { pathToFileURL } from 'node:url';

const STUBS = {
  'server-only': 'export {};',
  '@/lib/supabase-admin': `
    const uploads = [];
    export function __uploads() { return uploads; }
    export function __reset() { uploads.length = 0; }
    export function supabaseAdmin() {
      return {
        storage: {
          from() {
            return {
              upload(path, bytes, opts) {
                uploads.push({ path, size: bytes.length, contentType: opts && opts.contentType });
                return Promise.resolve({ error: null });
              },
              getPublicUrl(path) { return { data: { publicUrl: 'https://storage.test/' + path } }; },
            };
          },
          createBucket() { return Promise.resolve({}); },
        },
        from() {
          return {
            select() { return { eq() { return { maybeSingle: () => Promise.resolve({ data: null }) }; } }; },
            update() { return { eq: () => Promise.resolve({ error: null }) }; },
          };
        },
      };
    }
  `,
};

// The repo root, so '@/x' resolves the same way the tsconfig path alias does.
const WEB_ROOT = new URL('../', import.meta.url);

export async function resolve(specifier, context, next) {
  if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) {
    return { url: 'stub:' + specifier, shortCircuit: true };
  }
  if (specifier.startsWith('@/')) {
    // tsconfig's '@/x' alias points at the repo root. TypeScript resolves the
    // extension for you; Node's ESM resolver does not, so add it here - without
    // this, any aliased import of a real (unstubbed) module fails to resolve.
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
