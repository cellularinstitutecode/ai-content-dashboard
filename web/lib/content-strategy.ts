// web/lib/content-strategy.ts
// The clinic's written content strategy, as data the engine can run.
//
// "CELLULAR INSTITUTE — WEEKLY SOCIAL CONTENT STRATEGY": 14 posts a week, two a
// day, Monday to Sunday. Its cover says "8 recurring content pillars"; its
// frequency table (page 3) lists nine rows, and its day pages fourteen post
// headings. All three are recorded here: FREQUENCY_PILLARS is the table,
// PILLARS the day pages' angle banks, WEEK the day map that joins them. Its
// governing rule is the one that makes it hard (page 2, and its "Core
// principle" box):
//
//   "The calendar repeats strategic content pillars, not identical posts.
//    Each time a pillar returns, the angle, question, format, or audience
//    should change."  —  "Repeat the content pillar, not the wording."
//
// WHY THIS FILE IS A LIST AND NOT AN ENGINE. The engine already exists.
// lib/autopilot.ts runs a template once per weekday and rotates its seed list by
// occurrence — `seedPool[occurrenceIndex % seedPool.length]`. A template pinned
// to ONE day therefore advances its list once a week. So the strategy is
// satisfied by giving each day's template that pillar's own ANGLES as its seed
// list: the pillar stays, the angle moves on, and the bank takes five or six
// weeks to come round.
//
// Every angle below is transcribed from the strategy document rather than
// invented. Where the document is ambiguous — and it is, in exactly one place —
// the ambiguity is recorded here rather than resolved silently. See WEEKLY_MIX.
//
// Pure: no imports, so the test runner reads this file directly.

/** 0 = Sunday, as JavaScript counts and as `schedule_templates.weekdays` stores. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** The four groups the document's "recommended weekly mix" is counted in. */
export type MixGroup = 'medical' | 'lifestyle' | 'recovery' | 'cancun';

export type Pillar = {
  id: string;
  /** The pillar's name, as the document's day pages head it. */
  name: string;
  group: MixGroup;
  /**
   * The angles the document lists for this pillar.
   *
   * This is the seed list a template rotates through — one per week — so the
   * ORDER is the order they were written in, and the LENGTH is how many weeks
   * pass before the pillar returns to its first angle.
   */
  angles: string[];
};

/** How a slot relates to a row of the frequency table. */
export type SlotTag = {
  freqId: string;
  /**
   * 'primary': the slot IS this pillar's post that day. 'integrated': the
   * pillar is woven into the slot without being its subject — the table's
   * "Patient follow-up … also integrated into assessment content".
   */
  role: 'primary' | 'integrated';
};

export type Slot = {
  day: Weekday;
  /** 1 or 2 — "Post 1" and "Post 2" as the document numbers them. */
  post: 1 | 2;
  /** The day page's angle bank this slot rotates (PILLARS). */
  pillarId: string;
  /** The slot's name in the page-2 day map, which is not always its day-page heading. */
  mapName: string;
  /** The frequency-table rows this slot counts towards (page 3). */
  tags: SlotTag[];
};

/**
 * The two standing notes, as writer rules.
 *
 * Broadened from the document's wording on purpose, and said so here rather
 * than called verbatim: the positioning note names "every other Mexican
 * destination", and the rule forbids superiority over ANY destination; the
 * soft-service note says "without turning every post into a direct
 * promotion", and the rule forbids promotion in every post.
 */
export const CANCUN_RULE =
  'Never claim that Cancun is categorically better than any other destination, in Mexico or elsewhere. ' +
  'Write about specific, checkable advantages instead: international air connectivity, tourism ' +
  'infrastructure, hotel options, warm weather, and being able to combine care and recovery in one trip.';

export const RECOVERY_RULE =
  'Services may be INTRODUCED here and never promoted: HBOT, red light therapy, PEMF, hydrogen ' +
  'inhalation and the recovery lounge can appear as part of what recovery may involve. Do not build the ' +
  'post around one of them, do not compare them, and do not present any of them as something to buy.';

/** Whether a post in this pillar must carry a REF citation (see lib/compliance.ts). */
export type CitationPolicy = 'required' | 'if-health-claim';

export type FrequencyPillar = {
  id: string;
  /** The table's own words, for all three columns. */
  name: string;
  days: string;
  frequency: string;
  group: MixGroup;
  /**
   * The clinic's decision, not the document's: a pillar that teaches health
   * always cites a study; the destination pillar cites one only when a post
   * makes a health claim — no paper supports "air connectivity from the
   * United States and Canada".
   */
  citation: CitationPolicy;
  /** A standing note that governs every slot counted towards this row. */
  rule?: string;
};

