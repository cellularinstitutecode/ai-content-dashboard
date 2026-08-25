// Pure helpers behind the composer and the repurpose panel.
//
// These live outside the page component on purpose: they encode the rules that
// decide whether a post can be sent, whether a video URL can start a paid clip
// job, and how a draft is labelled — the exact places where the dashboard used
// to let a mistake through silently. Keeping them pure makes each rule
// unit-testable without a browser (see lib/composer.test.ts).

export const PUBLISH_NETWORKS: { id: string; label: string }[] = [
  { id: 'facebook', label: 'Facebook' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'twitter', label: 'X / Twitter' },
];

// Hard character ceilings each network enforces on its own side. Metricool will
// reject or truncate anything longer, and it used to do that silently after the
// post had already left this screen — so the composer checks first.
export const NETWORK_LIMITS: Record<string, number> = {
  twitter: 280,
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
};

// Returns the tightest limit across the selected channels, or null if none.
export function tightestLimit(networks: string[]): { network: string; limit: number } | null {
  let best: { network: string; limit: number } | null = null;
  for (const n of networks) {
    const limit = NETWORK_LIMITS[n];
    if (typeof limit !== 'number') continue;
    if (!best || limit < best.limit) best = { network: n, limit };
  }
  return best;
}

export function networkLabel(id: string) {
  const found = PUBLISH_NETWORKS.find((n) => n.id === id);
  return found ? found.label : id;
}

// Accept only the hosts OpusClip can actually ingest. Anything else used to
// sail through and burn a clip job that failed minutes later with no
// explanation, so the parse now happens before the button is even enabled.
export function parseVideoUrl(raw: string): { ok: true; source: 'YouTube' | 'Vimeo'; id: string } | { ok: false; reason: string } {
  const value = (raw || '').trim();
  if (!value) return { ok: false, reason: '' };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : 'https://' + value);
  } catch {
    return { ok: false, reason: "That doesn't look like a link. Paste the full video URL." };
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id ? { ok: true, source: 'YouTube', id } : { ok: false, reason: 'That YouTube link has no video ID.' };
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const v = url.searchParams.get('v');
    if (v) return { ok: true, source: 'YouTube', id: v };
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
    if (m) return { ok: true, source: 'YouTube', id: m[1] };
    return { ok: false, reason: 'That YouTube link has no video ID. Use a watch, shorts or youtu.be link.' };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = url.pathname.match(/(\d{6,})/);
    if (m) return { ok: true, source: 'Vimeo', id: m[1] };
    return { ok: false, reason: 'That Vimeo link has no video ID.' };
  }
  return { ok: false, reason: 'Only YouTube and Vimeo links work here — Opus cannot fetch ' + host + '.' };
}

// datetime-local wants "YYYY-MM-DDTHH:mm" in local time, not an ISO/UTC string.
export function localDateTimeValue(d: Date) {
  const pad = (x: number) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// Some drafts were created from pasted text and stored the whole post as their
// topic, so a 700-character body with hashtags was rendering where every other
// row shows a short label. Trim to the first sentence for display only — the
// stored record is never rewritten.
export function draftLabel(raw: unknown, fallback = 'Untitled draft'): string {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  if (text.length <= 72) return text;
  // Prefer a whole opening sentence — it reads like a title. 120 is roughly the
  // longest first sentence that still scans in a list row (rows are CSS-truncated,
  // so this bounds the data, not the layout).
  const stop = text.search(/[.!?](\s|$)/);
  if (stop > 0 && stop <= 120) return text.slice(0, stop + 1);
  const cut = text.slice(0, 72);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

// Local YYYY-MM-DD key for a Date. Deliberately built from local calendar
// components rather than toISOString(), which shifts the day for anyone west of
// UTC after their afternoon — the calendar grid compares cells with this.
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
