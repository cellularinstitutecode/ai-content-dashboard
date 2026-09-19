// web/lib/content-strategy.ts
// The clinic's written content strategy, as data the engine can run.
//
// "CELLULAR INSTITUTE — WEEKLY SOCIAL CONTENT STRATEGY": 14 posts a week, two a
// day, Monday to Sunday, across 8 recurring pillars. Its governing rule is the
// one that makes it hard:
//
//   "Repeat the content pillar, not the wording. Each time a pillar returns,
//    the angle, question, format, or audience should change."
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
  /**
   * A rule that applies to this pillar and no other, appended to the writer's
   * brief. Both of the document's standing notes live here; they had nowhere
   * else to go.
   */
  rule?: string;
};

export type Slot = {
  day: Weekday;
  /** 1 or 2 — "Post 1" and "Post 2" as the document numbers them. */
  post: 1 | 2;
  pillarId: string;
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
    // The document's positioning note, verbatim in substance: comparative
    // superiority claims are the failure mode, specific advantages are the fix.
    rule:
      'Never claim that Cancun is categorically better than any other destination, in Mexico or elsewhere. ' +
      'Write about specific, checkable advantages instead: international air connectivity, tourism ' +
      'infrastructure, hotel options, warm weather, and being able to combine care and recovery in one trip.',
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
    // The document's "soft service integration" note. The distinction it draws —
    // introduced, not promoted — is the whole point: a recovery post that turns
    // into an advertisement for HBOT stops being the educational content this
    // strategy is built on.
    rule:
      'Services may be INTRODUCED here and never promoted: HBOT, red light therapy, PEMF, hydrogen ' +
      'inhalation and the recovery lounge can appear as part of what recovery may involve. Do not build the ' +
      'post around one of them, do not compare them, and do not present any of them as something to buy.',
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

/** The document's day map: two posts a day, Monday through Sunday. */
export const WEEK: Slot[] = [
  { day: 1, post: 1, pillarId: 'diagnosis' },
  { day: 1, post: 2, pillarId: 'protocols' },
  { day: 2, post: 1, pillarId: 'nutrition' },
  { day: 2, post: 2, pillarId: 'supplementation' },
  { day: 3, post: 1, pillarId: 'movement' },
  { day: 3, post: 2, pillarId: 'sleep' },
  { day: 4, post: 1, pillarId: 'prevention' },
  { day: 4, post: 2, pillarId: 'cancun' },
  { day: 5, post: 1, pillarId: 'follow-up' },
  { day: 5, post: 2, pillarId: 'recovery' },
  { day: 6, post: 1, pillarId: 'active-living' },
  { day: 6, post: 2, pillarId: 'practical-nutrition' },
  { day: 0, post: 1, pillarId: 'stress' },
  { day: 0, post: 2, pillarId: 'recovery-cancun' },
];

/**
 * The document's recommended weekly mix — 5 medical, 5 lifestyle, 2 recovery,
 * 2 Cancún — recorded as what it is: a RECOMMENDATION, and one that does NOT
 * agree with the day map printed on the facing page.
 *
 * Counting WEEK by each slot's primary group gives 4 medical, 7 lifestyle,
 * 2 recovery and 1 Cancún. The gap is in the source, and it has two causes:
 *
 *  1. The frequency table hands out sixteen pillar-days for fourteen slots,
 *     because two slots are listed twice. Friday's first post is both
 *     "Personalized protocols — Monday and Friday" and "Patient follow-up —
 *     primarily Friday". Sunday's second post is both "Recovery and
 *     restoration — Friday and Sunday" and "Cancun and health tourism —
 *     Thursday and Sunday"; it is even titled "Recovery, rest, and the Cancun
 *     experience".
 *  2. The mix itself reads as a list of THEMES, not a count of posts:
 *     "5 healthy-lifestyle posts — nutrition, supplementation, sleep,
 *     movement, and stress management" names five subjects, which the day map
 *     spreads over seven slots.
 *
 * So the recommendation is kept verbatim and the day map is kept verbatim, and
 * neither is bent to fit the other. The test asserts both numbers, including
 * the fact that they differ, so a future edit to either one is deliberate.
 */
export const WEEKLY_MIX: Record<MixGroup, number> = {
  medical: 5,
  lifestyle: 5,
  recovery: 2,
  cancun: 2,
};

/** Every slot, in the order the week runs — Monday first, as the document reads. */
export const WEEK_ORDER: Weekday[] = [1, 2, 3, 4, 5, 6, 0];

/** The times the two daily slots default to, clear of the video pipeline's 08:00 / 17:00. */
export const SLOT_TIMES: Record<1 | 2, string> = { 1: '09:00', 2: '18:00' };

export function pillarById(id: string): Pillar | null {
  return PILLARS.find((p) => p.id === id) ?? null;
}

/** The days a pillar appears on, as the document's frequency table states them. */
export function daysFor(pillarId: string): Weekday[] {
  return WEEK.filter((s) => s.pillarId === pillarId).map((s) => s.day);
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
      rule: pillar.rule || '',
      pillarId: pillar.id,
    };
  });
}
