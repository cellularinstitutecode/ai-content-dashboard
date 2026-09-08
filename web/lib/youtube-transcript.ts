// web/lib/youtube-transcript.ts
// The words in a YouTube video, from YouTube's own caption tracks.
//
// YouTube publishes caption tracks (uploaded or auto-generated) for most
// videos; the watch page carries their URLs in ytInitialPlayerResponse, and
// each track is fetched as json3 events. No API key, no download of the
// video. When a video has no track at all, that is reported as such — the
// Video Library then asks for the transcript to be pasted, rather than
// pretending. The base host is overridable so the e2e harness can stand in.
import 'server-only';

import { redact } from '@/lib/report';
import { eventsToText, pickTrack, type Track } from '@/lib/youtube-captions';

export type TranscriptResult =
  | { ok: true; text: string; language: string; auto: boolean; title: string | null; durationSec: number | null }
  | { ok: false; reason: 'no_captions' | 'unavailable' | 'bad_id'; message: string; title: string | null };

const BASE = () => (process.env.YOUTUBE_BASE || 'https://www.youtube.com').replace(/\/$/, '');

export async function fetchYouTubeTranscript(videoId: string, opts: { timeoutMs?: number } = {}): Promise<TranscriptResult> {
  const id = String(videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return { ok: false, reason: 'bad_id', message: 'That is not a YouTube video id.', title: null };
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 15000);
  try {
    const page = await fetch(BASE() + '/watch?v=' + encodeURIComponent(id) + '&hl=en', {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language': 'en-US,en;q=0.9,es;q=0.8',
        cookie: 'CONSENT=YES+1; SOCS=CAI',
      },
      signal: ctl.signal,
    });
    if (!page.ok) return { ok: false, reason: 'unavailable', message: 'YouTube did not answer for this video (HTTP ' + page.status + ').', title: null };
    const html = await page.text();
    const titleMatch = /"title":"((?:[^"\\]|\\.)*)"/.exec(html.slice(html.indexOf('"videoDetails"')));
    const title = titleMatch ? JSON.parse('"' + titleMatch[1] + '"') : null;
    const durMatch = /"lengthSeconds":"(\d+)"/.exec(html);
    const durationSec = durMatch ? Number(durMatch[1]) : null;
    const capIdx = html.indexOf('"captionTracks":');
    if (capIdx < 0) return { ok: false, reason: 'no_captions', message: 'This video has no captions on YouTube, so there is nothing to transcribe automatically. Paste the transcript instead.', title };
    const arrStart = html.indexOf('[', capIdx);
    // Find the matching close bracket for the tracks array.
    let depth = 0; let end = arrStart;
    for (let i = arrStart; i < html.length; i++) {
      const ch = html[i];
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    let tracks: Track[] = [];
    try { tracks = JSON.parse(html.slice(arrStart, end)); } catch { tracks = []; }
    const track = pickTrack(tracks);
    if (!track?.baseUrl) return { ok: false, reason: 'no_captions', message: 'This video has no usable caption track. Paste the transcript instead.', title };
    let url = track.baseUrl.replace(/\\u0026/g, '&');
    if (url.startsWith('/')) url = BASE() + url;
    url += url.includes('fmt=') ? '' : (url.includes('?') ? '&' : '?') + 'fmt=json3';
    const cap = await fetch(url, { signal: ctl.signal });
    if (!cap.ok) return { ok: false, reason: 'unavailable', message: 'The caption track could not be read (HTTP ' + cap.status + ').', title };
    const json = await cap.json().catch(() => null);
    const text = eventsToText(json);
    if (!text) return { ok: false, reason: 'no_captions', message: 'The caption track is empty. Paste the transcript instead.', title };
    return { ok: true, text, language: track.languageCode || 'en', auto: track.kind === 'asr', title, durationSec };
  } catch (e) {
    return { ok: false, reason: 'unavailable', message: 'YouTube could not be reached just now (' + redact(e instanceof Error ? e.message : 'error') + ').', title: null };
  } finally {
    clearTimeout(to);
  }
}
