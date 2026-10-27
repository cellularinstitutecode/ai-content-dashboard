// Module hooks that let the REAL lib/video-autopilot.ts hand-off load under
// plain `node --test`, with the modules it does not exercise here stood in for.
//
// What stays real: handOffToMetricool itself, lib/sheet-ticks.ts (the row's
// ticks), lib/video-slot.ts (which networks go), lib/network-copy.ts and
// lib/video-tailor.ts (what each network is sent), lib/compliance.ts and
// lib/video-copy.ts (the AVISO and REF assembly), lib/queue-guard.ts.
//
// What is stood in for: the model (one canned adaptation per network), the
// video copy into Metricool, the posts table, the drafts table, Google. The
// stand-ins record what they were asked so the test can assert on it.
import { resolve as baseResolve, load as baseLoad } from './image-module-hooks.mjs';

const STUBS = {
  '@/lib/google-sources': `
    export const SOURCE_IDS = { videosSheet: () => 'sheet-1' };
    export async function ensureAiColumns() { return {}; }
    export async function listTabs() { return []; }
    export async function probeDriveMedia() { return { ok: false }; }
    export async function readTab() { return []; }
    export async function readTabWithMeta() { return { rows: [], hidden: new Set() }; }
    export async function readRowCells() { return {}; }
    export async function updateRowCells() {}
    export function sourcesConfigured() { return true; }
    export async function tabGid() { return null; }
  `,
  '@/lib/video-prepare': `
    const stamped = [];
    export function __stamped() { return stamped; }
    export function __reset() { stamped.length = 0; }
    export async function prepareVideo() { throw new Error('not used'); }
    export async function saveVideoDraft() { return 'draft-1'; }
    export async function stampDraftVideoMeta() {}
    export async function stampDraftTailored(draftId, tailored) { stamped.push({ draftId, tailored }); }
  `,
  '@/lib/ai': `
    const asked = [];
    export function __asked() { return asked; }
    export function __reset() { asked.length = 0; }
    export let answers = {};
    export function __answers(next) { answers = next; }
    export async function tailorCopy({ network, source, title }) {
      asked.push({ network, source, title });
      const a = answers[network];
      return typeof a === 'function' ? a(source) : (a ?? null);
    }
  `,
  '@/lib/existing-copy-cite': `
    export const CITE_EXISTING_BUDGET_MS = 1000;
    export async function citeExistingCopy() { throw new Error('not used'); }
  `,
  '@/lib/video-attach': `
    export async function attachPendingVideos() { return []; }
    export async function pendingVideoPosts() { return []; }
  `,
  '@/lib/video-publish': `
    const sent = [];
    export function __sent() { return sent; }
    export function __reset() { sent.length = 0; taken = []; }
    let taken = [];
    export function __taken(list) { taken = Array.isArray(list) ? list : []; }
    export async function takenSlots() { return taken; }
    export async function publishVideoDraft(input) {
      sent.push(input);
      return { network: input.network, ok: true, metricoolPostId: 'mc-' + sent.length, recorded: true };
    }
  `,
  '@/lib/video-revive': `export async function reviveStalledRuns() { return { revived: 0 }; }`,
  '@/lib/transcript-cache': `export async function cachedPublicCopy() { return null; }`,
  '@/lib/media-library': `
    export async function ensureShareableVideo(link, title) { return { ok: true, fileId: 'copy-1', url: 'https://storage.test/copy-1.mp4' }; }
  `,
  '@/lib/awaiting-posts': `export async function awaitingPostsForVideo() { return []; }`,
  '@/lib/video-register': `
    export async function recordFirstSeen() {}
    export async function recordVideoEvent() {}
  `,
  '@/lib/sweep-owner': `
    export async function resolveOwner() { return null; }
    export async function resolveSweepUser() { return null; }
  `,
  '@/lib/report': `
    const reported = [];
    export function __reported() { return reported; }
    export function reportError(tag, e, extra) { reported.push({ tag, message: e && e.message ? e.message : String(e), extra }); }
  `,
};

export async function resolve(specifier, context, next) {
  if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) return { url: 'stub:' + specifier, shortCircuit: true };
  return baseResolve(specifier, context, next);
}

export async function load(url, context, next) {
  if (url.startsWith('stub:') && Object.prototype.hasOwnProperty.call(STUBS, url.slice(5))) {
    return { format: 'module', source: STUBS[url.slice(5)], shortCircuit: true };
  }
  return baseLoad(url, context, next);
}
