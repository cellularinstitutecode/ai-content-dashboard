// web/lib/queue-search.ts
// Finding one draft in the publishing queue.
//
// THE PROBLEM. The queue shows six rows and then a "show all". With a backlog
// in it, the only way to reach the drafts for row 183 — the ones the composer
// had just refused to duplicate — was to open everything and read down the
// list. There was no filter of any kind.
//
// The row NUMBER is the thing people actually type, because it is what every
// conversation about this sheet uses ("row 183", "column E"). So an all-digits
// needle matches the row EXACTLY and nothing else: typing 183 must not also
// return every post whose caption happens to contain "183". Anything else is a
// plain substring over what a person can see — the row label, the tab, the
// networks, the status and the copy.
//
// The same shape the Video Library's search already uses, for the same reason.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { sheetRowLabel, type PostSource } from './sheet-link.ts';

export type SearchablePost = {
  text?: unknown;
  status?: unknown;
  providers?: unknown;
  source?: PostSource | null;
};

/** Everything about a post a person could reasonably search by, as one string. */
function haystack(post: SearchablePost): string {
  const source = post.source || null;
  const providers = Array.isArray(post.providers) ? post.providers : [];
  return [
    sheetRowLabel(source),
    source?.tab,
    source?.title,
    ...providers,
    post.status,
    post.text,
  ].map((x) => String(x ?? '')).join(' ').toLowerCase();
}

/** Does this queued draft match what was typed? An empty needle matches everything. */
export function matchesQueueSearch(post: SearchablePost, needle: string): boolean {
  const q = String(needle || '').trim().toLowerCase();
  if (!q) return true;
  // A bare number is a ROW number, and only a row number.
  if (/^\d+$/.test(q)) {
    const row = post.source?.row;
    return row != null && Number.isFinite(row) && Math.floor(Number(row)) === Number(q);
  }
  return haystack(post).includes(q);
}

/** The queue, filtered. Order is preserved. */
export function filterQueue<T extends SearchablePost>(posts: readonly T[], needle: string): T[] {
  const q = String(needle || '').trim();
  if (!q) return [...posts];
  return posts.filter((p) => matchesQueueSearch(p, q));
}
