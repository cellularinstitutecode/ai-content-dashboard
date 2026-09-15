import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mayStartBatch, reasons, tally } from './batch-plan.ts';

const READY = { tab: 'Sept', hasAiColumns: true };
const NEEDS = { tab: 'Oct', hasAiColumns: false };

test('a tab that already has the columns runs whatever the plan call did', () => {
  // The common case, and the reason refusing is affordable: this sheet's tab has had
  // KEYWORDS/REF/ESTADO IA since the first successful run, so nothing here can be harmed
  // by a failed plan call.
  assert.deepEqual(mayStartBatch([READY], ['Sept'], 'the dashboard could not be reached'), { ok: true });
  assert.deepEqual(mayStartBatch([READY, READY], [], null), { ok: true });
});

test('a tab that NEEDS the columns refuses when they could not be added', () => {
  const out = mayStartBatch([NEEDS], ['Oct'], null);
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.reason : '', /Oct/);
  assert.match(out.ok === false ? out.reason : '', /two sets/);
});

test('a tab that needs the columns refuses when the plan call itself failed', () => {
  // The client cannot tell "columns fine, slots unavailable" from "columns never
  // ensured", and proceeding on that ambiguity is the race.
  const out = mayStartBatch([NEEDS], [], 'the dashboard could not be reached');
  assert.equal(out.ok, false);
  assert.equal(out.ok === false ? out.reason : '', 'the dashboard could not be reached');
});

test('a failure on a tab nobody selected does not stop the run', () => {
  assert.deepEqual(mayStartBatch([NEEDS], ['SomeOtherTab'], null), { ok: true });
});

test('one needy tab among ready ones stops everything', () => {
  // Not "run the ready ones and skip the rest": a partial batch with no explanation is
  // how a person ends up re-running the whole thing.
  const out = mayStartBatch([READY, NEEDS, READY], ['Oct'], null);
  assert.equal(out.ok, false);
});

test('an empty selection is not an error', () => {
  assert.deepEqual(mayStartBatch([], ['Oct'], 'boom'), { ok: true });
});

test('the live tally counts a run in progress, not just a finished one', () => {
  // summarise() counts what mapLimit returned, which only exists once every row is done —
  // so for the minutes a batch is running there was no aggregate anywhere, and the only
  // sign of life was per-row text a thousand pixels below the fold.
  assert.deepEqual(tally(['done', 'working', 'queued', 'failed', 'needs_transcript']), {
    total: 5, done: 1, failed: 1, needsTranscript: 1, pending: 2,
  });
});

test('nothing running tallies to nothing', () => {
  assert.equal(tally([]), null);
});

test('a finished run has nothing pending', () => {
  const t = tally(['done', 'done', 'failed']);
  assert.equal(t?.pending, 0);
  assert.equal(t?.done, 2);
});

test('a clean run has nothing to explain', () => {
  assert.deepEqual(reasons([{ state: 'done' }, { state: 'done' }]), { shown: [], more: 0 });
});

test('rows that are still going are not failures', () => {
  assert.deepEqual(reasons([{ state: 'queued' }, { state: 'working' }]), { shown: [], more: 0 });
});

test('one cause across several rows reads as one sentence', () => {
  // The case this exists for: two videos, one reason, said once.
  const out = reasons([
    { state: 'failed', note: 'The dashboard cannot open that Drive file.' },
    { state: 'failed', note: 'The dashboard cannot open that Drive file.' },
  ]);
  assert.deepEqual(out.shown.map((r) => r.text), ['The dashboard cannot open that Drive file.']);
  assert.equal(out.more, 0);
});

test('different causes are both named', () => {
  const out = reasons([
    { state: 'failed', note: 'Drive refused the download.' },
    { state: 'needs_transcript', note: 'Only a few words could be heard.' },
  ]);
  assert.equal(out.shown.length, 2);
  assert.ok(out.shown.some((r) => r.text === 'Only a few words could be heard.'));
});

