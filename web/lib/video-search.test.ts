import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { filterVideos, matchesVideoSearch } from './video-search.ts';

const videos = [
  { row: 159, title: 'Reel_MuseCellsDrRoni_Rodrigo.mp4', copy: 'Over 200 studies look at muse cells.', tab: '2026 CELLULAR HOPE' },
  { row: 160, title: 'Reel_OxygenDrRoni_Rodrigo.mp4', copy: 'Oxygen and inflammation.', tab: '2026 CELLULAR HOPE' },
  { row: 200, title: 'Reel_Exosomes_Rodrigo.mp4', copy: 'Exosomes explained.', tab: '2026 CELLULAR HOPE' },
  { row: 2000, title: 'Reel_Far.mp4', copy: '', tab: '2026 CELLULAR HOPE' },
];

test('a number finds that row and nothing else — no scrolling for it', () => {
  assert.deepEqual(filterVideos(videos, '200').map((v) => v.row), [200], 'not row 159 whose copy says "200", not row 2000');
  assert.deepEqual(filterVideos(videos, ' 160 ').map((v) => v.row), [160]);
  assert.deepEqual(filterVideos(videos, 'row 200').map((v) => v.row), [200]);
  assert.deepEqual(filterVideos(videos, '999'), []);
});

test('words still search the title, copy and tab', () => {
  assert.deepEqual(filterVideos(videos, 'oxygen').map((v) => v.row), [160]);
  assert.deepEqual(filterVideos(videos, 'MUSE').map((v) => v.row), [159]);
  assert.equal(filterVideos(videos, '').length, 4);
  assert.equal(matchesVideoSearch({ row: 5 }, 'x'), false);
});

test('the Video Library uses it, and says how many match', () => {
  const view = readFileSync(new URL('../components/SourcesView.tsx', import.meta.url), 'utf8');
  assert.match(view, /filterVideos\(videos\?\.entries \|\| \[\], q\)/);
  assert.match(view, /filteredVideos\.length \+ ' of ' \+ videos\.entries\.length/);
});
