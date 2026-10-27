// web/lib/posts-media-wiring.test.ts
// The approve / move / fix door finds a post's video by the COPY's id.
//
// posts.media_drive_file_id holds the copy's marker, never the source video's
// id; the door handed it to cachedPublicCopy (a lookup by source id), found
// nothing, and replaced the post with no video — Metricool refused the Reel and
// a move of row 224 went nowhere. Source check: the route cannot be loaded by
// the test runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a post\u2019s video is found by public_copy_id first, re-minted, with the source-id lookup only as the fallback', () => {
  const route = src('app/api/posts/route.ts');
  assert.match(route, /const byCopy = await publicCopyById\(copyId\);/);
  assert.match(route, /byCopy \? freshCopyUrl\(byCopy\.id, byCopy\.url, byCopy\.videoId\) : \(\(await cachedPublicCopy\(copyId\)\)\?\.url \?\? null\)/);
  const cache = src('lib/transcript-cache.ts');
  assert.match(cache, /export async function publicCopyById/);
  assert.match(cache, /\.eq\('public_copy_id', key\)/);
});
