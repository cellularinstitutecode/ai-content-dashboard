// web/lib/posts-read-wiring.test.ts
// "Failed to load posts (429)". Reading the publishing list was counted in
// the same 120-an-hour bucket as approving into Metricool and deleting, and
// four screens re-read it on every 'posts' refresh signal — so a busy hour
// blanked the calendar. Source checks: the route and the screens cannot be
// loaded by the test runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('reading the list has its own, larger bucket; the writes keep theirs', () => {
  const limits = src('lib/rate-limit.ts');
  const read = Number(/'posts-read': \{ limit: (\d+)/.exec(limits)?.[1]);
  const write = Number(/\n\s*posts: \{ limit: (\d+)/.exec(limits)?.[1]);
  assert.ok(read > write, 'posts-read ' + read + ' vs posts ' + write);

  const route = src('app/api/posts/route.ts');
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function', route.indexOf('export async function GET') + 10));
  assert.match(get, /checkRateLimit\(user\.id, 'posts-read'\)/);
  assert.equal((route.match(/checkRateLimit\(user\.id, 'posts'\)/g) || []).length, 2, 'the two writing handlers stay in the write bucket');
});

test('every screen reads the list through the shared request', () => {
  for (const p of ['app/page.tsx', 'app/calendar/page.tsx', 'components/PreparedBoard.tsx', 'components/SourcesView.tsx']) {
    const s = src(p);
    assert.doesNotMatch(s, /fetch\('\/api\/posts'\)/, p + ' reads /api/posts on its own');
    assert.match(s, /fetchPosts\(\)/, p);
  }
  const bus = src('components/refreshBus.ts');
  assert.match(bus, /export function fetchPosts\(\): Promise<Response>/);
  assert.match(bus, /r\.clone\(\)/, 'each caller gets its own readable body');
});

test('a failed load on the calendar is not shown as an empty calendar', () => {
  const cal = src('app/calendar/page.tsx');
  assert.match(cal, /friendlyErrorFromResponse\(r, 'We could not load your scheduled posts/);
  assert.match(cal, /!loading && !loadFailed && posts\.length === 0/);
  assert.doesNotMatch(cal, /Failed to load posts \(/);
});
