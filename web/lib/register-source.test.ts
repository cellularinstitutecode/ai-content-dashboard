import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSource } from './register-source.ts';
import { sheetRowLabel, sheetRowUrl } from './sheet-link.ts';
import { videoKeyFor, driveVideoKey } from './video-event.ts';

const SHEET = '1ScDpPq7MwSg5HSr9DT2PVdYbu_kTxWMSDp1jG5GLyyc';

test('an entry the sweep wrote today links straight to its row', () => {
  const src = registerSource({
    videoKey: videoKeyFor(SHEET, 'Marzo', 'abc'),
    title: 'Reel_Shoulder2Ryall_Rodrigo',
    detail: { tab: 'Marzo', row: 179, gid: 412 },
  });
  assert.deepEqual(src, { spreadsheetId: SHEET, tab: 'Marzo', row: 179, gid: 412, title: 'Reel_Shoulder2Ryall_Rodrigo' });
  assert.equal(sheetRowLabel(src), 'Marzo · row 179');
  assert.equal(sheetRowUrl(src), 'https://docs.google.com/spreadsheets/d/' + SHEET + '/edit#gid=412&range=A179');
});

test('the thirty-three entries already in the register (no gid yet) still show their row number', () => {
  const src = registerSource({ videoKey: videoKeyFor(SHEET, 'Marzo', 'abc'), detail: { tab: 'Marzo', row: 180 } });
  assert.ok(src);
  assert.equal(src.gid, null);
  assert.equal(sheetRowLabel(src), 'Marzo · row 180');
  // Without a gid the link opens the document, never a guessed tab.
  assert.equal(sheetRowUrl(src), 'https://docs.google.com/spreadsheets/d/' + SHEET + '/edit');
});

test('the tab falls back to the one inside the key', () => {
  const src = registerSource({ videoKey: videoKeyFor(SHEET, 'Abril', 'k'), detail: { row: 12 } });
  assert.equal(src?.tab, 'Abril');
  assert.equal(src?.row, 12);
});

test('a Drive-only key has no row to point at, so no chip', () => {
  assert.equal(registerSource({ videoKey: driveVideoKey('1AbCdEfGhIjKlMnOpQrStUvWxYz012345'), detail: { copyId: 'x' } }), null);
  assert.equal(registerSource({ videoKey: '', detail: { row: 5 } }), null);
  assert.equal(registerSource(null), null);
  assert.equal(registerSource(undefined), null);
});

test('junk never becomes a row', () => {
  for (const row of ['abc', -3, 0, 1, NaN, {}, null]) {
    const src = registerSource({ videoKey: videoKeyFor(SHEET, 'Marzo', 'k'), detail: { tab: 'Marzo', row } });
    assert.ok(src, 'the tab alone still identifies the entry for ' + JSON.stringify(row));
    assert.equal(src.row, null, JSON.stringify(row) + ' was accepted as a row');
    assert.equal(sheetRowLabel(src), 'Marzo');
  }
  // A row typed as a string is fine; the API may serialise numbers either way.
  assert.equal(registerSource({ videoKey: videoKeyFor(SHEET, 'Marzo', 'k'), detail: { row: '183' } })?.row, 183);
  assert.equal(registerSource({ videoKey: videoKeyFor(SHEET, 'Marzo', 'k'), detail: { row: 12.9, gid: '7' } })?.gid, 7);
});
