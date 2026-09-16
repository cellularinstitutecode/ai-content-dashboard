// GET|HEAD /api/media/video/<driveId>/<exp>/<sig>/video.mp4
//
// The clinic's reel, served by this app, to anyone holding a URL this app
// signed. It is the one route in the codebase that answers without a session,
// because the caller is Metricool's fetcher and it has no way to hold one.
//
// WHY. Metricool pulls a post's video onto its own storage from a URL we give
// it. A Drive download link answers a file over ~100 MB with Google's
// virus-scan web page, which Metricool stored as the video; Supabase Storage
// refuses anything over 50 MB on the Free plan, and that limit is fixed. So
// the bytes come from here instead — streamed out of Drive with the service
// account that already reads them, never copied, never stored, never capped.
//
// WHAT GUARDS IT. lib/media-url.ts's HMAC, and nothing else: no database read,
// no session, no allowlist. The signature covers the file id and the expiry
// together, so a URL for one video cannot be edited into a URL for another and
// an expiry cannot be extended. With no signing key configured it refuses
// everything rather than serving anything.
//
// WHAT IT DOES NOT DO. It never buffers. The upstream body is handed to the
// platform as a stream, so a 1.8 GB file costs a few chunks of memory, and a
// Range request is forwarded to Drive rather than answered by reading and
// slicing. That last part is what makes lib/media-verify.ts's sixteen-byte
// check cost sixteen bytes.
import type { NextRequest } from 'next/server';

import { driveMediaStream, probeDriveMedia } from '@/lib/google-sources';
import { forwardableRange } from '@/lib/http-range';
import { parseMediaPathParts, verifyMediaSignature } from '@/lib/media-url';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Vercel's ceiling, and the reason the minted URL should not point at Vercel.
 *
 * A function there streams through AWS Lambda, which throttles a response hard
 * after the first few megabytes and caps the payload well under one reel. The
 * Dokploy container is a long-lived Node server where this constant is simply
 * ignored and there is no ceiling at all — so PUBLIC_MEDIA_BASE_URL should name
 * that host. This value is here so the Vercel copy of the route is not capped
 * at the 10-second default if anything ever does reach it.
 */
export const maxDuration = 300;

/** Half an hour: the largest reel is 1.8 GB, which is six minutes at a modest 5 MB/s. */
const STREAM_TRANSFER_MS = 30 * 60_000;

/**
 * One answer for every refusal.
 *
 * Expired and forged are different to an operator and identical to a stranger,
 * so the difference is logged and not returned. 403 rather than 404 because a
 * well-formed URL that has run out is not a missing page.
 */
function refused(): Response {
  return new Response('This video link is not valid.\n', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function upstreamDown(): Response {
  return new Response('The video is unavailable.\n', {
    status: 502,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function serve(req: NextRequest, parts: string[], method: 'GET' | 'HEAD'): Promise<Response> {
  const parsed = parseMediaPathParts(parts);
  if (!parsed) return refused();

  const verdict = verifyMediaSignature(parsed.fileId, parsed.exp, parsed.sig);
  if (!verdict.ok) {
    reportError('media-video:refused', new Error(verdict.reason), { fileId: parsed.fileId });
    return refused();
  }

  // HEAD is one metadata call and never a download. Answering it by opening a
  // 1.8 GB body and throwing it away would double what this route costs
  // against Drive for a question that is answered by the file's size.
  if (method === 'HEAD') {
    const probe = await probeDriveMedia(parsed.fileId, Number.POSITIVE_INFINITY);
    if (!probe.ok) return upstreamDown();
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': probe.contentType || 'video/mp4',
        ...(probe.sizeBytes != null ? { 'content-length': String(probe.sizeBytes) } : {}),
        'accept-ranges': 'bytes',
        'content-disposition': 'inline; filename="video.mp4"',
        'cache-control': 'no-store',
      },
    });
  }

  // The client's Range, sanitised, straight to Drive — which honours it and
  // answers 206 with its own Content-Range. No offsets are computed here, so
  // there is no arithmetic to get wrong.
  const range = forwardableRange(req.headers.get('range'));

  // Two deadlines, whichever comes first. Without the request's own signal, a
  // caller that hangs up leaves us pulling the whole file from Drive for
  // nobody — on a route whose whole job is large files.
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(STREAM_TRANSFER_MS)]);

  let upstream: Response;
  try {
    upstream = await driveMediaStream(parsed.fileId, STREAM_TRANSFER_MS, { ...(range ? { range } : {}), signal });
  } catch (e) {
    reportError('media-video:drive', e, { fileId: parsed.fileId });
    return upstreamDown();
  }
  if (!upstream.ok || !upstream.body) {
    reportError('media-video:drive-status', new Error('Drive answered HTTP ' + upstream.status), { fileId: parsed.fileId });
    return upstreamDown();
  }

  const out = new Headers();
  // Drive's own type, defaulted. A .mov relabelled video/mp4 would be a lie,
  // and media-verify only asks for `ftyp`, which both containers carry.
  out.set('content-type', upstream.headers.get('content-type') || 'video/mp4');
  const length = upstream.headers.get('content-length');
  if (length) out.set('content-length', length);
  const contentRange = upstream.headers.get('content-range');
  if (contentRange) out.set('content-range', contentRange);
  out.set('accept-ranges', 'bytes');
  out.set('content-disposition', 'inline; filename="video.mp4"');
  // no-store, deliberately: the URL expires, so a cached copy would outlive
  // its own signature, and nothing upstream should be tempted to hold 1.8 GB
  // in order to keep one.
  out.set('cache-control', 'no-store');
  // content-encoding, transfer-encoding and connection are NOT copied — they
  // describe Drive's hop, not ours, and forwarding them corrupts the body.

  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers: out });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ parts: string[] }> }) {
  return serve(req, (await ctx.params).parts || [], 'GET');
}

export async function HEAD(req: NextRequest, ctx: { params: Promise<{ parts: string[] }> }) {
  return serve(req, (await ctx.params).parts || [], 'HEAD');
}
