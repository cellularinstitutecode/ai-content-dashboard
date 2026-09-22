// web/lib/planner-image.ts
// What a weekly-planner post's picture should show.
//
// WHY. Every image came out as the same clinic reception room — for protein,
// for personalization, for sleep, and again on "New image". Three things did it:
// the first composition in STYLE_VARIANTS IS the reception, every Autopilot
// draft starts at variant 0, and the Brand Brain's materials line describes the
// clinic interior (travertine, walnut, staff in black scrubs). The pillar and
// the angle never reached the image at all.
//
// So a draft that came from a weekly-strategy slot is pictured from its PILLAR:
// food for nutrition, a bedroom at dusk for sleep, walking or swimming for
// movement, Cancun for the Cancun slots. The clinic appears only where the
// subject is the clinic's own work — assessment, personalization, follow-up.
// The brand's palette and warm light still grade every picture.
//
// A draft with no weekly-strategy provenance (the Draft page, the Video
// Library, hand-written templates) returns null here and is pictured exactly as
// before.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { PILLARS } from './content-strategy.ts';
import { BLOG_SLOT } from './strategy-seed.ts';

export type PlannerImage = {
  pillarId: string;
  pillarName: string;
  /** The week's angle — the picture's real subject. */
  subject: string;
  /** Compositions to rotate through, one per attempt / "New image". */
  scenes: string[];
  /** True when the scene may be inside the clinic. False = the clinic interior must not appear. */
  clinic: boolean;
  /** Square for social posts (sits well on Instagram, Facebook and LinkedIn); landscape for the article hero. */
  size: '1024x1024' | '1536x1024';
  /** One line the vision checker uses to decide whether the picture is on topic. */
  mustShow: string;
};

const CLINIC_NOTE = 'Setting: a calm, warm consultation space in cream and walnut — not a reception desk or waiting room.';

