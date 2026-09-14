// web/lib/storage-prune.ts
// Which objects in the image bucket are still wanted, and which are not.
//
// THE PROBLEM. Every image the app has ever stored is still in the bucket.
// storeBytes (lib/images.ts) writes each upload under a unique random name —
// on purpose: the bucket is public, and a guessable name leaked pictures — so
// its `upsert: true` can never replace anything. Regenerating a hero image
// leaves the old one behind. Re-rendering a carousel leaves eight behind.
// Deleting a draft deleted the row and nothing else. Nothing in the app could
// list the bucket, so an orphan was invisible as well as permanent, and the
// project ran into its storage allowance.
//
// This module is the ONE place that decides what "unwanted" means, so the rule
// is testable and every delete in the app goes through the same definition:
//
//   an object is REFERENCED when its name appears anywhere in a draft's pack —
//   `_image.url`, a card in `_cards.slides[]`, or any field somebody adds later.
//   The match is against the pack's whole JSON, not a list of known fields,
//   because a delete that under-matches destroys a picture a post still needs
//   and a delete that over-matches merely keeps a file a little longer.
//
//   an object is an ORPHAN when it is not referenced by any pack AND is older
//   than a floor. The floor exists because a URL is returned to the browser
//   BEFORE anything persists it (import_image), so a brand-new object is
//   legitimately unreferenced for a few seconds. Seven days makes that race
//   impossible and costs nothing.
//
// Pure and import-free: the test runner strips types and runs this file
// directly, and a rule that deletes the wrong file is worse than no rule.

/** Something in the bucket, as Storage lists it. */
export type StoredObject = {
  /** The object's name relative to the prefix it was listed under. */
  name: string;
  /** ISO timestamp. Missing means "unknown", which is treated as too new to touch. */
  createdAt?: string | null;
  /** Bytes, when Storage reports them. */
  size?: number | null;
};

/** Seven days. See the header for why there is a floor at all. */
export const ORPHAN_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The object key inside `bucket` that a public URL points at, or null.
 *
 * Supabase public URLs have the shape
 *   https://<project>.supabase.co/storage/v1/object/public/<bucket>/<key>
 * and the key may carry a query string (cache busters) that is not part of
 * the name. Percent-encoding is undone so a key with a space matches what
 * Storage lists.
 */
export function objectKeyFromUrl(url: unknown, bucket: string): string | null {
  const s = String(url ?? '').trim();
  if (!s || !bucket) return null;
  const marker = '/object/public/' + bucket + '/';
  const at = s.indexOf(marker);
  if (at < 0) return null;
  let key = s.slice(at + marker.length);
  const q = key.search(/[?#]/);
  if (q >= 0) key = key.slice(0, q);
  try { key = decodeURIComponent(key); } catch { /* keep as-is */ }
  key = key.trim();
  return key ? key : null;
}

/**
 * Every object key in `bucket` that appears ANYWHERE in these packs.
 *
 * Scans the JSON text rather than known fields (see the header). A pack that
 * is not an object contributes nothing; a pack that cannot be serialised is
 * treated as referencing nothing it can prove — callers that must not delete
 * on doubt should check `referencedKeys` against a packs count they trust.
 */
export function referencedKeys(packs: Iterable<unknown>, bucket: string): Set<string> {
  const out = new Set<string>();
  if (!bucket) return out;
  const marker = '/object/public/' + bucket + '/';
  const re = new RegExp(escapeRegExp(marker) + '([^"\'\\s\\\\?#]+)', 'g');
  for (const pack of packs) {
    if (!pack || typeof pack !== 'object') continue;
    let text: string;
    try { text = JSON.stringify(pack); } catch { continue; }
    for (const m of text.matchAll(re)) {
      let key = m[1];
      try { key = decodeURIComponent(key); } catch { /* keep as-is */ }
      if (key) out.add(key);
    }
  }
  return out;
}

/**
 * The keys a pack stopped referencing when it became `next`.
 *
 * This is what "regenerate replaces instead of accumulates" means in practice:
 * store the new object, write the new pack, then remove whatever the OLD pack
 * pointed at that the NEW one no longer does. Computed as a set difference
 * rather than "the old `_image.url`" because a card cover made with setHero
 * shares its URL with `_image` — deleting the superseded hero by name would
 * have deleted a card that is still on the draft.
 */
export function supersededKeys(prev: unknown, next: unknown, bucket: string): string[] {
  const before = referencedKeys([prev], bucket);
  const after = referencedKeys([next], bucket);
  return [...before].filter((k) => !after.has(k)).sort();
}

/**
 * The listed objects that nothing references and that are old enough to go.
 *
 * `keyOf` turns a listing entry into the key `referenced` uses — Storage lists
 * names relative to the prefix they were listed under, so a caller listing
 * `packs/` passes `(o) => 'packs/' + o.name`.
 *
 * An object with no usable timestamp is never an orphan: "unknown age" must
 * not be read as "old".
 */
export function orphanObjects<T extends StoredObject>(
  objects: Iterable<T>,
  referenced: ReadonlySet<string>,
  keyOf: (o: T) => string,
  now: number,
  floorMs: number = ORPHAN_FLOOR_MS,
): T[] {
  const out: T[] = [];
  for (const o of objects) {
    const key = keyOf(o);
    if (!key || referenced.has(key)) continue;
    const t = Date.parse(String(o.createdAt ?? ''));
    if (!Number.isFinite(t)) continue;
    if (now - t < floorMs) continue;
    out.push(o);
  }
  return out;
}

/** Total bytes across a set of listed objects, treating unknown sizes as zero. */
export function totalBytes(objects: Iterable<StoredObject>): number {
  let n = 0;
  for (const o of objects) n += Math.max(0, Number(o.size) || 0);
  return n;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