/** Page 3, "Content pillar frequency", row for row. */
export const FREQUENCY_PILLARS: FrequencyPillar[] = [
  { id: 'assessment-prevention', name: 'Diagnosis, assessment, and prevention', days: 'Monday and Thursday', frequency: '2x weekly', group: 'medical', citation: 'required' },
  { id: 'protocols', name: 'Personalized protocols', days: 'Monday and Friday', frequency: '2x weekly', group: 'medical', citation: 'required' },
  { id: 'nutrition', name: 'Nutrition', days: 'Tuesday and Saturday', frequency: '2x weekly', group: 'lifestyle', citation: 'required' },
  { id: 'supplementation', name: 'Supplementation', days: 'Tuesday', frequency: '1x weekly', group: 'lifestyle', citation: 'required' },
  { id: 'movement', name: 'Movement and exercise', days: 'Wednesday and Saturday', frequency: '2x weekly', group: 'lifestyle', citation: 'required' },
  { id: 'sleep-stress', name: 'Sleep and stress management', days: 'Wednesday and Sunday', frequency: '2x weekly', group: 'lifestyle', citation: 'required' },
  { id: 'recovery', name: 'Recovery and restoration', days: 'Friday and Sunday', frequency: '2x weekly', group: 'recovery', citation: 'required', rule: RECOVERY_RULE },
  { id: 'cancun', name: 'Cancun and health tourism', days: 'Thursday and Sunday', frequency: '2x weekly', group: 'cancun', citation: 'if-health-claim', rule: CANCUN_RULE },
  { id: 'follow-up', name: 'Patient follow-up', days: 'Primarily Friday; also integrated into assessment content', frequency: '1-2x weekly', group: 'medical', citation: 'required' },
];

/** Each day page's subtitle — the theme the day's two posts share. 0 = Sunday. */
export const DAY_THEMES: Record<Weekday, string> = {
  1: 'Understand before treating',
  2: 'Support the body from within',
  3: 'Movement and restoration',
  4: 'Prevention and destination',
  5: 'Guidance beyond the appointment',
  6: 'Healthy habits in real life',
  0: 'Well-being and the Cancun experience',
};

