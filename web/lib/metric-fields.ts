// web/lib/metric-fields.ts
// Reading a Metricool analytics row's date, network and stable key.
//
// Nothing in this repository pins the shape of /v2/analytics/posts, so
// lib/performance.ts guesses field names. Two rules, kept apart on purpose:
//
//   THE KEY  post_metrics is unique on (user_id, network, external_id), and an
//            id-less row's external_id is a hash of its network, raw date and
//            text. Every re-sync must produce the SAME key for the same post,
//            or the upsert inserts a second row beside the first and every
//            reader (top performers, keyword_performance, the strategy panel)
//            counts the post twice. So the network and the hashed date are
//            exactly what they always were: raw, not lower-cased, not
//            normalised. Matching lower-cases on READ (lib/strategy-performance.ts).
//   THE DATE the stored published_at column. Metricool's scheduler API sends
//            publicationDate as an object, { dateTime, timezone }; stored
//            as-is into a timestamptz that failed the whole upsert, and the
//            cron swallows the error. That column — not the key — is
//            normalised to ISO or null.
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

/**
 * The network as stored — part of the row's key, so exactly as it always was:
 * the first of network / provider / platform, raw, or 'unknown'. (Not `type`:
 * on analytics rows that is usually the post format — IMAGE, REEL.)
 */
export function metricNetwork(row: Record<string, unknown> | null | undefined): string {
  if (!row) return 'unknown';
  for (const k of ['network', 'provider', 'platform']) {
    if (row[k] != null) return String(row[k]);
  }
  return 'unknown';
}

/** What an id-less row's synthetic id hashes: unchanged, so re-syncs keep the same key. */
export function syntheticBasis(network: string, rawDate: unknown, text: string | null): string {
  return [network, rawDate ?? '', (text ?? '').slice(0, 200)].join('|');
}
