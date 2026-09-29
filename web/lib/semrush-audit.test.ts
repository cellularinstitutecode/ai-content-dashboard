// The Site Audit card read "—" for everything while Semrush showed 91%.
// These fixtures are the real answers for the clinic's project (trimmed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { auditTime, healthCachePhrase, parseAuditHealth, parseAuditInfo, unwrapEnvelope } from './semrush-audit.ts';

const MCP_INFO = {
  data: {
    id: 30620784, url: 'www.cellularhopeinstitute.com', status: 'FINISHED',
    errors: 0, warnings: 233, notices: 494, healthy: 11, haveIssues: 78,
    last_audit: 1787851302896, pages_crawled: 100, pages_limit: 100,
  },
  metadata: { format: 'json', usage: { api_units: 100 } },
};

const MCP_HISTORY = {
  data: {
    data: [
      { quality: { value: 91, delta: 0 }, snapshot_id: '6a9070ab628706f8f1f74170', pages_crawled: 100, finish_date: 1787851302896 },
      { quality: { value: 87, delta: 0 }, snapshot_id: '6a6a41183bfffa0de6798d14', pages_crawled: 100, finish_date: 1785348854063 },
    ],
    total: 2, limit: 1, offset: 0,
  },
  metadata: { format: 'json', usage: { api_units: 10000 } },
};

test('the MCP envelope is unwrapped; a v3 body passes through', () => {
  assert.equal((unwrapEnvelope(MCP_INFO) as { warnings: number }).warnings, 233);
  const v3 = { errors: 1, warnings: 2 };
  assert.equal(unwrapEnvelope(v3), v3);
  assert.equal(unwrapEnvelope(null), null);
});

test('info: the counts the card shows, from either transport', () => {
  const a = parseAuditInfo(MCP_INFO);
  assert.equal(a.errors, 0, 'zero errors is a number, not a dash');
  assert.equal(a.warnings, 233);
  assert.equal(a.notices, 494);
  assert.equal(a.pagesCrawled, 100);
  assert.equal(a.pagesHealthy, 11);
  assert.equal(a.pagesWithIssues, 78);
  assert.equal(a.status, 'FINISHED');
  assert.equal(a.lastAuditMs, 1787851302896);
  const v3 = parseAuditInfo(MCP_INFO.data);
  assert.equal(v3.warnings, 233);
});

test('the audit date is milliseconds, not seconds times a thousand', () => {
  assert.equal(auditTime(1787851302896), new Date(1787851302896).toISOString());
  assert.match(String(auditTime(1787851302896)), /^2026-/);
  assert.match(String(auditTime(1787851302)), /^2026-/, 'an answer in seconds still reads right');
  assert.equal(auditTime(0), null);
  assert.equal(auditTime(null), null);
});

test('health: the newest audit\'s score from the history report', () => {
  assert.deepEqual(parseAuditHealth(MCP_HISTORY), { health: 91, healthDelta: 0, finishedMs: 1787851302896 });
  // v3: { data: [...] }; a single snapshot: the object itself.
  assert.equal(parseAuditHealth({ data: MCP_HISTORY.data.data }).health, 91);
  assert.equal(parseAuditHealth(MCP_HISTORY.data.data[0]).health, 91);
  assert.deepEqual(parseAuditHealth({}), { health: null, healthDelta: null, finishedMs: null });
});

test('the health score is kept per finished audit, so it is paid for once per audit', () => {
  assert.equal(healthCachePhrase('30620784', 1787851302896), '30620784:health:1787851302896');
  assert.equal(healthCachePhrase('30620784', null), null);
  assert.equal(healthCachePhrase('', 1), null);
});

test('siteAudit reads through these, and fetches the health score only for a new audit', () => {
  const src = readFileSync(new URL('./semrush-domain.ts', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function siteAudit('), src.indexOf('// Recursively hunt'));
  assert.match(fn, /parseAuditInfo\(json\)/);
  assert.match(fn, /healthCachePhrase\(id, info\.lastAuditMs\)/);
  assert.match(fn, /parseAuditHealth\(/);
  assert.doesNotMatch(fn, /\* 1000\)/, 'no second conversion of an already-millisecond stamp');
  assert.match(src, /unwrapEnvelope\(json\)/, 'the tracking report is unwrapped too');
});

test('the Site Audit card is gone from the panel, and the panel no longer pays for its data', () => {
  const panel = readFileSync(new URL('../app/SemrushPanel.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /tag="Site Audit"/, 'removed at the team\'s request');
  assert.doesNotMatch(panel, /label="Site Health"/);
  const route = readFileSync(new URL('../app/api/semrush/route.ts', import.meta.url), 'utf8');
  const project = route.slice(route.indexOf("if (action === 'project')"), route.indexOf("if (!topic)"));
  assert.doesNotMatch(project, /siteAudit\(/, 'the project action serves Position Tracking only');
  assert.match(project, /trackingSummary\(domain\)/);
});
