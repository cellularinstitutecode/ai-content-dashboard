// web/lib/video-search.ts
// The Video Library's search box.
//
// Typing "200" returned every video whose title or copy happened to contain
// "200", as well as row 200, in sheet order, so the row asked for sat
// somewhere in a long list and had to be scrolled for. A bare number is how
// people name a video here ("row 200"), so it now finds that row and nothing
// else, the same rule as the publishing queue's search (lib/queue-search.ts).
// Anything else is a substring search over what the table shows.
//
// Pure: no imports, so the test runner reads this file directly.

export type SearchableVideo = {
  row?: unknown;
  title?: unknown;
  copy?: unknown;
  type?: unknown;
  creator?: unknown;
  format?: unknown;
  tab?: unknown;
};

/** Does this video match what was typed? An empty needle matches everything. */
export function matchesVideoSearch(v: SearchableVideo, needle: string): boolean {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) return true;
  // A bare number is a ROW number, and only a row number ("row 200" works too).
  const rowOnly = /^(?:row\s*)?(\d+)$/.exec(q);
  if (rowOnly) {
    const row = Number(v.row);
    return Number.isFinite(row) && Math.floor(row) === Number(rowOnly[1]);
  }
  return [v.title, v.copy, v.type, v.creator, v.format, v.tab]
    .map((x) => String(x ?? ''))
    .join(' ')
    .toLowerCase()
    .includes(q);
}

/** The library, filtered. Order is preserved. */
export function filterVideos<T extends SearchableVideo>(videos: readonly T[], needle: string): T[] {
  const q = String(needle || '').trim();
  if (!q) return [...videos];
  return videos.filter((v) => matchesVideoSearch(v, q));
}
