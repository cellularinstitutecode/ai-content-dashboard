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
import { nextFreeSlot } from './video-slot.ts';

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

/**
 * The instant a row asked for from the sheet's "Prepare checked boxes" panel,
 * checked against the calendar.
 *
 * A person picks a day and a time on the clinic's clock; this decides what
 * that becomes. The time as given, when nothing is scheduled on it. The next
 * free grid slot after it (lib/video-slot.ts) when something is — two videos
 * sent from the same panel both ask for the same instant, and one post per
 * slot is the rule that keeps a backlog from stacking. A time already gone is
 * refused here, before any copy is written, rather than by the preflight on
 * every network.
 */
export type SlotChoice =
  | { ok: true; at: Date; moved: boolean }
  | { ok: false; reason: 'past' | 'full' };

export function chosenSlot(requested: Date, taken: Iterable<string>, now: Date = new Date()): SlotChoice {
  if (!(requested instanceof Date) || !Number.isFinite(requested.getTime()) || requested.getTime() <= now.getTime()) return { ok: false, reason: 'past' };
  const used = new Set<number>();
  for (const t of taken) {
    const at = Date.parse(String(t));
    if (Number.isFinite(at)) used.add(at);
  }
  if (!used.has(requested.getTime())) return { ok: true, at: requested, moved: false };
  const next = nextFreeSlot(Array.from(used, (n) => new Date(n).toISOString()), requested);
  return next ? { ok: true, at: next, moved: true } : { ok: false, reason: 'full' };
}

/**
 * May a tick that names no time be sent at the next free slot?
 *
 * No, unless the deployment says so. The sheet's edit trigger sends a row the
 * moment a box is ticked, with no time; the first time the clinic used the
 * ticks it got two posts at slots nobody chose, and then found the panel had
 * nothing left to schedule. A tick now means "this network, at a time I will
 * pick in the dashboard's Prepare checked boxes", and the trigger's request
 * is answered `needs_time`. VIDEO_TICK_INSTANT=on restores the instant send.
 */
export function instantTicksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return /^(on|true|1|yes)$/i.test(String(env.VIDEO_TICK_INSTANT || '').trim());
}
