// web/lib/semrush-audit.ts
// Reading Semrush's Site Audit answers — the pure part.
//
// The dashboard's Site Audit card showed a dash for everything (health,
// errors, warnings, notices, pages) while Semrush itself showed 91% and 233
// warnings. The request was succeeding; the reading was not:
//
//  1. The MCP transport wraps every report as { data: {...}, metadata: {...} }.
//     The reader looked for `errors`, `warnings`… at the top level and found
//     none, so every figure came back null — with the "ok" flag set, so the
//     card drew the empty dial instead of saying anything was wrong.
//  2. The site's health score is not in the `info` report at all. It lives in
//     the audit history (`quality.value`), a report Semrush bills at 10,000
//     units against `info`'s 100. It only changes when a new audit finishes
//     (about monthly here), so it is fetched once per finished audit and kept
//     against that audit's finish time — see lib/semrush-domain.ts siteAudit.
//  3. `last_audit` is already in milliseconds; it was multiplied by 1000 again.
//
// No imports: the test runner strips types and runs this file directly.

/** Unwrap the MCP transport's { data, metadata } envelope; a v3 body passes through. */
export function unwrapEnvelope(json: unknown): unknown {
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    if ('data' in o && 'metadata' in o && o.data && typeof o.data === 'object') return o.data;
  }
  return json;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A Semrush audit timestamp (milliseconds; seconds in some older answers) as ISO, or null. */
export function auditTime(v: unknown): string | null {
  const n = num(v);
  if (n == null || n <= 0) return null;
  // Anything below 10^11 is seconds (that is the year 5138 in milliseconds).
  const ms = n < 1e11 ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

export type AuditInfo = {
  status: string | null;
  errors: number | null;
  warnings: number | null;
  notices: number | null;
  pagesCrawled: number | null;
  pagesHealthy: number | null;
  pagesWithIssues: number | null;
  /** The finished audit these counts belong to, as Semrush stamps it (ms). */
  lastAuditMs: number | null;
  lastAudit: string | null;
  /** Present on some answers; the history report is the usual source. */
  health: number | null;
  healthDelta: number | null;
};

/** The `info` report, from either transport. */
export function parseAuditInfo(json: unknown): AuditInfo {
  const o = (unwrapEnvelope(json) || {}) as Record<string, unknown>;
  const q = (o.quality && typeof o.quality === 'object' ? o.quality : {}) as Record<string, unknown>;
  const lastMs = num(o.last_audit);
  return {
    status: typeof o.status === 'string' ? o.status : null,
    errors: num(o.errors),
    warnings: num(o.warnings),
    notices: num(o.notices),
    pagesCrawled: num(o.pages_crawled),
    pagesHealthy: num(o.healthy),
    pagesWithIssues: num(o.haveIssues),
    lastAuditMs: lastMs != null && lastMs > 0 ? (lastMs < 1e11 ? lastMs * 1000 : lastMs) : null,
    lastAudit: auditTime(o.last_audit),
    health: num(q.value),
    healthDelta: num(q.delta),
  };
}

/**
 * The newest audit's health score from the `history` report (or a single
 * `snapshot`): { quality: { value, delta } }. MCP nests the list one level
 * deeper ({ data: { data: [...] } }); v3 answers { data: [...] }.
 */
export function parseAuditHealth(json: unknown): { health: number | null; healthDelta: number | null; finishedMs: number | null } {
  let body = unwrapEnvelope(json) as unknown;
  if (body && typeof body === 'object' && !Array.isArray(body) && Array.isArray((body as Record<string, unknown>).data)) {
    body = (body as Record<string, unknown>).data;
  }
  const first = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
  if (!first || typeof first !== 'object') return { health: null, healthDelta: null, finishedMs: null };
  const q = (first.quality && typeof first.quality === 'object' ? first.quality : {}) as Record<string, unknown>;
  const fin = num(first.finish_date);
  return { health: num(q.value), healthDelta: num(q.delta), finishedMs: fin != null && fin > 0 ? fin : null };
}

/** The cache phrase the health score is kept under: one per finished audit. */
export function healthCachePhrase(projectId: string, lastAuditMs: number | null): string | null {
  if (!projectId || lastAuditMs == null) return null;
  return projectId + ':health:' + lastAuditMs;
}
