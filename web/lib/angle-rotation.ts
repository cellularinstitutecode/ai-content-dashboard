// web/lib/angle-rotation.ts
// Which of the available angles this occurrence gets — the part of the
// Autopilot that keeps the same pillar from writing the same post.
//
// The strategy document's one demanding rule is "repeat the content pillar,
// not the wording", and the engine honours it in two places. The seed list
// moves the PILLAR's angle on each week (lib/autopilot.ts, by occurrence), and
// this file moves the EDITORIAL angle: answer, commercial, defense,
// opportunity, rotated by the same occurrence index.
//
// What the rotation alone could not do is notice that it had already written
// this exact query. `template_runs.angle` has recorded every decided angle
// since the table existed, and until now the only thing that read it was the
// review card. Handing that history to the chooser turns "a repeat is
// unlikely" into "a repeat is the last resort".
//
// FAIL-OPEN, DELIBERATELY. If every available angle has been used before, this
// returns the rotation's own first choice rather than nothing. A post that
// repeats a query is a small problem; a run that produces no post because the
// history was too full is a bigger one.
//
// Pure: the test runner reads this file directly.

export type AngleType = 'answer' | 'commercial' | 'defense' | 'opportunity';

/** The rotation order. Index by occurrence, then take the first available. */
export const ANGLE_ORDER: readonly AngleType[] = ['answer', 'commercial', 'defense', 'opportunity'];

/** How many past occurrences of a template to weigh. Six weeks of a weekly slot. */
export const ANGLE_HISTORY = 6;

/** Enough of an angle to rotate it. The real one carries a rationale and a lot more. */
export type RotatableAngle = { type: AngleType; query: string };

/** A row out of `template_runs.angle`, which is jsonb and may be anything. */
export type PastAngle = { type?: unknown; query?: unknown } | null | undefined;

function key(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * The queries this template has already targeted, newest first.
 *
 * Deduplicated and capped at ANGLE_HISTORY entries, so one template that ran
 * for a year cannot rule out every candidate it has ever had.
 */
export function pastQueries(history: readonly PastAngle[] = [], limit = ANGLE_HISTORY): Set<string> {
  const out = new Set<string>();
  for (const row of history) {
    if (out.size >= limit) break;
    const q = key(row?.query);
    if (q) out.add(q);
  }
  return out;
}

/** The angle type of the most recent occurrence, or '' when there is no history. */
export function lastType(history: readonly PastAngle[] = []): string {
  for (const row of history) {
    const t = key(row?.type);
    if (t) return t;
  }
  return '';
}

/**
 * Pick this occurrence's angle.
 *
 * Three passes, each weaker than the one above it:
 *
 *  1. rotation order, skipping any query this template has already used AND
 *     the type it used last time;
 *  2. rotation order, skipping only the queries already used;
 *  3. rotation order — what this did before the history was read at all.
 *
 * `occurrenceIndex` starts the order, which is what makes week 1 and week 2
 * differ even when both weeks have every angle available.
 */
export function chooseAngle<T extends RotatableAngle>(
  available: readonly T[],
  occurrenceIndex: number,
  history: readonly PastAngle[] = []
): T | null {
  if (!available.length) return null;

  const used = pastQueries(history);
  const previous = lastType(history);
  const start = ((Math.trunc(occurrenceIndex) % ANGLE_ORDER.length) + ANGLE_ORDER.length) % ANGLE_ORDER.length;

  const inRotationOrder: T[] = [];
  for (let i = 0; i < ANGLE_ORDER.length; i++) {
    const want = ANGLE_ORDER[(start + i) % ANGLE_ORDER.length];
    const hit = available.find((a) => a.type === want);
    if (hit) inRotationOrder.push(hit);
  }
  // Anything whose type is not in ANGLE_ORDER would otherwise be unreachable.
  for (const a of available) if (!inRotationOrder.includes(a)) inRotationOrder.push(a);

  const fresh = (a: T) => !used.has(key(a.query));

  return (
    inRotationOrder.find((a) => fresh(a) && a.type !== previous) ||
    inRotationOrder.find(fresh) ||
    inRotationOrder[0]
  );
}
