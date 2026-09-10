// Pure helpers behind the composer and the repurpose panel.
//
// These live outside the page component on purpose: they encode the rules that
// decide whether a post can be sent, whether a video URL can start a paid clip
// job, and how a draft is labelled — the exact places where the dashboard used
// to let a mistake through silently. Keeping them pure makes each rule
// unit-testable without a browser (see lib/composer.test.ts).

/**
 * Every channel this deployment can post to, in the order the chips appear.
 *
 * THE LIST WAS DECLARED THREE TIMES — here, in app/page.tsx and in
 * app/calendar/page.tsx — all four entries, all identical, and nothing kept
 * them in step with what Metricool actually has connected. So YouTube and
 * TikTok, the two channels the clinic's video work is for, could not be picked
 * anywhere, while /api/metricool/schedule had mapped both providers the whole
 * time. Both pages now import this one; adding a channel is a one-line change.
 *
 * `needsMedia` marks a feed that will not take a text-only post. It is not the
 * same question as "is this a video channel": LinkedIn happily carries a video
 * AND happily goes out without one, so it is not marked.
 */
export const PUBLISH_NETWORKS: { id: string; label: string; emoji: string; needsMedia?: true }[] = [
  { id: 'facebook', label: 'Facebook', emoji: '\u{1F4D8}' },
  { id: 'instagram', label: 'Instagram', emoji: '\u{1F4F8}' },
  { id: 'linkedin', label: 'LinkedIn', emoji: '\u{1F4BC}' },
  { id: 'twitter', label: 'X / Twitter', emoji: '\u{1D54F}' },
  { id: 'youtube', label: 'YouTube', emoji: '\u{25B6}\u{FE0F}', needsMedia: true },
  { id: 'tiktok', label: 'TikTok', emoji: '\u{1F3B5}', needsMedia: true },
];

// Hard character ceilings each network enforces on its own side. Metricool will
// reject or truncate anything longer, and it used to do that silently after the
// post had already left this screen — so the composer checks first.
//
// A network missing from this map is checked against Infinity — never refused
// here, refused by the network instead — which is what was happening to
// YouTube and TikTok while they had no chips to be selected from.
export const NETWORK_LIMITS: Record<string, number> = {
  twitter: 280,
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
  // YouTube's description field.
  youtube: 5000,
  tiktok: 2200,
};

/** Feeds that refuse a post with no image or video attached. */
export const NETWORKS_NEEDING_MEDIA: ReadonlySet<string> = new Set(
  PUBLISH_NETWORKS.filter((n) => n.needsMedia).map((n) => n.id),
);

/**
 * Where a video goes by default, mirroring DEFAULT_VIDEO_NETWORKS in
 * lib/video-slot.ts — the sweep's own answer to the same question.
 *
 * Mirrored rather than imported: video-slot.ts pulls ./timezone.ts with an
 * explicit .ts specifier, which is fine on the server and needless risk in a
 * client bundle. lib/composer.test.ts asserts the two stay identical, so there
 * is still exactly one answer.
 */
export const DEFAULT_VIDEO_NETWORKS = ['youtube', 'linkedin', 'tiktok'];

/**
 * Why this post cannot be sent yet, as far as attachments go — or null.
 *
 * The composer holds a media URL and sends it, but nothing ever checked that a
 * video-only channel HAD one. Selecting TikTok with no video produced a draft
 * that failed at Metricool with a vague upstream message, which is a much
 * worse place to find out than the screen you are standing on.
 */
export function mediaProblem(networks: readonly string[], media: string | null | undefined): string | null {
  if (String(media || '').trim()) return null;
  const missing = (networks || []).filter((n) => NETWORKS_NEEDING_MEDIA.has(String(n || '').toLowerCase()));
  if (!missing.length) return null;
  const names = missing.map((n) => networkLabel(n));
  const which = names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  return which + (names.length === 1 ? ' needs' : ' need') + ' a video or image attached. Attach one below, or unselect ' + (names.length === 1 ? 'it' : 'them') + '.';
}

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
