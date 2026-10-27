// web/lib/tick-add.ts
// Which networks a tick made AFTER a row was prepared is still asking for.
//
// A prepared row is done as far as the sweep is concerned: it never looks at
// the row's boxes again. So a box ticked an hour later — Facebook, say, on a
// video that went to YouTube, LinkedIn and TikTok — asked for nothing. The
// sheet's own edit trigger now sends that click to /api/videos/row, and this
// is the rule it applies: every ticked network that has no draft yet, and
// nothing else.
//
// "Has a draft" is read from the row's recorded outcomes (video_runs.metricool):
// a network sent ok, or answered already_queued / already_published, is done.
// A network refused for another reason (too long, no video, Metricool down) is
// NOT done — a tick is a person asking again, and the hand-off will give the
// same answer if nothing has changed, which costs one read. The hand-off then
// checks the posts table itself (lib/awaiting-posts.ts), so a draft this list
// cannot see — one made by hand in the dashboard — is still not made twice.
//
// Pure, so it is unit-tested; the server half is lib/video-ticks.ts.

/** The slice of a recorded outcome this rule reads. */
export type PriorOutcome = { network: string; ok: boolean; reason?: string | null };

/** The reasons that mean "this network already has its post", so a tick adds nothing. */
const DONE_REASONS = new Set(['already_queued', 'already_published']);

/** The ticked networks that are not yet drafted, in tick order, lower-cased, deduped. */
export function networksToAdd(ticked: readonly string[], prior: readonly PriorOutcome[] | null | undefined): string[] {
  const done = new Set<string>();
  for (const p of prior || []) {
    const n = String(p?.network || '').toLowerCase();
    if (!n) continue;
    if (p.ok || DONE_REASONS.has(String(p.reason || ''))) done.add(n);
  }
  const out: string[] = [];
  for (const raw of ticked) {
    const n = String(raw || '').toLowerCase();
    // Email is a sheet column, not a network Metricool posts to (lib/video-slot.ts).
    if (!n || n === 'email' || done.has(n) || out.includes(n)) continue;
    out.push(n);
  }
  return out;
}

/** The recorded outcomes with this pass's answers in place of the old ones for the same networks. */
export function mergeOutcomes<T extends PriorOutcome>(prior: readonly T[] | null | undefined, made: readonly T[]): T[] {
  const replaced = new Set(made.map((m) => String(m.network || '').toLowerCase()));
  const kept = (prior || []).filter((p) => !replaced.has(String(p.network || '').toLowerCase()));
  return [...kept, ...made];
}
