import test from 'node:test';
import assert from 'node:assert/strict';
import { packVideoId, resolvePostSources, videoIdOf } from './post-source.ts';

const SHEET = '1ScDpPq7MwSg5HSr9DT2PVdYbu_kTxWMSDp1jG5GLyyc';
const drive = (id: string) => 'https://drive.google.com/file/d/' + id + '/view?usp=drive_link';
// Real Drive ids are 20+ characters; the parser refuses anything shorter.
const V1 = '1jX1Ww2M18iH6-5eM4YLZR9HKa1-PbZFo';
const V2 = '1FXHcH40kYxJFaFLfM4Y6fzCDQLV4qDW';
const V3 = '1qWDxKLos0zjK0wWugw0xlASWZez4lFoU';
const OTHER = '15LO04M7jLEQfuo57M8ZcYrI3hhjPWp0';

test('a video id is read out of a Drive link, and a bare id is itself', () => {
  assert.equal(videoIdOf(drive(V1)), V1);
  assert.equal(videoIdOf(V1), V1);
  assert.equal(videoIdOf('  '), null);
  assert.equal(packVideoId({ videoId: V1, sourceUrl: drive(V2) }), V1);
  assert.equal(packVideoId({ sourceUrl: drive(V2) }), V2);
  assert.equal(packVideoId({ video: drive(V3) }), V3);
  assert.equal(packVideoId({}), null);
});

test('tier 1: the run recorded for the draft, newest first when rows share a draft', () => {
  const sources = resolvePostSources({
    posts: [{ id: 'p1', draft_id: 'd1' }],
    packs: {},
    runs: [
      { draft_id: 'd1', spreadsheet_id: SHEET, tab: 'T', row_number: 180, video_title: 'old', updated_at: '2026-09-01T00:00:00Z' },
      { draft_id: 'd1', spreadsheet_id: SHEET, tab: 'T', row_number: 183, video_title: 'new', updated_at: '2026-09-15T00:00:00Z' },
    ],
    copyToVideo: {},
    register: [],
  });
  assert.deepEqual(sources.get('p1'), { spreadsheetId: SHEET, tab: 'T', row: 183, gid: null, title: 'new' });
});

test('tier 2: no run for the draft, but a run for the same source video', () => {
  const sources = resolvePostSources({
    posts: [{ id: 'p1', draft_id: 'dX' }],
    packs: { dX: { kind: 'video', videoId: V1, sourceUrl: drive(V1) } },
    runs: [{ draft_id: 'dOther', spreadsheet_id: SHEET, tab: 'T', row_number: 179, video_title: 'Reel', video_link: drive(V1) }],
    copyToVideo: {},
    register: [],
  });
  assert.equal(sources.get('p1')?.row, 179);
});

test('tier 3: a composer post with no draft, found through its public copy', () => {
  const sources = resolvePostSources({
    posts: [{ id: 'p1', draft_id: null, media_drive_file_id: 'copy9' }],
    packs: {},
    runs: [{ draft_id: null, spreadsheet_id: SHEET, tab: 'T', row_number: 179, video_title: 'Reel', video_link: drive(V1) }],
    copyToVideo: { copy9: V1 },
    register: [],
  });
  assert.equal(sources.get('p1')?.row, 179);
});

test('tier 4: no run at all, but the register knows the row (newest line wins, gid kept)', () => {
  const sources = resolvePostSources({
    posts: [{ id: 'p1', draft_id: 'd1' }],
    packs: { d1: { videoId: V1 } },
    runs: [],
    copyToVideo: {},
    register: [
      { videoKey: SHEET + '|T|k', title: 'Reel', link: drive(V1), event: 'first_seen', detail: { tab: 'T', row: 181, gid: 55 }, created_at: '2026-09-01T00:00:00Z' },
      { videoKey: SHEET + '|T|k', title: 'Reel', link: drive(V1), event: 'queued', detail: { tab: 'T', row: 182, gid: 55 }, created_at: '2026-09-15T00:00:00Z' },
      // A line without a row cannot identify one, however new it is.
      { videoKey: 'drive|vid1', title: 'Reel', link: drive(V1), event: 'copy_made', detail: {}, created_at: '2026-09-16T00:00:00Z' },
    ],
  });
  assert.deepEqual(sources.get('p1'), { spreadsheetId: SHEET, tab: 'T', row: 182, gid: 55, title: 'Reel' });
});

test('no video and no run: no row, rather than a wrong one', () => {
  const sources = resolvePostSources({
    posts: [{ id: 'hand', draft_id: null }, { id: 'tmpl', draft_id: 'dT' }],
    packs: { dT: { kind: 'template' } },
    runs: [{ draft_id: 'dZ', spreadsheet_id: SHEET, tab: 'T', row_number: 190, video_link: drive(OTHER) }],
    copyToVideo: {},
    register: [{ videoKey: SHEET + '|T|k', link: drive(OTHER), event: 'first_seen', detail: { tab: 'T', row: 190 } }],
  });
  assert.equal(sources.has('hand'), false);
  assert.equal(sources.has('tmpl'), false);
});
