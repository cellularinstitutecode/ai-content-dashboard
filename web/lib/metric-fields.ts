// web/lib/metric-fields.ts
// Reading the two fields of a Metricool analytics row that the rest of the
// app joins on: when it was published, and on which network.
//
// Nothing in this repository pins the shape of /v2/analytics/posts, so
// lib/performance.ts guesses field names. Two guesses could fail silently:
//
//   the date   Metricool's scheduler API sends `publicationDate` as an object,
//              { dateTime, timezone }. Stored as-is into a timestamptz column,
//              that failed the whole upsert, and the cron swallows the error.
//   the network  a row naming it under another key was stored as 'unknown',
//              and nothing could ever be matched to the post it came from.
//
// Pure: no imports, so the test runner reads it directly.

/** An ISO timestamp from a string, a number, or an object carrying dateTime/date; null when unreadable. */
export function metricDate(v: unknown): string | null {
  let raw: unknown = v;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    raw = o.dateTime ?? o.datetime ?? o.date ?? o.value ?? null;
  }
  if (raw == null || raw === '') return null;
  const d = typeof raw === 'number' ? new Date(raw < 1e12 ? raw * 1000 : raw) : new Date(String(raw));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** The network a row names, lower-cased; 'unknown' only when it names none. */
export function metricNetwork(row: Record<string, unknown> | null | undefined): string {
  if (!row) return 'unknown';
  for (const k of ['network', 'provider', 'platform', 'socialNetwork', 'social_network', 'type']) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase();
  }
  return 'unknown';
}
