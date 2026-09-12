// web/lib/video-row.ts
// The decisions the video sweep makes about one row of the sheet, as pure
// functions: is this row worth working on, which row is it, and how does a
// keyword brief read once it is squeezed into a single cell.
//
// Separated from lib/video-autopilot.ts, which does the fetching and writing,
// so the rules that decide whether the clinic spends money on a video can be
// unit-tested without Google, Supabase or an AI provider in the room.
import { createHash } from 'node:crypto';

import { parseDriveFileId } from './drive-url.ts';
import { parseVideoUrl } from './composer.ts';
import { hashtagsFrom } from './hashtags.ts';

/**
 * A row's identity — derived from its CONTENT, never its row number.
 *
 * Somebody inserting a row at the top of a tab shifts every number below it.
 * Keyed on the number, that single insert would re-transcribe and rewrite the
 * whole tab on the next sweep.
 */
export function rowKeyFor(fileName: string, link: string): string {
  const basis = (String(link || '').trim() || String(fileName || '').trim()).toLowerCase();
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

/** What the sweep writes into ESTADO IA, so its state is legible in the sheet itself. */
export const STATUS_TEXT = {
  prepared: 'Listo para revisión',
  /** Copy was written, but with no keyword data behind it. */
  no_keywords: 'Listo — SIN keywords',
  /** Copy is longer than a network accepts, so it was not sent. */
  too_long: 'Listo — copy muy larga, acortar',
  needs_transcript: 'Falta transcripción',
  // Not an error: the slow half succeeded and the next pass writes the copy.
  transcript_ready: 'Transcripción lista — copy pendiente',
  failed: 'Error — revisar',
} as const;

/**
 * What a row's ESTADO IA should say once the copy is written.
 *
 * A prepared row is not automatically a GOOD row. Copy written without keyword
 * data is the ordinary output of a Semrush outage or an exhausted unit
 * balance, and it looked identical in the sheet to copy the keyword brief
 * actually shaped — so the one thing this automation exists to add could stop
 * happening and nobody would see it. It says so now.
 */
export function preparedStatus(opts: { hasKeywords: boolean; overLength: boolean }): string {
  if (opts.overLength) return STATUS_TEXT.too_long;
  if (!opts.hasKeywords) return STATUS_TEXT.no_keywords;
  return STATUS_TEXT.prepared;
}

/**
 * How much text each network accepts. Mirrors lib/composer.ts's NETWORK_LIMITS,
 * which the manual composer shows a counter against; nothing enforced it on
 * the automatic path, so an over-long post reached Metricool and was rejected
 * there — after the row had already been marked ready.
 */
export const NETWORK_LIMIT: Record<string, number> = {
  linkedin: 3000,
  // YouTube's description field. Missing here meant a video caption was checked
  // against Infinity — never refused by us, refused by YouTube instead.
  youtube: 5000,
  instagram: 2200,
  tiktok: 2200,
  facebook: 5000,
  twitter: 280,
};

/**
 * Does this copy fit?
 *
 * Deliberately reports rather than trims. The REF citation and the AVISO line
 * live at the END of a caption, so truncating to fit would cut exactly the two
 * lines that are legally required — a silently non-compliant post is far worse
 * than one a person is asked to shorten.
 */
export function fitsNetwork(network: string, text: string): { ok: boolean; limit: number; length: number } {
  const limit = NETWORK_LIMIT[String(network || '').toLowerCase()] ?? Infinity;
  const length = String(text || '').length;
  return { ok: length <= limit, limit, length };
}

/**
 * The first real URL in a LINK VIDEO cell.
 *
 * The cell is not always one bare link. The real sheet has
 * "SUBS: https://… NO SUBS: https://…" and "1. https://… 2. https://…" —
 * a person's note, not a field. Parsing the whole cell as a URL fails on
 * those, which silently made them ineligible; taking the first link matches
 * what the "Use in post" button has always done with the same cells.
 */
export function firstLinkIn(cell: string): string {
  const m = String(cell || '').match(/https?:\/\/\S+/);
  return m ? m[0].replace(/[),.]+$/, '') : '';
}

export type CandidateRow = { videoLink: string; copy: string };

/**
 * Is this row worth working on?
 *
 * Two conditions, and the second is the important one: a row whose COPY cell
 * already has text is finished, whoever wrote it. The sweep's job is the empty
 * ones, and never the ones a person has already done.
 */
export function isCandidate(row: CandidateRow): boolean {
  const link = firstLinkIn(row.videoLink);
  if (!link) return false;
  if (String(row.copy || '').trim()) return false;
  if (parseDriveFileId(link)) return true;
  const parsed = parseVideoUrl(link);
  return parsed.ok && parsed.source === 'YouTube';
}

export type KeywordStampLike = { primary?: string | null; keywords?: string[] | null } | null;

/**
 * The keyword brief as one spreadsheet cell.
 *
 * A cell is read by a person at a glance, not parsed, so the primary keyword
 * leads and the supporting terms follow it after a separator.
 */
export function keywordLineFrom(stamp: KeywordStampLike): string {
  if (!stamp) return '';
  const primary = String(stamp.primary || '').trim();
  const rest = Array.isArray(stamp.keywords) ? stamp.keywords.map((k) => String(k || '').trim()).filter(Boolean) : [];
  const supporting = rest.filter((k) => k.toLowerCase() !== primary.toLowerCase());
  const terms = !primary
    ? supporting.join(', ')
    : supporting.length ? primary + ' · ' + supporting.join(', ') : primary;

  // The cell does two jobs and only ever did one of them. Most rows hold the
  // SEO terms the copy was written against; the row the team pointed at holds
  // hashtags instead, because that is what someone actually pastes when
  // posting. Both, then — terms first, tags under them — so neither use has to
  // be retyped by hand from the other.
  // No terms means no brief, and a cell holding nothing but the house tag would
  // look like a finished row that had in fact never been researched.
  if (!terms) return '';
  const tags = hashtagsFrom([primary, ...supporting]);
  return tags.length ? terms + '\n\n' + tags.join(' ') : terms;
}

/**
 * A row marked 'preparing' — is that a sweep still working on it, or one that
 * died mid-flight?
 *
 * The hourly cron and the sheet's own edit trigger can fire seconds apart, and
 * transcribing a video takes minutes: without a claim, both would do the same
 * video and the clinic would pay twice. The claim has to expire, though, or a
 * request killed by a timeout would lock its row out forever.
 */
export const CLAIM_TTL_MS = 10 * 60_000;

export function claimIsStale(updatedAt: string | null | undefined, now = Date.now()): boolean {
  if (!updatedAt) return true;
  const at = Date.parse(updatedAt);
  return !Number.isFinite(at) || now - at > CLAIM_TTL_MS;
}