export const PILLARS: Pillar[] = [
  {
    id: 'diagnosis',
    name: 'Diagnosis and assessment',
    group: 'medical',
    angles: [
      'Why effective care begins with a thorough evaluation',
      'Why similar symptoms may have different causes',
      'What information a physician needs before recommending a protocol',
      'The importance of reviewing laboratory results, imaging, and medical history',
      'Why comparing treatments without comparing evaluations can be misleading',
    ],
  },
  {
    id: 'protocols',
    name: 'Personalization',
    group: 'medical',
    angles: [
      'Why one protocol does not work the same way for every person',
      'How age, diagnosis, medications, and lifestyle influence planning',
      'The difference between a standard package and a personalized medical plan',
      'How therapies, number of sessions, and routes of administration are selected',
      'Why the right protocol depends on the patient, not only the condition',
    ],
  },
  {
    id: 'nutrition',
    name: 'Nutrition',
    group: 'lifestyle',
    angles: [
      'The role of protein in recovery',
      'Nutrition and inflammation',
      'Hydration and cellular health',
      'Nutrients that help support muscle mass',
      'How to prepare the body nutritionally before treatment',
      'Nutrition during the recovery process',
    ],
  },
  {
    id: 'supplementation',
    name: 'Supplementation',
    group: 'lifestyle',
    angles: [
      'Why supplementation should also be personalized',
      'Why more supplements do not necessarily mean better results',
      'Possible interactions between supplements and medications',
      'The importance of identifying actual deficiencies',
      'What to review before beginning a supplement routine',
      'Supplements as support, not a substitute for healthy habits',
    ],
  },
  {
    id: 'movement',
    name: 'Movement',
    group: 'lifestyle',
    angles: [
      'Why staying active matters at every age',
      'Muscle strength and longevity',
      'Movement as a way to support joint health',
      'The difference between physical activity and structured training',
      'How to begin moving when pain or limited mobility is present',
      'Why exercise should be adapted to the individual',
    ],
  },
  {
    id: 'sleep',
    name: 'Sleep',
    group: 'lifestyle',
    angles: [
      'What happens in the body while we sleep',
      'The relationship between sleep and recovery',
      'How poor sleep can affect inflammation',
      'The connection between sleep, appetite, and metabolism',
      'Simple habits that may improve sleep quality',
      'Why sleeping longer does not always mean resting better',
    ],
  },
  {
    id: 'prevention',
    name: 'Prevention',
    group: 'medical',
    angles: [
      'Why you should not wait until you feel unwell to assess your health',
      'The value of periodic health evaluations',
      'Biomarkers that help build a broader picture of health',
      'Identifying changes before they affect quality of life',
      'Establishing a baseline to help measure progress',
      'The difference between addressing symptoms and exploring possible causes',
    ],
  },
  {
    id: 'cancun',
    name: 'Cancun and health tourism',
    group: 'cancun',
    angles: [
      'Why Cancun is well suited for combining medical care and rest',
      'Air connectivity from the United States and Canada',
      'Recovering in a calm, warm environment',
      'Hotel, dining, and low-impact activity options',
      'What patients can do during open days in their protocol',
      'How to organize a medical trip that feels supported and comfortable',
    ],
  },
  {
    id: 'follow-up',
    name: 'Personalization and follow-up',
    group: 'medical',
    angles: [
      'Why a protocol may be adjusted as the patient progresses',
      'The importance of monitoring changes over time',
      'What happens after a patient returns home',
      'How follow-ups at 1, 3, 6, and 12 months support continuity of care',
      'Why care does not end when the patient leaves the clinic',
      'How progress can be evaluated while maintaining realistic expectations',
    ],
  },
  {
    id: 'recovery',
    name: 'Recovery',
    group: 'recovery',
    angles: [
      'Recovery as part of the overall care plan',
      'Why the body needs time to respond',
      'Hydration, rest, and movement after treatment',
      'Technologies that may support the recovery experience',
      'What it means to build a personalized recovery plan',
      'Why patients should avoid overloading the body immediately afterward',
    ],
  },
  {
    id: 'active-living',
    name: 'Active living',
    group: 'lifestyle',
    angles: [
      'Simple activities that help people stay active',
      'Walking, swimming, and mobility exercises',
      'Maintaining muscle mass after 40, 50, or 60',
      'Ways to incorporate movement while traveling',
      'Options when intense exercise is not appropriate',
      'Why consistency often matters more than intensity',
    ],
  },
  {
    id: 'practical-nutrition',
    name: 'Practical nutrition',
    group: 'lifestyle',
    angles: [
      'Protein-rich breakfast ideas',
      'How to make balanced choices while traveling',
      'Snacks that support steady energy',
      'How to read a nutrition label',
      'Common mistakes when trying to eat healthier',
      'What to consider when ordering at a restaurant during recovery',
    ],
  },
  {
    id: 'stress',
    name: 'Sleep, stress, and rest',
    group: 'lifestyle',
    angles: [
      'How stress can influence recovery',
      'Why the body needs intentional rest',
      'Simple rituals to close the week',
      'Breathing, relaxation, and the nervous system',
      'Mental and physical recovery',
      'Why rest is a meaningful part of well-being',
    ],
  },
  {
    id: 'recovery-cancun',
    name: 'Recovery in Cancun',
    group: 'recovery',
    angles: [
      'What a recovery day in Cancun may look like',
      'Low-intensity activities for patients',
      'Nature, the beach, and a calmer pace',
      'How treatment can be combined with time to rest',
      'What a companion can do during the trip',
      'The patient experience before, during, and after the clinic visit',
    ],
  },
];

/**
 * The document's day map: two posts a day, Monday through Sunday.
 *
 * `tags` are the frequency table's rows. Two slots count towards two rows,
 * exactly as the table lists them: Friday's first post is both "Personalized
 * protocols — Monday and Friday" and "Patient follow-up — primarily Friday",
 * and Sunday's second is both "Recovery and restoration — Friday and Sunday"
 * and "Cancun and health tourism — Thursday and Sunday" (its day-map name is
 * "Recovery, rest, and the Cancun experience"). Monday's assessment post
 * carries follow-up as 'integrated', the table's "also integrated into
 * assessment content".
 */
