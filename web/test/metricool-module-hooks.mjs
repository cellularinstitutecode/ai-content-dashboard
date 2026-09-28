// The image-pipeline hooks, plus a stand-in for lib/google-sources.ts, whose
// parameter properties plain type-stripping cannot load. Lets the real
// lib/metricool.ts and lib/metricool-upload.ts run against a mocked fetch.
import { resolve as baseResolve, load as baseLoad } from './image-module-hooks.mjs';

const GOOGLE_SOURCES = `
  export async function driveMediaStream() { throw new Error('Drive is not used by this test'); }
  export async function probeDriveMedia() { return { ok: false, reason: 'unreachable', message: 'Drive is not used by this test' }; }
`;

export async function resolve(specifier, context, next) {
  if (specifier === '@/lib/google-sources') return { url: 'stub:google-sources', shortCircuit: true };
  return baseResolve(specifier, context, next);
}

export async function load(url, context, next) {
  if (url === 'stub:google-sources') return { format: 'module', source: GOOGLE_SOURCES, shortCircuit: true };
  return baseLoad(url, context, next);
}
