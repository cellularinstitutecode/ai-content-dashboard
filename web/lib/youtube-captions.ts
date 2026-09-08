// web/lib/youtube-captions.ts
// Pure helpers for YouTube caption tracks: which track to prefer, and how
// json3 caption events become plain text. lib/youtube-transcript.ts fetches.

export type Track = { baseUrl: string; languageCode: string; kind?: string; name?: { simpleText?: string; runs?: { text: string }[] } };

/** Prefer a human track in these languages, then any auto track. */
const PREFERRED = ['en', 'es'];


export function pickTrack(tracks: Track[]): Track | null {
  if (!tracks.length) return null;
  const manual = tracks.filter((t) => t.kind !== 'asr');
  for (const lang of PREFERRED) {
    const m = manual.find((t) => (t.languageCode || '').toLowerCase().startsWith(lang));
    if (m) return m;
  }
  if (manual.length) return manual[0];
  for (const lang of PREFERRED) {
    const a = tracks.find((t) => (t.languageCode || '').toLowerCase().startsWith(lang));
    if (a) return a;
  }
  return tracks[0];
}

/** json3 caption events → plain text, one sentence-ish per line. */
export function eventsToText(json: any): string {
  const events = Array.isArray(json?.events) ? json.events : [];
  const lines: string[] = [];
  for (const ev of events) {
    const segs = Array.isArray(ev?.segs) ? ev.segs : [];
    const t = segs.map((s: any) => String(s?.utf8 ?? '')).join('').replace(/\s+/g, ' ').trim();
    if (t && t !== '\n') lines.push(t);
  }
  return lines.join(' ').replace(/\s+/g, ' ').replace(/\s([.,!?])/g, '$1').trim();
}

