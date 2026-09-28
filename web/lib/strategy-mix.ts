// web/lib/strategy-mix.ts
// The week as it is actually planned, measured against the document — and what
// each slot will write next.
//
// Phase 4. The planner showed fifteen cards and nothing that said whether they
// still added up to the strategy. Pause Wednesday's Sleep slot, move Thursday's
// Cancún post to Friday, remove one by mistake — the frequency table stopped
// being met and nothing anywhere said so. And nobody could see what a slot was
// about to write until it had already written it.
//
// Two answers, both from the templates the planner already has:
//
//   plannedMix      each row of the frequency table ("Content pillar
//                   frequency", page 3) with the document's target and how many
//                   active slot-days the planner gives it now; the four groups
//                   against the recommended weekly mix; and the document's
//                   slots that are missing or paused.
//   nextOccurrence  when a slot next runs and the angle, caption shape and
//                   reader the rotation deals it — the same deal the engine
//                   makes (lib/strategy-rotation.ts, lib/strategy-variety.ts).
//
// Pure: imports only ./x.ts files, so the planner and the test runner both read it.
import {
  BLOG_SLOT_KEY,
  FREQUENCY_PILLARS,
  WEEK,
  WEEKLY_MIX,
  frequencyPillarById,
  mixByPillarDays,
  slotByKey,
  slotKey,
  type MixGroup,
} from './content-strategy.ts';
import { angleFor, bankIsDocument, weekIndex } from './strategy-rotation.ts';
import { BLOG_ANGLES } from './strategy-seed.ts';
import { varietyFor, varietyLabels } from './strategy-variety.ts';
import { SCHEDULE_TZ, upcomingSlots } from './timezone.ts';

/** The parts of a schedule_templates row these read. */
export type MixTemplate = {
  id?: string;
  active?: boolean | null;
  weekdays?: readonly number[] | null;
  time_of_day?: string | null;
  strategy?: { slot?: string | null; pillars?: readonly string[] | null; seeded?: string | null } | null;
};

/** "2x weekly" → 2..2, "1-2x weekly" → 1..2. Unreadable → null. */
export function frequencyRange(text: string): { min: number; max: number } | null {
  const m = /(\d+)\s*(?:-|–|to)\s*(\d+)\s*x/i.exec(text) || /(\d+)\s*x/i.exec(text);
  if (!m) return null;
  const min = Number(m[1]);
  const max = Number(m[2] ?? m[1]);
  return Number.isFinite(min) && Number.isFinite(max) ? { min: Math.min(min, max), max: Math.max(min, max) } : null;
}

export type MixStatus = 'ok' | 'under' | 'over';

export type MixRow = {
  id: string;
  name: string;
  group: MixGroup;
  /** The document's frequency, as written. */
  frequency: string;
  target: { min: number; max: number } | null;
  /** Active slot-days counted towards the row now (primary or integrated). */
  planned: number;
  status: MixStatus;
};

export type PlannedMix = {
  rows: MixRow[];
  /** Primary rows per group, active slots only — the day map's way of counting. */
  groups: Record<MixGroup, { planned: number; recommended: number; dayMap: number }>;
  /** Document slots with no template at all. */
  missing: string[];
  /** Document slots whose every template is paused. */
  paused: string[];
  /** Is the weekly article planned and on? */
  article: 'on' | 'paused' | 'missing';
};

function isOn(t: MixTemplate): boolean {
  return t.active !== false;
}

/** How many active slot-days each document slot has in the planner. */
function slotDays(templates: readonly MixTemplate[]): Map<string, { on: number; any: boolean }> {
  const out = new Map<string, { on: number; any: boolean }>();
  for (const t of templates) {
    const key = String(t.strategy?.slot || '').trim().toLowerCase();
    if (!key) continue;
    const cur = out.get(key) || { on: 0, any: false };
    cur.any = true;
    // A slot a person also scheduled on another day counts once per day.
    if (isOn(t)) cur.on += Math.max(1, new Set(t.weekdays || []).size);
    out.set(key, cur);
  }
  return out;
}

