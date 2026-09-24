// web/lib/library-caption.ts
//
// WHAT IS ACTUALLY IN THE PHOTO FOLDER.
//
// The clinic's Drive folder holds 175 photographs named DSC00757.png and
// 12 (1).png. Nothing about a filename says whether the picture shows a
// consultation, an IV suite or the car park, so a post about sleep cannot find
// the right photograph even when one exists. This reads each picture once with
// the vision model the image checker already uses, and records what it shows
// and what would stop it being used.
//
// Two separate questions, deliberately kept apart:
//
//   SUBJECT   what the photograph is of, which decides the posts it could
//             illustrate.
//   BLOCKERS  what the cover rules would refuse it for - rendered text, a
//             procedure in progress, a device attached to a person, an
//             identifiable patient. The folder's most distinctive material is
//             procedure photography, which is exactly what those rules exclude,
//             so counting subjects without counting blockers would flatter the
//             library badly.
//
// Pure on purpose: the vocabulary, the parsing and the pillar mapping decide
// what the team is told it has, so they are tested rather than trusted.

/** The subjects worth telling apart in this folder. */
export const SUBJECTS = [
  'consultation',      // clinician and patient talking, desk or table
  'portrait',          // one person, posed or candid, no procedure
  'team',              // two or more staff together, group or corridor
  'treatment-room',    // the room itself, with or without people
  'iv-suite',          // infusion chairs, drip stands
  'led-therapy',       // red or purple light beds and panels
  'procedure',         // something being administered or performed
  'reception',         // front desk, waiting area, lobby
  'exterior',          // building, street, sea, outdoors
  'lab',               // bench, microscope, samples
  'equipment',         // a machine or instrument as the subject
  'food',              // meals, ingredients, kitchen
  'movement',          // walking, exercise, stretching, sport
  'rest',              // sleep, bedroom, quiet domestic calm
  'document',          // paperwork, screens, slides, printed material
  'graphic',           // a render, diagram or designed image, not a photograph
] as const;
export type Subject = (typeof SUBJECTS)[number];

/** What would stop a picture being used as a post cover. */
export const BLOCKERS = [
  'text',                 // any legible words, signage, branding, slides
  'procedure',            // a treatment being given
  'device-on-person',     // cuff, IV line, electrodes, mask, probe on a body
  'identifiable-patient', // a patient's face, clearly recognisable
  'render',               // 3D or illustrated rather than photographed
] as const;
export type Blocker = (typeof BLOCKERS)[number];

export type Caption = {
  /** One sentence, plain, what a person would say the picture shows. */
  caption: string;
  subjects: Subject[];
  blockers: Blocker[];
};

/** Which pillars each subject can honestly illustrate. */
const SUBJECT_PILLARS: Record<Subject, string[]> = {
  consultation: ['diagnosis', 'protocols', 'follow-up', 'prevention', 'supplementation'],
  portrait: ['diagnosis', 'protocols', 'follow-up'],
  team: ['diagnosis', 'protocols'],
  'treatment-room': ['recovery', 'protocols'],
  'iv-suite': ['recovery'],
  'led-therapy': ['recovery'],
  procedure: [],                       // never a cover, so it illustrates nothing
  reception: ['cancun', 'follow-up'],
  exterior: ['cancun', 'recovery-cancun', 'active-living'],
  lab: ['recovery', 'diagnosis'],
  equipment: ['protocols'],
  food: ['nutrition', 'practical-nutrition', 'supplementation'],
  movement: ['movement', 'active-living'],
  rest: ['sleep', 'stress'],
  document: [],
  graphic: [],
};

/** The pillars a captioned picture could serve. Empty when it could serve none. */
export function pillarsFor(c: Pick<Caption, 'subjects'>): string[] {
  const out = new Set<string>();
  for (const s of c.subjects) for (const p of SUBJECT_PILLARS[s] || []) out.add(p);
  return [...out].sort();
}

/**
 * Could this picture be a post cover at all?
 *
 * An identifiable patient is not a defect in the photograph — it is a consent
 * question for the clinic — so it is reported separately rather than folded in
 * with the rule failures.
 */
export function coverSafe(c: Pick<Caption, 'blockers'>): { ok: boolean; why: Blocker[]; needsConsent: boolean } {
  const why = c.blockers.filter((b) => b !== 'identifiable-patient');
  return { ok: why.length === 0, why, needsConsent: c.blockers.includes('identifiable-patient') };
}

export function captionSystemPrompt(): string {
  return [
    'You are cataloguing a medical clinic\'s own photo library so its marketing team can find pictures by what they show.',
    'Look at the photograph and answer two things.',
    `SUBJECTS: which of these it shows — ${SUBJECTS.join(', ')}. Choose every one that genuinely applies, usually one or two, never more than three.`,
    '"procedure" means a treatment is being given or performed. "graphic" means it is a render, diagram or designed image rather than a photograph.',
    `BLOCKERS: which of these are present — ${BLOCKERS.join(', ')}.`,
    '"text" means ANY legible words anywhere: signage, a logo on a wall or uniform, a slide, a screen, printed paper, a label. When in doubt, say text.',
    '"device-on-person" means something medical is worn by, clipped to, connected to or held against a person: a cuff, an IV line, electrodes, a mask, a probe.',
    '"identifiable-patient" means a patient\'s face is clearly recognisable. Staff in uniform do not count.',
    'Also give one plain sentence saying what the picture shows, as a person would describe it.',
    'Answer with STRICT JSON only: {"caption": "one sentence", "subjects": ["..."], "blockers": ["..."]}',
  ].join(' ');
}

/** Parse and sanitise the model's answer. Null when unusable. */
export function parseCaption(raw: unknown): Caption | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { obj = JSON.parse(m[0]); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const caption = String(o.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const pick = <T extends string>(v: unknown, allowed: readonly T[]): T[] => {
    const arr = Array.isArray(v) ? v : [];
    const seen = new Set<string>();
    return arr
      .map((x) => String(x).trim().toLowerCase())
      .filter((x): x is T => (allowed as readonly string[]).includes(x) && !seen.has(x) && !!seen.add(x));
  };
  const subjects = pick(o.subjects, SUBJECTS).slice(0, 3);
  const blockers = pick(o.blockers, BLOCKERS);
  if (!caption || !subjects.length) return null;
  return { caption, subjects, blockers };
}

export type Inventory = {
  /** How many pictures could cover each pillar, after the rules. */
  byPillar: Record<string, number>;
  /** How many were refused for each reason. */
  byBlocker: Record<string, number>;
  usable: number;
  needsConsent: number;
  total: number;
};

/** Roll a set of captions up into the answer the team actually asked for. */
export function inventory(caps: Caption[], pillars: readonly string[]): Inventory {
  const byPillar: Record<string, number> = Object.fromEntries(pillars.map((p) => [p, 0]));
  const byBlocker: Record<string, number> = Object.fromEntries(BLOCKERS.map((b) => [b, 0]));
  let usable = 0, needsConsent = 0;
  for (const c of caps) {
    for (const b of c.blockers) byBlocker[b] = (byBlocker[b] ?? 0) + 1;
    const safe = coverSafe(c);
    if (safe.needsConsent) needsConsent += 1;
    if (!safe.ok) continue;
    usable += 1;
    for (const p of pillarsFor(c)) if (p in byPillar) byPillar[p] += 1;
  }
  return { byPillar, byBlocker, usable, needsConsent, total: caps.length };
}