export const PILLAR_SCENES: Record<string, { clinic: boolean; mustShow: string; scenes: string[] }> = {
  diagnosis: {
    clinic: true,
    mustShow: 'a physician carefully reviewing information with an adult patient (an assessment or evaluation moment)',
    scenes: [
      'A physician in black scrubs and an adult patient (45-70) seated side by side, both looking at a blank tablet the physician holds, attentive and unhurried. ' + CLINIC_NOTE,
      'Close, warm detail of a physician\'s hands resting on a closed blank folder beside a stethoscope on a walnut desk, the patient softly out of focus across the desk.',
      'A physician listening closely to an adult patient who is explaining something with open hands; eye-level, natural light. ' + CLINIC_NOTE,
    ],
  },
  protocols: {
    clinic: true,
    mustShow: 'an individual, one-to-one planning conversation between a clinician and one patient',
    scenes: [
      'A clinician and one adult patient sketching a plan together over blank paper on a walnut table, the patient engaged and nodding. ' + CLINIC_NOTE,
      'Three different adults of different ages photographed as a quiet triptych-like group portrait against a warm terracotta backdrop, each distinct — the idea that no two people are the same.',
      'A clinician in black scrubs explaining something to a patient with a gentle hand gesture, the patient\'s face thoughtful. ' + CLINIC_NOTE,
    ],
  },
  nutrition: {
    clinic: false,
    mustShow: 'healthy whole food (protein, vegetables, fruit, water) as the clear subject',
    scenes: [
      'Overhead of a balanced plate on a pale stone table: grilled fish, eggs, legumes, leafy greens and citrus, a glass of water beside it, soft window light.',
      'Adult hands preparing a colourful, protein-rich meal on a warm wooden kitchen counter, fresh vegetables and herbs around.',
      'A simple still life of whole foods — eggs, salmon, lentils, avocado, berries — arranged on linen with generous negative space.',
    ],
  },
  supplementation: {
    clinic: false,
    mustShow: 'a few plain, unlabeled supplement capsules or a pill organiser next to whole food and water',
    scenes: [
      'A small number of plain unlabeled capsules in a ceramic dish beside a glass of water and a bowl of fresh fruit on pale stone — restraint, not abundance.',
      'An adult at a kitchen table thoughtfully looking at a plain unlabeled pill organiser next to a healthy breakfast, morning light.',
      'Minimal still life: one plain glass jar of unlabeled capsules, a lemon and a sprig of herbs on linen, wide negative space.',
    ],
  },
  movement: {
    clinic: false,
    mustShow: 'an adult being physically active (walking, stretching, strength or mobility exercise)',
    scenes: [
      'An adult (50-65) doing a gentle bodyweight squat or lunge in a sunlit room with a yoga mat, relaxed and focused.',
      'A mature adult walking briskly along a tree-lined path in morning light, mid-stride, natural and unposed.',
      'An adult using a light resistance band for a shoulder exercise in a bright, minimal home space.',
    ],
  },
  sleep: {
    clinic: false,
    mustShow: 'a bedroom or a person resting or sleeping peacefully',
    scenes: [
      'A calm bedroom at dusk: linen bedding, warm low lamp light, a book closed on the nightstand, no screens.',
      'An adult sleeping peacefully on their side under soft linen, warm early-morning light through sheer curtains.',
      'Close detail of a made bed with rumpled linen and a glass of water on the nightstand, quiet evening mood.',
    ],
  },
  prevention: {
    clinic: true,
    mustShow: 'a routine, reassuring health check (e.g. blood-pressure cuff, check-up conversation) or a healthy adult looking ahead',
    scenes: [
      'A clinician gently fitting a blood-pressure cuff on a relaxed adult\'s arm, both calm. ' + CLINIC_NOTE,
      'A healthy adult (45-60) looking out of a sunlit window with a calm, forward-looking expression, cup of tea in hand.',
      'A stethoscope, a blank notepad and a pen on a walnut desk in soft light — the quiet start of a check-up.',
    ],
  },
  cancun: {
    clinic: false,
    mustShow: 'Cancun or the Caribbean coast: turquoise sea, white sand, palms or a calm resort setting',
    scenes: [
      'Wide view of a calm turquoise Caribbean shoreline with white sand and palms in soft morning light, a couple walking far in the distance.',
      'A shaded resort terrace overlooking a turquoise sea, two lounge chairs and a glass of water, relaxed and uncrowded.',
      'An adult with a small travel bag arriving at a bright, airy hotel lobby open to palm trees and the sea.',
    ],
  },
  'follow-up': {
    clinic: false,
    mustShow: 'a patient continuing care from home, such as a video call with a clinician or a check-in at home',
    scenes: [
      'An adult at home at a wooden table on a video call with a clinician (screen shows only a blurred face, no interface), notebook beside them, warm light.',
      'A mature adult on their porch reading a blank letter with a gentle smile, morning coffee — care that continues after the trip.',
      'A clinician in black scrubs on a phone call, smiling and attentive, in a calm consultation room. ' + CLINIC_NOTE,
    ],
  },
  recovery: {
    clinic: false,
    mustShow: 'rest and recovery: an adult resting calmly, hydrating, or in a quiet recovery lounge',
    scenes: [
      'An adult resting in a reclined lounge chair with eyes closed in a softly lit, quiet recovery space, a glass of water beside them.',
      'An adult on a sofa at home wrapped in a light blanket, sipping water, calm afternoon light.',
      'A serene recovery lounge with soft warm light, plants and comfortable reclining chairs, nobody rushing.',
    ],
  },
  'active-living': {
    clinic: false,
    mustShow: 'an adult enjoying everyday activity outdoors or in water (walking, swimming, cycling, gardening)',
    scenes: [
      'A mature adult swimming slow laps in a clear outdoor pool, morning sun, calm water.',
      'Two adults in their 60s walking on a beach path in sneakers, laughing, mid-stride.',
      'An adult gardening or cycling on a quiet street, relaxed and active, warm daylight.',
    ],
  },
  'practical-nutrition': {
    clinic: false,
    mustShow: 'practical everyday food choices: a breakfast, a snack or a restaurant meal',
    scenes: [
      'A protein-rich breakfast on a sunny table: Greek yogurt with berries, eggs, whole-grain toast and coffee.',
      'A healthy restaurant meal on a terrace table — grilled fish, salad, water — seen from the diner\'s seat.',
      'A small container of nuts, fruit and cheese packed for travel beside a small travel pouch on a hotel desk.',
    ],
  },
  stress: {
    clinic: false,
    mustShow: 'calm and stress relief: breathing, relaxation, a quiet ritual or peaceful nature',
    scenes: [
      'An adult sitting cross-legged on a terrace at sunrise, eyes closed, breathing slowly, soft golden light.',
      'Hands wrapped around a warm cup of herbal tea by a window on a quiet evening.',
      'An adult reading in a hammock in dappled shade, fully relaxed.',
    ],
  },
  'recovery-cancun': {
    clinic: false,
    mustShow: 'a calm recovery day in Cancun: beach, sea, shade, a gentle walk or rest by the water',
    scenes: [
      'An adult resting under a beach umbrella facing a calm turquoise sea, a companion reading nearby.',
      'A couple taking a slow walk along the waterline on white sand at golden hour.',
      'A quiet hotel balcony with a lounge chair, a book and a view over palms to the Caribbean.',
    ],
  },
};

