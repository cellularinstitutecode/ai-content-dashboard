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
  needs_transcript: 'Falta transcripción',
  failed: 'Error — revisar',
} as const;

export type CandidateRow = { videoLink: string; copy: string };

/**
 * Is this row worth working on?
 *
 * Two conditions, and the second is the important one: a row whose COPY cell
 * already has text is finished, whoever wrote it. The sweep's job is the empty
 * ones, and never the ones a person has already done.
 */
export function isCandidate(row: CandidateRow): boolean {
  const link = String(row.videoLink || '').trim();
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
  if (!primary) return supporting.join(', ');
  return supporting.length ? primary + ' · ' + supporting.join(', ') : primary;
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
