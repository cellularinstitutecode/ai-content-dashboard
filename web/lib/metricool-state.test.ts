// What Metricool says a post is, and what that makes our row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { describeAnswer, indexByPostId, metricoolDateTime, reconcileStatus, remoteStateOf } from './metricool-state.ts';
import { postStatusMeta } from './post-mode.ts';

test('the state is read off whichever field Metricool put it in', () => {
  // The flag this app writes.
  assert.equal(remoteStateOf({ id: 1, draft: true, autoPublish: false }), 'review');
  assert.equal(remoteStateOf({ id: 1, draft: false, autoPublish: true }), 'scheduled');
  // The network's own status, as app/api/assistant/route.ts already read it.
  // PENDING is what Metricool says about a draft this app created, so on
  // its own it decides nothing — only the draft flag tells the queues apart.
  assert.equal(remoteStateOf({ id: 1, providers: [{ network: 'instagram', status: 'PENDING' }] }), 'unknown');
  assert.equal(remoteStateOf({ id: 1, draft: true, providers: [{ network: 'instagram', status: 'PENDING' }] }), 'review');
  assert.equal(remoteStateOf({ id: 1, draft: false, providers: [{ network: 'instagram', status: 'PENDING' }] }), 'scheduled');
  assert.equal(remoteStateOf({ id: 1, status: 'SCHEDULED' }), 'unknown');
  assert.equal(remoteStateOf({ id: 1, providers: [{ network: 'instagram', status: 'PUBLISHED' }] }), 'published');
  assert.equal(remoteStateOf({ id: 1, providers: [{ network: 'instagram', status: 'ERROR' }] }), 'failed');
  assert.equal(remoteStateOf({ id: 1, providers: [{ network: 'instagram', status: 'DRAFT' }] }), 'review');
  // A top-level status, and the envelope.
  assert.equal(remoteStateOf({ data: { id: 1, status: 'Published' } }), 'published');
  assert.equal(remoteStateOf({ id: 1, status: 'with errors' }), 'failed');
  // A published URL is proof whatever the flags say.
  assert.equal(remoteStateOf({ id: 1, draft: true, providers: [{ network: 'tiktok', publishedUrl: 'https://t/1' }] }), 'published');
  // Published on one network wins over an error on another: it is out.
  assert.equal(remoteStateOf({ id: 1, providers: [{ status: 'PUBLISHED' }, { status: 'ERROR' }] }), 'published');
  // Nothing readable changes nothing.
  assert.equal(remoteStateOf({ id: 1, text: 'hi' }), 'unknown');
  assert.equal(remoteStateOf(null), 'unknown');
});

test('our row follows Metricool, and only in the directions that are safe', () => {
  // Approved in Metricool's planner: the Approve button here goes away.
  assert.equal(reconcileStatus('pending_review', 'scheduled'), 'approved');
  assert.equal(reconcileStatus('approved', 'scheduled'), null);
  // Out: Posted.
  assert.equal(reconcileStatus('pending_review', 'published'), 'published');
  assert.equal(reconcileStatus('approved', 'published'), 'published');
  assert.equal(reconcileStatus('published', 'published'), null);
  // Failed there: needs attention here. A post that went out never regresses.
  assert.equal(reconcileStatus('approved', 'failed'), 'failed');
  assert.equal(reconcileStatus('published', 'failed'), null);
  // Still a draft there while approved here: back to waiting, so a move
  // cannot send it live on our word alone (lib/post-mode.ts).
  assert.equal(reconcileStatus('approved', 'review'), 'pending_review');
  assert.equal(reconcileStatus('pending_review', 'review'), null);
  // Unknown: untouched.
  assert.equal(reconcileStatus('pending_review', 'unknown'), null);
});

test('the list is keyed by id whatever it is wrapped in', () => {
  assert.deepEqual([...indexByPostId([{ id: 1 }, { postId: '2' }, { text: 'no id' }]).keys()], ['1', '2']);
  assert.deepEqual([...indexByPostId({ data: [{ id: 'a' }] }).keys()], ['a']);
  assert.deepEqual([...indexByPostId({ posts: [{ id: 'b' }] }).keys()], ['b']);
  assert.deepEqual([...indexByPostId({ data: { posts: [{ id: 'c' }] } }).keys()], ['c'], 'two envelopes deep');
  assert.equal(indexByPostId(null).size, 0);
});

test('the record describes the answer without its text', () => {
  const line = describeAnswer({ data: [{ id: 1, text: 'SECRET COPY', draft: true, providers: [{ network: 'tiktok', status: 'PENDING' }] }] });
  assert.match(line, /^queue: 1 posts; keys=id,text,draft,providers; draft=true autoPublish=undefined status=; provider keys=network,status status=PENDING; state=review$/);
  assert.doesNotMatch(line, /SECRET/);
  assert.equal(describeAnswer({ error: 'nope' }), 'queue: 0 posts (top-level: error)');
});

test('a post that went out reads Posted', () => {
  assert.deepEqual(postStatusMeta('published'), { label: 'Posted', tone: 'green' });
});

test('wiring: the queue read brings every row into line with Metricool before it is shown', () => {
  const src = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const route = src('app/api/posts/route.ts');
  const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function PATCH'));
  assert.match(get, /metricoolQueue\(ALLOWED_BLOG_IDS, new Date\(since\)/, 'every brand profile, the same window as the rows');
  assert.match(get, /reconcileStatus\(p\.status, remoteStateOf\(mc\)\)/);
  assert.match(get, /p\.status = next;/, 'the response carries the corrected status');
  assert.match(get, /sb\.from\('posts'\)\.update\(\{ status \}\)\.eq\('id', id\)\.eq\('user_id', user\.id\)/, 'and the row is corrected for every other screen');
  // The month grid names the state of a post nobody is still asked about.
  const cal = src('components/QueueCalendar.tsx');
  assert.match(cal, /postStatusMeta\(p\.status\)/);
  assert.match(cal, /\{meta && <span[^>]*>\{meta\.label\}<\/span>\}/);
});

test('the list range is sent as the date-time Metricool asks for, not a bare date', () => {
  // Its 400 on the first read: "Invalid value '2026-09-25'. Valid format is:
  // date-time in format yyyy-MM-dd'T'HH:mm:ss".
  const d = new Date(2026, 8, 25, 7, 5, 9);
  assert.equal(metricoolDateTime(d), '2026-09-25T07:05:09');
  const queue = readFileSync(new URL('./metricool-queue.ts', import.meta.url), 'utf8');
  assert.match(queue, /'\?start=' \+ encodeURIComponent\(metricoolDateTime\(start\)\) \+ '&end=' \+ encodeURIComponent\(metricoolDateTime\(end\)\)/);
  const insights = readFileSync(new URL('../app/api/metricool/insights/route.ts', import.meta.url), 'utf8');
  assert.match(insights, /'\/v2\/scheduler\/posts\?' \+ q \+ '&start=' \+ encodeURIComponent\(metricoolDateTime\(now\)\)/, 'the insights scheduler range had the same bug');
});
