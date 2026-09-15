// web/lib/existing-copy.ts
// Rows whose copy a person already wrote — still a draft that needs its video.
//
// THE PROBLEM. The sweep's rule has always been "a filled COPY cell is
// finished work", which is right for WRITING: the app must never overwrite
// what a person wrote. But 103 of the 124 visible rows on the clinic's video
// tab have copy and no draft anywhere — not in the dashboard, not in
// Metricool — so "every row from 179 onward, with its video attached" was
// true for 19 rows and false for 103. Those rows do not need copy; they need
// to be QUEUED, with the copy exactly as the sheet has it.
//
// This module holds that rule so it is stated once and testable. The sweep
// applies it after the hidden-row and start-row rules, never before.
//
// Pure: the test runner strips types and runs this file directly.
import { firstLinkIn, isCandidate, type CandidateRow } from './video-row.ts';
import { parseDriveFileId } from './drive-url.ts';
import { parseVideoUrl } from './composer.ts';

/**
 * How many existing-copy rows one run may queue.
 *
 * Separate from the five transcriptions a run may start: queuing costs one
 * Drive copy and a few Metricool calls — seconds, not minutes — so a run can
 * clear a whole month of them without touching the transcription budget.
 */
export const EXISTING_COPY_PER_RUN = 20;

/** Is the link one the app can attach — a Drive file or a YouTube video? */
export function hasPreparableLink(videoLink: string): boolean {
  const link = firstLinkIn(videoLink);
  if (!link) return false;
  if (parseDriveFileId(link)) return true;
  const parsed = parseVideoUrl(link);
  return parsed.ok && parsed.source === 'YouTube';
}

/**
 * A row with a video AND copy already written: not the sweep's to write, but
 * its to queue. Disjoint from isCandidate by construction — a row is one or
 * the other or neither, never both.
 */
export function isExistingCopyRow(row: CandidateRow): boolean {
  if (isCandidate(row)) return false;
  if (!String(row.copy || '').trim()) return false;
  return hasPreparableLink(row.videoLink);
}

/**
 * The copy as it will be sent: the cell's text, trimmed, with Windows line
 * endings normalised. Nothing else — no rewriting, no added lines. Whether it
 * fits a network is still decided per network by fitsNetwork, and whether it
 * carries the AVISO and REF lines by the compliance gate, exactly as for any
 * other post.
 */
export function existingCopyText(copy: string): string {
  return String(copy || '').replace(/\r\n?/g, '\n').trim();
}

/** VIDEO_QUEUE_EXISTING_COPY: on unless it says off/false/0/no. */
export function queueExistingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.VIDEO_QUEUE_EXISTING_COPY || '').trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0' || v === 'no');
}
