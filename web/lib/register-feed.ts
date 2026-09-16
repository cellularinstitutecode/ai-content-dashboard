// web/lib/register-feed.ts
// What "Recently added" shows, and in what order.
//
// THE PROBLEM. The sweep records a line every time it runs — every fifteen
// minutes, whether it prepared anything or not. The panel asked the register
// for its last forty entries, and forty sweep lines is ten quiet hours: every
// arrival, every prepared row, every failure had been pushed out of the window
// by the sweep's own bookkeeping. The panel still worked perfectly. It just had
// nothing left to show but one grey line saying a sweep had run.
//
// So the two are read separately — the activity a person is looking for, and
// the single most recent run — and merged here.
//
// Pure: the reads are the caller's; this only orders and trims.

export type FeedEntry = { event?: string; createdAt?: string };

/** Newest first, by the register's own timestamp. Unparseable dates sort last. */
function newestFirst<T extends FeedEntry>(a: T, b: T): number {
  const at = Date.parse(String(a.createdAt || ''));
  const bt = Date.parse(String(b.createdAt || ''));
  if (!Number.isFinite(at) && !Number.isFinite(bt)) return 0;
  if (!Number.isFinite(at)) return 1;
  if (!Number.isFinite(bt)) return -1;
  return bt - at;
}

/**
 * The panel's feed: everything that happened, plus the latest run, newest first.
 *
 * `activity` is already free of run lines and is never trimmed to make room for
 * one — that is the whole point. At most ONE run line is added, because the
 * panel shows the latest run and older ones belong in the full table.
 */
export function mergeRegisterFeed<T extends FeedEntry>(activity: readonly T[], runs: readonly T[]): T[] {
  const latestRun = [...runs].sort(newestFirst)[0];
  const out = [...activity];
  if (latestRun) out.push(latestRun);
  return out.sort(newestFirst);
}
