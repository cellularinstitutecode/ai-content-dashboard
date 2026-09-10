// web/lib/pack-keys.ts
// Which keys the writer is told to fill in, and which it may leave empty.
//
// Every request used to demand all four — instagram, facebook, linkedin, blog —
// whatever the caller had asked for. For a video that meant writing a 250-400
// word mini-article into `blog` on every single run, the largest field in the
// object, which lib/video-prepare.ts then discarded unread. Roughly a third of
// the output budget spent on nothing.
//
// It stopped being merely wasteful when the house style grew: instagram and
// linkedin went to 800-1,100 characters of body each, with a REF line, an AVISO
// line and eleven hashtags apiece, and the whole object went past max_tokens.
// The answer truncated, parseJsonStrict called it malformed, the caller
// re-rolled, and the second attempt truncated in the same place.
//
// Pure and import-free: lib/ai.ts pulls in `server-only` and cannot be loaded by
// `node --experimental-strip-types --test`, and the one thing worth pinning here
// is that omitting `channels` leaves the old sentence untouched.

/** The four keys every pack has carried, in their established order. */
export const PACK_KEYS = ['instagram', 'facebook', 'linkedin', 'blog'] as const;

export type PackKey = (typeof PACK_KEYS)[number];

/**
 * The sentence telling the writer which keys matter.
 *
 * Unrequested keys are still asked for, as empty strings, rather than dropped
 * from the contract: parseJsonStrict reads all four and enforces only instagram
 * and linkedin, so `""` is already a valid answer and the shape never changes.
 * Narrowing the SHAPE would have been a change to every caller; narrowing the
 * WORK is a change to none.
 *
 * With no channels — or with all of them, or with nothing recognisable — the
 * result is exactly the sentence that shipped before this existed. That is the
 * property the test pins, because every other caller depends on it.
 */
export function packKeyContract(channels?: readonly string[]): string {
  const all = PACK_KEYS.join(', ');
  const wanted = (channels || []).filter((c): c is PackKey => (PACK_KEYS as readonly string[]).includes(c));
  if (!wanted.length || wanted.length >= PACK_KEYS.length) {
    return `You always return STRICT JSON with exactly the keys: ${all}.`;
  }
  // Ordered by PACK_KEYS rather than by however the caller listed them, so the
  // prompt is byte-identical for the same set of channels in any order — which
  // is what lets it be cached (see the cache_control block in lib/ai.ts).
  const named = PACK_KEYS.filter((k) => wanted.includes(k));
  // "Only instagram are used" is the kind of wrong that a model reads as noise
  // in an instruction it is being asked to follow exactly.
  const verb = named.length === 1 ? 'is' : 'are';
  const those = named.length === 1 ? 'it' : 'those';
  return `You always return STRICT JSON with exactly the keys: ${all}. Only ${named.join(' and ')} ${verb} used — write ${those} in full, and return the others as empty strings ("").`;
}
