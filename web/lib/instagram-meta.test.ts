// A video on Instagram is a Reel — Meta refuses the old feed VIDEO type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { anyVideo, instagramDataFor } from './instagram-meta.ts';

const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('a video is sent as a Reel shown on the feed; a picture as a post', () => {
  assert.deepEqual(instagramDataFor({ hasVideo: true }), { type: 'REEL', showReelOnFeed: true });
  assert.deepEqual(instagramDataFor({ hasVideo: false }), { type: 'POST' });
  assert.equal(anyVideo(['https://x/a.jpg', 'https://x/b.mp4']), true);
  assert.equal(anyVideo(['https://x/a.jpg', null]), false);
});

test('wiring: every Metricool call for an Instagram post carries instagramData', () => {
  // The first send.
  const schedule = src('app/api/metricool/schedule/route.ts');
  assert.match(schedule, /if \(provider === 'instagram'\) body\.instagramData = instagramDataFor\(\{ hasVideo: /);
  // The approve / move / fix replace, and the resend after a 404.
  const posts = src('app/api/posts/route.ts');
  assert.match(posts, /const instagramData = providersLower\.includes\('instagram'\)\n\s*\? instagramDataFor\(\{ hasVideo: Boolean\(existing\.media_drive_file_id\) \|\| anyVideo\(media\) \}\)/);
  assert.equal((posts.match(/\n\s+instagramData,\n/g) || []).length, 2, 'the replace and the resend');
  // The client passes it through, only for a post that goes to Instagram.
  const client = src('lib/metricool.ts');
  assert.match(client, /\.\.\.\(input\.instagramData && input\.providers\.includes\('instagram'\) \? \{ instagramData: input\.instagramData \} : \{\}\)/);
  const body = src('lib/metricool-post.ts');
  assert.match(body, /\.\.\.\(post\.instagramData && providers\.includes\('instagram' as Provider\) \? \{ instagramData: post\.instagramData \} : \{\}\)/);
});