test('a big batch reports the remainder rather than listing everything', () => {
  const out = reasons([
    { state: 'failed', note: 'One.' },
    { state: 'failed', note: 'Two.' },
    { state: 'failed', note: 'Three.' },
    { state: 'failed', note: 'Four.' },
  ]);
  assert.deepEqual(out.shown.map((r) => r.text), ['One.', 'Two.']);
  assert.equal(out.more, 2);
});

test('a long refusal is trimmed rather than pasted whole', () => {
  const out = reasons([{ state: 'failed', note: 'x'.repeat(400) }]);
  assert.ok(out.shown[0].text.length <= 150);
  assert.ok(out.shown[0].text.endsWith('…'));
});

test('a failure with no recorded note is skipped, not shown blank', () => {
  assert.deepEqual(reasons([{ state: 'failed' }, { state: 'failed', note: '   ' }]), { shown: [], more: 0 });
});

// --- every miss names its row ------------------------------------------------
import { rowLabelFromKey, rowList, runSummary, tallyRows } from './batch-plan.ts';

test('a reason carries the rows it applies to, in row order', () => {
  const out = reasons([
    { key: 'Marzo:190', state: 'failed', note: 'Interrupted — press Prepare again to finish this one.' },
    { key: 'Marzo:183', state: 'failed', note: 'Interrupted — press Prepare again to finish this one.' },
    { key: 'Marzo:185', state: 'done' },
  ]);
  assert.equal(out.shown.length, 1);
  assert.deepEqual(out.shown[0].rows.map((r) => r.label), ['row 183', 'row 190']);
  assert.deepEqual(out.shown[0].rows.map((r) => r.key), ['Marzo:183', 'Marzo:190']);
});

test('the row label names the tab only when the run spans more than one', () => {
  assert.equal(rowLabelFromKey('Marzo:183'), 'row 183');
  assert.equal(rowLabelFromKey('Marzo:183', true), 'Marzo · row 183');
  assert.equal(rowLabelFromKey('2026 CELLULAR HOPE:12', true), '2026 CELLULAR HOPE · row 12');
  assert.equal(rowLabelFromKey(undefined), '');
  assert.equal(rowLabelFromKey('nonsense'), 'nonsense');
  const two = reasons([
    { key: 'Marzo:183', state: 'failed', note: 'x' },
    { key: 'Abril:5', state: 'failed', note: 'x' },
  ]);
  assert.deepEqual(two.shown[0].rows.map((r) => r.label), ['Abril · row 5', 'Marzo · row 183']);
});

test('the tally knows which rows are behind each count', () => {
  const rows = tallyRows([
    { key: 'Marzo:183', state: 'failed', note: 'x' },
    { key: 'Marzo:184', state: 'needs_transcript', note: 'y' },
    { key: 'Marzo:185', state: 'queued' },
    { key: 'Marzo:186', state: 'done' },
  ]);
  assert.deepEqual(rows.failed.map((r) => r.label), ['row 183']);
  assert.deepEqual(rows.needsTranscript.map((r) => r.label), ['row 184']);
  assert.deepEqual(rows.pending.map((r) => r.label), ['row 185']);
  assert.equal(rowList(rows.failed), 'row 183');
  assert.equal(rowList([{ key: 'a:1', label: 'row 1' }, { key: 'a:2', label: 'row 2' }, { key: 'a:3', label: 'row 3' }, { key: 'a:4', label: 'row 4' }]), 'row 1, row 2, row 3 +1');
  assert.equal(rowList([]), '');
});

test('the run summary names every row that did not finish, with its reason', () => {
  const said = runSummary([
    { key: 'Marzo:180', state: 'done' },
    { key: 'Marzo:181', state: 'done' },
    { key: 'Marzo:190', state: 'needs_transcript', note: 'Only a few words could be heard.' },
    { key: 'Marzo:183', state: 'failed', note: 'Interrupted — press Prepare again to finish this one.' },
  ]);
  assert.equal(said, '2 written into the sheet · 1 need a transcript (row 190) · 1 not done (row 183: Interrupted — press Prepare again to finish this one.)');
  assert.equal(runSummary([]), 'Nothing to report.');
});