export const WEEK: Slot[] = [
  { day: 1, post: 1, pillarId: 'diagnosis', mapName: 'Diagnosis and comprehensive assessment', tags: [{ freqId: 'assessment-prevention', role: 'primary' }, { freqId: 'follow-up', role: 'integrated' }] },
  { day: 1, post: 2, pillarId: 'protocols', mapName: 'Personalized protocols', tags: [{ freqId: 'protocols', role: 'primary' }] },
  { day: 2, post: 1, pillarId: 'nutrition', mapName: 'Nutrition', tags: [{ freqId: 'nutrition', role: 'primary' }] },
  { day: 2, post: 2, pillarId: 'supplementation', mapName: 'Supplementation', tags: [{ freqId: 'supplementation', role: 'primary' }] },
  { day: 3, post: 1, pillarId: 'movement', mapName: 'Movement and exercise', tags: [{ freqId: 'movement', role: 'primary' }] },
  { day: 3, post: 2, pillarId: 'sleep', mapName: 'Sleep and rest', tags: [{ freqId: 'sleep-stress', role: 'primary' }] },
  { day: 4, post: 1, pillarId: 'prevention', mapName: 'Prevention and early detection', tags: [{ freqId: 'assessment-prevention', role: 'primary' }] },
  { day: 4, post: 2, pillarId: 'cancun', mapName: 'Cancun as a health tourism destination', tags: [{ freqId: 'cancun', role: 'primary' }] },
  { day: 5, post: 1, pillarId: 'follow-up', mapName: 'Personalization and follow-up', tags: [{ freqId: 'protocols', role: 'primary' }, { freqId: 'follow-up', role: 'primary' }] },
  { day: 5, post: 2, pillarId: 'recovery', mapName: 'Recovery and restoration', tags: [{ freqId: 'recovery', role: 'primary' }] },
  { day: 6, post: 1, pillarId: 'active-living', mapName: 'Active living and longevity', tags: [{ freqId: 'movement', role: 'primary' }] },
  { day: 6, post: 2, pillarId: 'practical-nutrition', mapName: 'Practical nutrition', tags: [{ freqId: 'nutrition', role: 'primary' }] },
  { day: 0, post: 1, pillarId: 'stress', mapName: 'Sleep, stress, and well-being', tags: [{ freqId: 'sleep-stress', role: 'primary' }] },
  { day: 0, post: 2, pillarId: 'recovery-cancun', mapName: 'Recovery, rest, and the Cancun experience', tags: [{ freqId: 'recovery', role: 'primary' }, { freqId: 'cancun', role: 'primary' }] },
];

/**
 * The document's recommended weekly mix — 5 medical, 5 lifestyle, 2 recovery,
 * 2 Cancún — recorded as what it is: a RECOMMENDATION.
 *
 * Counted the way the frequency table counts (mixByPillarDays: every primary
 * row a slot belongs to, so sixteen pillar-days over fourteen slots), the day
 * map gives medical 5, recovery 2 and Cancún 2 — exactly the recommendation —
 * and lifestyle 7. That one difference is in the source: "5 healthy-lifestyle
 * posts — nutrition, supplementation, sleep, movement, and stress management"
 * names five SUBJECTS, which the day map spreads over seven posts (Saturday's
 * two, "Active living" and "Practical nutrition", are the extra ones). It is
 * the clinic's call which one to follow; neither is bent to fit the other, and
 * the test asserts both numbers so a change to either is deliberate.
 */
