// web/lib/library-import.ts
// What a Library photo's tile says before and while it is copied in.
//
// The Image Library takes photos up to 200 MB (downloadDriveFileToDisk). A
// 2 MB phone photo is copied in about a second and needs nothing but
// "Copying…"; a 150 MB camera export can take a minute, and a bare "Working…"
// for that long reads as stuck. The folder listing already carries each
// file's size, so the tile can say it up front: how big the photo is, that
// one over the ceiling cannot be used (without a round trip to find out), and
// how long a big copy has been running.
//
// Pure: no imports, so the three pickers and the test runner all read it.

/** The server's ceiling (LIBRARY_IMAGE_MAX_BYTES in lib/google-sources.ts). */
export const LIBRARY_IMPORT_MAX_BYTES = 200 * 1024 * 1024;

/** From this size a copy takes long enough to be worth saying so. */
export const LARGE_IMPORT_BYTES = 10 * 1024 * 1024;

/** "45 MB", "3.2 MB", "0.4 MB". Empty for an unknown size. */
export function sizeLabel(size: number | null | undefined): string {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / 1048576;
  return (mb >= 10 ? String(Math.round(mb)) : mb.toFixed(1)) + ' MB';
}

/** Is the file over the ceiling? An unknown size is let through (the server still checks). */
export function tooLargeToImport(size: number | null | undefined): boolean {
  const n = Number(size);
  return Number.isFinite(n) && n > LIBRARY_IMPORT_MAX_BYTES;
}

export function isLargeImport(size: number | null | undefined): boolean {
  const n = Number(size);
  return Number.isFinite(n) && n >= LARGE_IMPORT_BYTES;
}

/**
 * The tile's caption under the thumbnail when idle: the name, plus the size
 * for a big photo, or why it cannot be used.
 */
export function tileNote(size: number | null | undefined): string {
  if (tooLargeToImport(size)) return 'Too large (' + sizeLabel(size) + ', max 200 MB)';
  return isLargeImport(size) ? sizeLabel(size) : '';
}

/**
 * The caption while the copy runs. `verb` is the picker's own word
 * ("Copying", "Attaching", "Working"). A small photo gets the verb alone;
 * a big one gets its size and, after the first second, the seconds so far.
 */
export function busyLabel(verb: string, size: number | null | undefined, elapsedSec: number): string {
  if (!isLargeImport(size)) return verb + '…';
  const secs = Math.max(0, Math.floor(elapsedSec));
  return verb + ' ' + sizeLabel(size) + '…' + (secs >= 1 ? ' ' + secs + ' s' : '');
}
