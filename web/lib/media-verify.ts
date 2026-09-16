// web/lib/media-verify.ts
// Is the URL we are about to hand Metricool really the video?
//
// Until now nothing looked. The Drive download link that backed every post
// answers, for a file over about a hundred megabytes, with Google's own
// "cannot scan this file for viruses" HTML page — and Metricool stored that
// page as the post's media, with a 200. This module asks the one question
// that would have caught it: fetch the first sixteen bytes, anonymously, the
// way Metricool will, and check that they are an MP4 (`ftyp` at offset 4) and
// that the file is exactly as long as Drive says the source is.
//
// The judgement is pure so it can be tested against fabricated probes; the
// one network call is a thin wrapper around it.

export type Mp4Probe = {
  status: number;
  /** Content-Range header, e.g. "bytes 0-15/143870376". */
  contentRange?: string | null;
  /** Content-Length header, when the server ignored the Range. */
  contentLength?: string | null;
  contentType?: string | null;
  firstBytes: Uint8Array;
};

export type Mp4Verdict =
  | { ok: true; length: number | null }
  | { ok: false; reason: 'unreachable' | 'not_mp4' | 'size_mismatch'; message: string };

/** `ftyp` at bytes 4..8 — the ISO base media file signature MP4 and MOV share. */
export function isMp4Header(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 8) return false;
  return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

/** The total length a Content-Range header names, or null. */
export function totalLengthFromRange(header: string | null | undefined): number | null {
  const m = /\/(\d+)\s*$/.exec(String(header || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Judge a probe. `expectedBytes` is Drive's own size for the source; when it
 * is unknown the length check is skipped and only the header is required.
 */
export function judgeMp4Probe(probe: Mp4Probe, expectedBytes: number | null | undefined): Mp4Verdict {
  if (probe.status !== 200 && probe.status !== 206) {
    return { ok: false, reason: 'unreachable', message: 'The video URL answered HTTP ' + probe.status + ' to an anonymous fetch.' };
  }
  if (!isMp4Header(probe.firstBytes)) {
    const looksHtml = /^\s*</.test(Buffer.from(probe.firstBytes).toString('latin1')) || /text\/html/i.test(String(probe.contentType || ''));
    return {
      ok: false,
      reason: 'not_mp4',
      message: looksHtml
        ? 'The video URL answers with a web page, not the video — Google’s download page for a large file, most likely.'
        : 'The first bytes of the video URL are not an MP4 header.',
    };
  }
  const length = totalLengthFromRange(probe.contentRange)
    ?? (probe.status === 200 && probe.contentLength ? Number(probe.contentLength) : null);
  if (expectedBytes != null && Number.isFinite(expectedBytes) && expectedBytes > 0 && length != null && length !== expectedBytes) {
    return {
      ok: false,
      reason: 'size_mismatch',
      message: 'The video URL serves ' + length.toLocaleString() + ' bytes; the source is ' + expectedBytes.toLocaleString() + '.',
    };
  }
  return { ok: true, length: Number.isFinite(length as number) ? (length as number) : null };
}

/**
 * Fetch the first sixteen bytes of `url` with no credentials and judge them.
 * Never throws: a network failure is an 'unreachable' verdict.
 */
export async function verifyPlayableMp4(url: string, expectedBytes: number | null | undefined, timeoutMs = 20_000): Promise<Mp4Verdict> {
  try {
    const res = await fetch(url, { headers: { range: 'bytes=0-15' }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    let firstBytes = new Uint8Array(0);
    if (res.body) {
      // Only the head of the body: a server that ignored the Range would
      // otherwise hand us the whole file.
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      while (got < 16) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) { chunks.push(value); got += value.length; }
      }
      try { await reader.cancel(); } catch { /* the bytes are read; closing is a courtesy */ }
      const all = new Uint8Array(got);
      let at = 0;
      for (const c of chunks) { all.set(c, at); at += c.length; }
      firstBytes = all.slice(0, 16);
    }
    return judgeMp4Probe({
      status: res.status,
      contentRange: res.headers.get('content-range'),
      contentLength: res.headers.get('content-length'),
      contentType: res.headers.get('content-type'),
      firstBytes,
    }, expectedBytes);
  } catch (e) {
    return { ok: false, reason: 'unreachable', message: 'The video URL could not be fetched: ' + (e instanceof Error ? e.message : String(e)) };
  }
}