export const WEEKLY_MIX: Record<MixGroup, number> = {
  medical: 5,
  lifestyle: 5,
  recovery: 2,
  cancun: 2,
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * A slot's stable identity: 'mon-1' … 'sun-2'.
 *
 * Stored on every seeded template (`strategy.slot`) so the seed, the brief and
 * the planner picture can find a slot's pillar without going through its NAME.
 * Names are the one thing a person is free to change, and matching on them
 * meant a renamed "Nutrition" was duplicated by the next "Load the weekly
 * strategy" and lost its pillar in the brief and the picture.
 */
export function slotKey(slot: Pick<Slot, 'day' | 'post'>): string {
  return DAY_KEYS[slot.day] + '-' + slot.post;
}

/** The weekly article's key. It is not one of the document's fourteen. */
export const BLOG_SLOT_KEY = 'mon-blog';

/** The slot a key names, or null (the article's key names no document slot). */
export function slotByKey(key: unknown): Slot | null {
  const k = String(key || '').trim().toLowerCase();
  return WEEK.find((s) => slotKey(s) === k) ?? null;
}

/** Every slot, in the order the week runs — Monday first, as the document reads. */
export const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

/** The times the two daily slots default to, clear of the video pipeline's 13:00 / 17:00. */
export const SLOT_TIMES: Record<1 | 2, string> = { 1: '09:00', 2: '18:00' };

export function pillarById(id: string): Pillar | null {
  return PILLARS.find((p) => p.id === id) ?? null;
}

/**
 * The days a day-page angle bank is scheduled on, from the day map. Each bank
 * is one slot, so this is one day; for the frequency table's rows, which span
 * two, see frequencyDays.
 */
export function daysFor(pillarId: string): Weekday[] {
  return WEEK.filter((s) => s.pillarId === pillarId).map((s) => s.day);
}

export function frequencyPillarById(id: string): FrequencyPillar | null {
  return FREQUENCY_PILLARS.find((f) => f.id === id) ?? null;
}

/** The days a frequency-table row covers, derived from the day map. */
export function frequencyDays(freqId: string, roles: readonly SlotTag['role'][] = ['primary', 'integrated']): Weekday[] {
  const out: Weekday[] = [];
  for (const s of WEEK) {
    if (s.tags.some((t) => t.freqId === freqId && roles.includes(t.role)) && !out.includes(s.day)) out.push(s.day);
  }
  return out;
}

/** The week counted the frequency table's way: each primary row a slot belongs to. */
export function mixByPillarDays(): Record<MixGroup, number> {
  const out: Record<MixGroup, number> = { medical: 0, lifestyle: 0, recovery: 0, cancun: 0 };
  for (const s of WEEK) {
    for (const t of s.tags) {
      if (t.role !== 'primary') continue;
      const f = frequencyPillarById(t.freqId);
      if (f) out[f.group] += 1;
    }
  }
  return out;
}

/**
 * Every standing rule that governs a slot: the rules of every frequency row it
 * counts towards. So Sunday's "Recovery in Cancun" carries BOTH the Cancún
 * positioning note and the recovery-services note — it used to carry neither.
 */
export function rulesForSlot(key: string): string {
  const slot = slotByKey(key);
  if (!slot) return '';
  const rules: string[] = [];
  for (const t of slot.tags) {
    const r = frequencyPillarById(t.freqId)?.rule;
    if (r && !rules.includes(r)) rules.push(r);
  }
  return rules.join(' ');
}

/** 'if-health-claim' when a row the slot is primarily about allows it; 'required' otherwise. */
export function citationPolicyForSlot(key: string): CitationPolicy {
  const slot = slotByKey(key);
  if (!slot) return 'required';
  return slot.tags.some((t) => t.role === 'primary' && frequencyPillarById(t.freqId)?.citation === 'if-health-claim')
    ? 'if-health-claim'
    : 'required';
}

/**
 * What the writer is told about a slot beyond its angle: the day's theme, the
 * rows it counts as when there are two, and a pillar woven into it.
 */
export function slotContext(key: string): { dayTheme: string; alsoCovers: string[]; integrated: string[] } | null {
  const slot = slotByKey(key);
  if (!slot) return null;
  const primary = slot.tags.filter((t) => t.role === 'primary').map((t) => frequencyPillarById(t.freqId)?.name || '').filter(Boolean);
  return {
    dayTheme: DAY_THEMES[slot.day],
    alsoCovers: primary.length > 1 ? primary : [],
    integrated: slot.tags.filter((t) => t.role === 'integrated').map((t) => frequencyPillarById(t.freqId)?.name || '').filter(Boolean),
  };
}

/** How many posts a week this calendar holds. The cadence everything else is sized against. */
export const POSTS_PER_WEEK = WEEK.length;

export type PlannedTemplate = {
  name: string;
  weekdays: Weekday[];
  time_of_day: string;
  /** The angle bank the engine rotates through, one per week. */
  pillars: string[];
  rule: string;
  pillarId: string;
  /** slotKey() — the identity the seed matches on. */
  slot: string;
};

/**
 * The 14 templates this strategy becomes.
 *
 * One per slot, each pinned to a SINGLE day, because that is what makes the
 * rotation weekly: lib/autopilot.ts advances the seed list once per occurrence,
 * and a one-day template occurs once a week. A seven-day template would advance
 * it daily and the pillars would drift off their days within a week.
 */
export function plannedTemplates(): PlannedTemplate[] {
  return WEEK.map((slot) => {
    const pillar = pillarById(slot.pillarId);
    if (!pillar) throw new Error('content-strategy: no pillar for slot ' + slot.pillarId);
    return {
      name: pillar.name,
      weekdays: [slot.day],
      time_of_day: SLOT_TIMES[slot.post],
      pillars: pillar.angles.slice(),
      rule: rulesForSlot(slotKey(slot)),
      pillarId: pillar.id,
      slot: slotKey(slot),
    };
  });
}