export function plannedMix(templates: readonly MixTemplate[]): PlannedMix {
  const days = slotDays(templates);

  const planned = new Map<string, number>();
  const groups = { medical: 0, lifestyle: 0, recovery: 0, cancun: 0 } as Record<MixGroup, number>;
  const missing: string[] = [];
  const paused: string[] = [];
  for (const slot of WEEK) {
    const key = slotKey(slot);
    const d = days.get(key);
    if (!d) { missing.push(key); continue; }
    if (!d.on) { paused.push(key); continue; }
    for (const tag of slot.tags) {
      planned.set(tag.freqId, (planned.get(tag.freqId) || 0) + d.on);
      if (tag.role === 'primary') {
        const f = frequencyPillarById(tag.freqId);
        if (f) groups[f.group] += d.on;
      }
    }
  }

  const rows: MixRow[] = FREQUENCY_PILLARS.map((f) => {
    const target = frequencyRange(f.frequency);
    const n = planned.get(f.id) || 0;
    const status: MixStatus = !target ? 'ok' : n < target.min ? 'under' : n > target.max ? 'over' : 'ok';
    return { id: f.id, name: f.name, group: f.group, frequency: f.frequency, target, planned: n, status };
  });

  const dayMap = mixByPillarDays();
  const outGroups = {} as PlannedMix['groups'];
  for (const g of Object.keys(WEEKLY_MIX) as MixGroup[]) {
    outGroups[g] = { planned: groups[g], recommended: WEEKLY_MIX[g], dayMap: dayMap[g] };
  }

  const blog = days.get(BLOG_SLOT_KEY);
  const article = !blog ? 'missing' : blog.on ? 'on' : 'paused';
  return { rows, groups: outGroups, missing, paused, article };
}

/** A document slot's short name for a list: "Wednesday · Sleep". */
export function slotLabel(key: string): string {
  if (key === BLOG_SLOT_KEY) return 'Monday · Weekly article';
  const s = slotByKey(key);
  if (!s) return key;
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][s.day];
  return day + ' · ' + s.mapName;
}

export type NextOccurrence =
  | {
      at: string;
      angle: string;
      position: number;
      of: number;
      /** Caption shape and reader, when the slot is dealt them (not the article). */
      format?: string;
      audience?: string;
    }
  | { at: string; angle: null; reason: 'edited' | 'before-start' | 'no-slot' }
  | null;

/**
 * When a strategy slot next runs, and what the rotation deals it.
 *
 * The deal is the engine's own (angleFor + varietyFor), so this is what the
 * run will research. Two honest caveats the caller should show: a bank a
 * person has edited has no document deal (reason 'edited'), and in the first
 * six weeks the engine may swap an angle a recent post already covered.
 * Null: not a strategy slot, or no day to run on.
 */
export function nextOccurrence(t: MixTemplate, now: Date = new Date(), tz: string = SCHEDULE_TZ): NextOccurrence {
  const key = String(t.strategy?.slot || '').trim().toLowerCase();
  if (!key) return null;
  const at = upcomingSlots([...(t.weekdays || [])], String(t.time_of_day || '09:00'), 8, tz, now)[0];
  if (!at) return null;
  const iso = at.toISOString();
  if (key !== BLOG_SLOT_KEY && !slotByKey(key)) return { at: iso, angle: null, reason: 'no-slot' };
  const dealt = angleFor(key, iso, { bank: t.strategy?.pillars || undefined, articleBank: BLOG_ANGLES, tz });
  if (!dealt) {
    // angleFor is null for an edited bank or a week before the epoch.
    if (!bankIsDocument(key, t.strategy?.pillars, BLOG_ANGLES)) return { at: iso, angle: null, reason: 'edited' };
    return { at: iso, angle: null, reason: weekIndex(iso, tz) < 0 ? 'before-start' : 'edited' };
  }
  const labels = varietyLabels(varietyFor(key, dealt.week));
  return {
    at: iso,
    angle: dealt.angle,
    position: dealt.position,
    of: dealt.of,
    ...(labels ? { format: labels.format, audience: labels.audience } : {}),
  };
}
