// web/lib/metricool-networks.ts
// Which of a template's channels Metricool can actually post to.
//
// WHY THIS IS ITS OWN FILE. `providers` is a text[] column filled in by a
// person clicking toggles, and the toggles include `blog` — which is not a
// Metricool network at all, it is a WordPress article. Three places send that
// column onward, and two of them cast it straight to `Provider[]` with no
// filter, so one `blog` entry can fail a whole multi-network call and take the
// real networks down with it.
//
// The third place, approveRun, filters correctly. So this is that filter,
// lifted out to where the other two can use it and where it can be tested:
// lib/metricool.ts pulls in half the app through `@/` aliases and cannot be
// loaded by the test runner.
//
// Pure: no imports, so the test runner reads this file directly.

/**
 * The ten networks Metricool posts to.
 *
 * One definition: lib/metricool.ts derives its `Provider` type from this, so
 * the list and the type cannot drift.
 */
export const MC_NETWORKS = [
  'instagram',
  'facebook',
  'twitter',
  'linkedin',
  'tiktok',
  'youtube',
  'gmb',
  'pinterest',
  'threads',
  'bluesky',
] as const;

export type McNetwork = (typeof MC_NETWORKS)[number];

/** Everything else a template may carry. Today that is one thing. */
export const BLOG_CHANNEL = 'blog';

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Is this one of the ten? */
export function isMetricoolNetwork(value: unknown): value is McNetwork {
  return (MC_NETWORKS as readonly string[]).includes(clean(value));
}

/**
 * The channels Metricool can take, cleaned and deduplicated.
 *
 * Order is the caller's, because the first entry decides which variant of the
 * copy is sent (see approveRun) and a person's own ordering is meaningful.
 */
export function metricoolNetworks(raw: unknown): McNetwork[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: McNetwork[] = [];
  for (const entry of list) {
    const value = clean(entry);
    if (!isMetricoolNetwork(value)) continue;
    if (!out.includes(value as McNetwork)) out.push(value as McNetwork);
  }
  return out;
}

/** The channels Metricool cannot take — `blog`, and anything unrecognised. */
export function otherChannels(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const entry of list) {
    const value = clean(entry);
    if (!value || isMetricoolNetwork(value)) continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

/** Does this template publish an article? */
export function wantsBlog(raw: unknown): boolean {
  return otherChannels(raw).includes(BLOG_CHANNEL);
}
