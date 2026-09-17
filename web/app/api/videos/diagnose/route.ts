// web/app/api/videos/diagnose/route.ts
// "Check absolutely everything — there's something wrong."
//
// Six rounds of this failure have been diagnosed by reading code, and every
// round cost the clinic a send. The facts that would settle it live in the
// deployment, not in the repository: how big the file is, which copy exists,
// which host that copy is served from, and — the one nobody has measured —
// whether a fetcher pulling the WHOLE file gets the whole file.
//
// That last one is the test. A browser plays these links, because a player
// asks for small ranges. lib/media-verify.ts passes them, because it reads
// sixteen bytes. Metricool pulls the entire video, and nothing in this app has
// ever imitated that. So this asks for a large range and counts what actually
// arrives: if a host truncates, this is where it shows.
//
// Read-only. It makes no copy, changes no row, and sends nothing to Metricool.
import { NextRequest, NextResponse } from 'next/server';

import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { parseDriveFileId } from '@/lib/drive-url';
import { probeDriveMedia } from '@/lib/google-sources';
import { cachedPublicCopy } from '@/lib/transcript-cache';
import { freshCopyUrl } from '@/lib/media-library';
import { publicBase, publicBaseSource } from '@/lib/public-base';
import { isStreamCopyId } from '@/lib/media-url';
import { isBucketVideoKey } from '@/lib/video-bucket-key';
import { copyRouteFor, servesWholeVideos } from '@/lib/copy-source';
import { readableSize } from '@/lib/media-normalize-reason';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
// The pull test is a real transfer, bounded below. 60s is plenty for 25 MB and
// well short of anything that could be mistaken for the whole file.
export const maxDuration = 120;

/** How much to pull. Above the ceiling a serverless response is known to hit. */
const PULL_BYTES = 25 * 1024 * 1024;
const PULL_MS = 45_000;

/** What a fetcher that wants the whole file actually receives. */
async function pullTest(url: string, want: number): Promise<{ status: number; asked: number; got: number; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { range: 'bytes=0-' + (want - 1) },
      redirect: 'follow',
      signal: AbortSignal.timeout(PULL_MS),
    });
    let got = 0;
    if (res.body) {
      const reader = res.body.getReader();
      // Counted, never kept: the point is how many bytes arrive before the
      // stream ends, and holding 25 MB to find out would be the wrong way.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value?.length || 0;
      }
    }
    return { status: res.status, asked: want, got, ms: Date.now() - started };
  } catch (e) {
    return { status: 0, asked: want, got: 0, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const rl = await checkRateLimit(auth.userId, 'keywords');
  if (!rl.ok) {
    return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });
  }

  const link = (req.nextUrl.searchParams.get('link') || '').trim();
  const fileId = parseDriveFileId(link) || (/^[A-Za-z0-9_-]{20,80}$/.test(link) ? link : '');
  if (!fileId) {
    return NextResponse.json({ error: 'bad_request', message: 'Pass ?link= the row’s Google Drive video link.' }, { status: 400 });
  }

  const findings: string[] = [];
  const out: Record<string, unknown> = { fileId };

  // 1. THE SOURCE FILE.
  const probe = await probeDriveMedia(fileId, Number.POSITIVE_INFINITY);
  const sizeBytes = probe.sizeBytes ?? null;
  out.source = probe.ok
    ? { name: probe.name, contentType: probe.contentType, sizeBytes, size: readableSize(sizeBytes) }
    : { error: probe.message, sizeBytes, size: readableSize(sizeBytes) };
  findings.push(probe.ok
    ? 'The video in Drive is ' + (readableSize(sizeBytes) || 'of unknown size') + ' (' + probe.contentType + ').'
    : 'Drive could not be read for this file: ' + probe.message);

  // 2. WHERE THE ADDRESSES COME FROM.
  const source = publicBaseSource();
  const base = (() => { try { return publicBase(); } catch { return ''; } })();
  const canStream = servesWholeVideos(base);
  out.base = { base, from: source.ok ? source.from : null, servesWholeVideos: canStream };
  findings.push(base
    ? 'Media links are built from ' + base + (source.ok ? ' (' + source.from + ')' : '') + ', which ' +
      (canStream ? 'can serve a whole video.' : 'is a serverless host: it cannot hand a whole video to Metricool.')
    : 'No public address is configured, so no media link can be minted at all.');

  // 3. THE COPY THIS ROW ALREADY HAS.
  let copyUrl = '';
  try {
    const known = await cachedPublicCopy(fileId);
    if (known?.url) {
      copyUrl = freshCopyUrl(known.id, known.url, fileId);
      const kind = isStreamCopyId(known.id) ? 'stream' : isBucketVideoKey(known.id) ? 'bucket' : 'drive';
      const host = (() => { try { return new URL(copyUrl).host; } catch { return ''; } })();
      out.copy = { kind, id: known.id, host, url: copyUrl };
      findings.push('Its copy is a ' + kind + ' copy, served from ' + (host || 'an unreadable address') + '.');
    } else {
      out.copy = null;
      findings.push('No copy has been made for this video yet.');
    }
  } catch (e) {
    reportError('videos:diagnose-copy', e, { fileId });
    findings.push('The copy record could not be read.');
  }

  // 4. WHAT WOULD BE CHOSEN NOW.
  const route = copyRouteFor({ staged: false, sizeBytes, base });
  out.routeNow = route;
  findings.push(route.source === 'refuse'
    ? 'A new copy would be REFUSED: ' + route.message
    : 'A new copy would be made as a ' + route.source + ' copy.');

  // 5. THE TEST NOTHING HAS EVER RUN: pull it the way Metricool does.
  if (copyUrl) {
    const want = Math.min(PULL_BYTES, sizeBytes && sizeBytes > 0 ? sizeBytes : PULL_BYTES);
    const pull = await pullTest(copyUrl, want);
    out.pull = { ...pull, asked: readableSize(pull.asked), got: readableSize(pull.got) };
    if (pull.error) {
      findings.push('Pulling ' + readableSize(want) + ' from that copy FAILED after ' + Math.round(pull.ms / 1000) + 's: ' + pull.error);
    } else if (pull.got >= want) {
      findings.push('Pulling ' + readableSize(want) + ' from that copy worked (' + Math.round(pull.ms / 1000) + 's). The link can deliver the file.');
    } else {
      findings.push(
        'THE LINK TRUNCATES. ' + readableSize(want) + ' was asked for and ' + readableSize(pull.got) + ' arrived (HTTP ' +
        pull.status + ', ' + Math.round(pull.ms / 1000) + 's). A browser plays it because a player asks for small pieces; ' +
        'Metricool pulls the whole file and gets a broken one.',
      );
    }
  }

  return NextResponse.json({ ok: true, findings, ...out }, { headers: { 'cache-control': 'no-store' } });
}