const ARTICLE = {
  clinic: true,
  mustShow: 'a thoughtful physician-patient conversation or careful medical assessment',
  scenes: PILLAR_SCENES.diagnosis.scenes,
};

function key(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Strip the "[Autopilot] " prefix the draft's topic column carries. */
export function cleanTopic(topic: unknown): string {
  return String(topic ?? '').replace(/^\s*\[autopilot\]\s*/i, '').trim();
}

/**
 * The picture brief for a draft, read from its `_autopilot` provenance.
 * Null when the draft did not come from a weekly-strategy slot.
 */
export function plannerImageFor(pack: unknown): PlannerImage | null {
  const auto = (pack && typeof pack === 'object' ? (pack as Record<string, unknown>)._autopilot : null) as
    | { template_name?: unknown; angle?: { query?: unknown; seedTopic?: unknown } }
    | null
    | undefined;
  if (!auto || typeof auto !== 'object') return null;
  const name = key(auto.template_name);
  const subject = cleanTopic(auto.angle?.query || auto.angle?.seedTopic);
  if (!name || !subject) return null;
  if (name === key(BLOG_SLOT.name)) {
    return { pillarId: 'article', pillarName: BLOG_SLOT.name, subject, ...ARTICLE, size: '1536x1024' };
  }
  const pillar = PILLARS.find((p) => key(p.name) === name);
  if (!pillar) return null;
  const scene = PILLAR_SCENES[pillar.id];
  if (!scene) return null;
  return { pillarId: pillar.id, pillarName: pillar.name, subject, ...scene, size: '1024x1024' };
}

/** The lines added to the image prompt for a planner draft. */
export function plannerPromptLines(p: PlannerImage, sceneIndex: number): string[] {
  const scene = p.scenes[Math.abs(Math.round(sceneIndex)) % p.scenes.length];
  return [
    `Subject: ${p.subject} (the weekly "${p.pillarName}" theme). The picture must clearly show ${p.mustShow}.`,
    `Composition: ${scene}`,
    p.clinic
      ? 'If a clinic space appears it is a warm consultation room — never a reception desk, front desk or waiting room.'
      : 'This scene is NOT inside the clinic: no reception desk, no waiting room, no clinic interior, no staff in scrubs. Use the brand palette and warm light only as colour grading.',
  ];
}

/** The extra check the vision reviewer runs on a planner image. */
export function onTopicCheck(p: PlannerImage): string {
  return `ON-TOPIC (this one is a DEFECT, not an opinion): the image must clearly show ${p.mustShow}. ` +
    'A generic clinic reception, front desk or waiting room does NOT count' +
    (p.clinic ? '' : ', and neither does any clinic interior') +
    '. Set "onTopic": false when it fails.';
}
