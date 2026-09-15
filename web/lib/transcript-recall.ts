// web/lib/transcript-recall.ts
// A transcript that was paid for and then lost from the cache, found again in
// the draft that was written from it.
//
// THE LOSS. rememberPublicCopy() used to record a video's world-readable copy
// with an upsert that carried `text: ''` — and on a video whose transcript
// was already banked, that upsert REPLACED the transcript with nothing. It
// ran at the end of every successful Prepare, so every success wiped the
// transcript, and the next press paid the download and the transcription
// again — on a 144 MB reel, past the time the request has. The transcript
// looked present the whole time: the draft's pack still carried it.
//
// This module is the pure half of the recovery: given the video's draft
// packs, newest first, pick the transcript worth re-banking. The database
// half lives in lib/transcript-cache.ts. No imports, so the test runner can
// run this file directly.

/** The fields of a video draft's `pack` that matter here. */
export type PackLike = {
  transcript?: unknown;
  transcriptLanguage?: unknown;
  title?: unknown;
};

/** The same floor lib/video-transcript.ts applies to a fresh transcript. */
export const MIN_RECALL_CHARS = 40;

export type RecalledTranscript = { text: string; language: string | null; title: string | null };

/**
 * The newest usable transcript among a video's draft packs.
 *
 * `packs` come newest first. A pack queued from the sheet's own copy carries
 * `transcript: ''` (there was never one), and a pack whose transcript is a
 * few words is not worth writing from — both are passed over, so an older
 * pack with the real transcript still wins.
 */
export function transcriptFromPacks(packs: readonly (PackLike | null | undefined)[]): RecalledTranscript | null {
  for (const pack of packs) {
    if (!pack || typeof pack !== 'object') continue;
    const text = String(pack.transcript || '').trim();
    if (text.length < MIN_RECALL_CHARS) continue;
    const language = typeof pack.transcriptLanguage === 'string' && pack.transcriptLanguage.trim() ? pack.transcriptLanguage.trim() : null;
    const title = typeof pack.title === 'string' && pack.title.trim() ? pack.title.trim() : null;
    return { text, language, title };
  }
  return null;
}
