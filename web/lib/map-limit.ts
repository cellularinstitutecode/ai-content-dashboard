// Bounded concurrency: run N of something at a time.
//
// Its own module, with no imports, because it is a general-purpose helper and because a
// unit test should be able to reach it without dragging half the app's module graph in
// behind it.
/**
 * Run `work` over `items`, at most `limit` at a time, results in input order.
 *
 * There is no such helper anywhere in this repo — every Promise.all here fans out over a
 * short fixed list — and the batch needs one, because the two extremes are both wrong.
 * One at a time is a minute per video and thirty-three videos is half an hour of watching
 * a page. All at once overshoots the Semrush unit floor by the size of the burst (its
 * balance is cached per lambda instance, so concurrent callers each see the same
 * pre-spend number) and makes every 429 retry in lockstep.
 *
 * Order is preserved because the caller reports per row, and a run that finishes rows in
 * a jumbled order is hard to follow even when it is correct.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  // Each worker takes the next index until there are none left, so a slow video holds up
  // only its own lane rather than a whole chunk.
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await work(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
