// A queued post past its time goes to the next free slot, clear of everything else going out.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NEXT_SLOT, nextFreeSlotFor } from './queue-next-slot.ts';

/** A supabase-js shaped stub: every filter returns the chain, `limit` resolves the rows. */
function db(rows: { posts: unknown[]; template_runs: unknown[] }, fail = false) {
  const calls: Record<string, unknown[]>[] = [];
  return {
    calls,
    from(table: 'posts' | 'template_runs') {
      const log: Record<string, unknown[]> = { table: [table] };
      calls.push(log);
      const chain: any = {};
      for (const m of ['select', 'eq', 'not', 'in', 'gte', 'lte']) chain[m] = (...a: unknown[]) => { log[m] = a; return chain; };
      chain.limit = async () => (fail ? { data: null, error: { message: 'boom' } } : { data: rows[table], error: null });
      return chain;
    },
  };
}

test('the sentinel is what the buttons send', () => {
  assert.equal(NEXT_SLOT, 'next');
});

test('the slot is an hour clear of other posts and of runs, and the post itself does not block it', async () => {
  const now = new Date('2026-10-08T15:00:00Z'); // 09:00 in America/Cancun (UTC-5)
  const d = db({
    posts: [
      { id: 'me', publication_date: '2026-10-08T15:15:00Z' }, // the post being moved: not busy
      { id: 'a', publication_date: '2026-10-08T15:30:00Z' },
    ],
    template_runs: [{ scheduled_for: '2026-10-08T16:45:00Z' }],
  });
  const slot = await nextFreeSlotFor(d as any, 'u1', 'me', now);
  assert.ok(slot);
  // 15:15 is inside an hour of 'a' (15:30); 16:30 is inside an hour of the run (16:45);
  // 17:45 is the first quarter hour an hour clear of both.
  assert.equal(slot!.toISOString(), '2026-10-08T17:45:00.000Z');
  // The reads are the user's own, forward-looking, and leave out rows that will never go out.
  const posts = d.calls.find((c) => c.table[0] === 'posts')!;
  assert.deepEqual(posts.eq, ['user_id', 'u1']);
  assert.deepEqual(posts.not, ['status', 'in', '(cancelled,canceled,deleted,failed)']);
  assert.deepEqual(posts.gte, ['publication_date', now.toISOString()]);
  const runs = d.calls.find((c) => c.table[0] === 'template_runs')!;
  assert.deepEqual(runs.in, ['state', ['planned', 'researched', 'drafted', 'ready_for_review', 'approved']]);
});

test('a read that fails yields no slot rather than a guess', async () => {
  const slot = await nextFreeSlotFor(db({ posts: [], template_runs: [] }, true) as any, 'u1', 'me', new Date('2026-10-08T15:00:00Z'));
  assert.equal(slot, null);
});
