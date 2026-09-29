// web/lib/publishing-list.ts
// What the Calendar / Publishing list shows beside the `posts` rows: the
// Autopilot runs still waiting for a decision, merged into the same dated list.
//
// WHY. The Autopilot queue lived only on the Dashboard, so the person approving
// posts worked from two pages: the calendar for posts already in Metricool and
// the Dashboard for the drafts that would become them. These helpers let the
// calendar show both in one order, so it is the one place to work from.
//
// Pure: no runtime imports, so the test runner reads this file directly.

/** The fields of an Autopilot run this list needs. */
export type ListRun = {
  id: string;
  state: string;
  scheduled_for: string;
  /** Set by GET /api/autopilot/runs: its time passed before anyone approved it. */
  missed?: boolean;
  pack?: Record<string, unknown> | null;
};

export type ListPost = { id?: string; publication_date?: string };

/** The channels a run's pack can carry copy for, in display order. */
export const RUN_CHANNELS = ['instagram', 'facebook', 'linkedin', 'blog'] as const;

function at(iso: string | undefined): number {
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * The runs a person still has to decide on — the same set the Dashboard shows
 * as ready — split into the ones still ahead and the ones whose time has gone.
 * Approved, skipped, failed and in-flight runs are not posts yet and stay out.
 */
export function reviewRuns<T extends ListRun>(runs: readonly T[] | null | undefined, now: number = Date.now()): { upcoming: T[]; missed: T[] } {
  const ready = (runs || []).filter((r) => r && r.state === 'ready_for_review');
  const isMissed = (r: T) => (typeof r.missed === 'boolean' ? r.missed : at(r.scheduled_for) < now);
  const asc = (a: T, b: T) => at(a.scheduled_for) - at(b.scheduled_for);
  return {
    upcoming: ready.filter((r) => !isMissed(r)).sort(asc),
    missed: ready.filter(isMissed).sort(asc),
  };
}

export type ListEntry<P, R> =
  | { kind: 'post'; when: number; post: P }
  | { kind: 'run'; when: number; run: R };

/** Posts and runs in one list, soonest first; a post sorts before a run at the same minute. */
export function mergeByDate<P extends ListPost, R extends ListRun>(posts: readonly P[], runs: readonly R[]): ListEntry<P, R>[] {
  const entries: ListEntry<P, R>[] = [
    ...posts.map((post) => ({ kind: 'post' as const, when: at(post.publication_date), post })),
    ...runs.map((run) => ({ kind: 'run' as const, when: at(run.scheduled_for), run })),
  ];
  return entries.sort((a, b) => a.when - b.when || (a.kind === b.kind ? 0 : a.kind === 'post' ? -1 : 1));
}

/** The channels this pack has copy for. */
export function runChannels(pack: Record<string, unknown> | null | undefined): string[] {
  if (!pack) return [];
  return RUN_CHANNELS.filter((k) => typeof pack[k] === 'string' && String(pack[k]).trim());
}

/** The copy shown in the list row: the first channel that has any. */
export function runText(pack: Record<string, unknown> | null | undefined): string {
  const first = runChannels(pack)[0];
  return first && pack ? String(pack[first]).trim() : '';
}

/**
 * The REF and AVISO lines of a caption, as written — the two the advertising
 * rule asks for (lib/compliance.ts), shown on their own so a reviewer does not
 * have to hunt for them at the bottom of the copy.
 */
export function complianceLines(text: string | null | undefined): { ref: string | null; aviso: string | null } {
  let ref: string | null = null;
  let aviso: string | null = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!ref && /^REF(?:ERENCIA)?\s*[.:：]/i.test(line)) ref = line;
    else if (!aviso && /^AVISO\s+DE\s+PUBLICIDAD\b/i.test(line)) aviso = line;
  }
  return { ref, aviso };
}
