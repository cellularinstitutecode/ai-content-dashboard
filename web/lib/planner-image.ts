// web/lib/planner-image.ts
// What a weekly-planner post's picture should show, and the title it carries.
//
// THE LOOK THE CLINIC ASKED FOR. The reference the team chose is a bright,
// airy consultation: a physician in a cream blazer talking with a patient
// across a light oak table in window daylight, the topic told by what is on the
// table (a book of food photographs and a bowl of oranges for nutrition), warm
// beige walls, a plant, a soft view outside — and ONE elegant serif title at
// the top, "The Importance of Nutrition", with a thin rule under it. Nothing
// else written on it.
//
// HOW WE GET THERE WITHOUT GARBLED LETTERS. Image models misspell. So the
// photograph is generated text-free and verified exactly as before, with the
// top third deliberately left as a calm wall; the title is then SET by our own
// renderer (lib/title-cover.ts) in the brand's serif. The words are exact,
// always, and the clean photograph is kept alongside for a re-title.
//
// WHY THE EARLIER PICTURES MISSED. Every image came out as the same dark
// reception room: the first composition in STYLE_VARIANTS is the reception,
// every Autopilot draft starts at variant 0, and the Brand Brain's materials
// line (travertine, walnut, staff in black scrubs) pulled everything indoors
// and dark. The pillar and angle never reached the image. All three are fixed
// here — for planner drafts only.
//
// A draft with no weekly-strategy provenance (the Draft page, the Video
// Library, hand-written templates) returns null here and is pictured exactly as
// before.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { PILLARS } from './content-strategy.ts';
import { BLOG_SLOT } from './strategy-seed.ts';
import type { SceneBrief } from './image-brief.ts';

export type PlannerImage = {
  pillarId: string;
  pillarName: string;
  /** The week's angle — the picture's real subject. */
  subject: string;
  /** The words set on the cover. Short, exact, written by a person (TITLES below). */
  title: string;
  /** Compositions to rotate through, one per attempt / "New image". */
  scenes: string[];
  /** Portrait: cropped to Instagram's 4:5 when the title is set. */
  size: '1024x1536';
  /** One line the vision checker uses to decide whether the picture is on topic. */
  mustShow: string;
  /**
   * Written from THIS post's text just before generation (lib/image-brief.ts).
   * When present it replaces the pillar's fixed scene and cue, so the picture
   * shows what the post is actually about.
   */
  dynamic?: SceneBrief;
  /**
   * True when the post's own body talks about biology — cells, tissue,
   * mitochondria, inflammation, immune response. Only then is the Cell science
   * family offered, so a walking post never comes back as a microscope field.
   */
  science?: boolean;
  /**
   * The family the take being verified came from, stamped by lib/images.ts per
   * variant. The on-topic check reads it, because "show the objects the post
   * names" is the wrong question to ask of a microscopy frame.
   */
  shotFamily?: ShotFamily;
};

/**
 * The photographic language of the reference, in words an image model follows.
 * Replaces the Brand Brain's materials line for planner images (that line
 * describes the clinic's dark interior); the palette still grades the frame.
 */
export const PLANNER_PHOTOGRAPHY = [
  'Photographic style: a bright, airy editorial lifestyle photograph in soft natural daylight from a large window.',
  'Warm beige, cream, sand and soft terracotta tones; a light oak table, pale stone and linen; one or two green plants or an olive branch in a ceramic vase;',
  'through the window, a soft-focus view of greenery or hills.',
  'The physician wears a tailored white or cream blazer over a neutral top — never scrubs, never a lab coat with logos — with a warm, attentive, approachable expression.',
  'The patient is seen three-quarter from behind or in soft profile, relaxed and engaged.',
  '35-50mm lens from slightly above eye level, shallow depth of field, realistic skin and hands, natural unposed moment.',
  'The mood of a trusted private practice — calm, premium, welcoming — never a hospital, never a waiting room or reception desk.',
].join(' ');

/** The instruction that leaves room for the title the renderer sets later. */
export const TITLE_SPACE =
  'Composition rule (important): the upper 30% of the frame is EMPTY — a plain, softly lit warm-beige wall with nothing on it ' +
  '(no art, no shelves, no lamps, no signs, no objects) — because a title will be placed there afterwards. ' +
  'Everyone\'s head sits below that band. The table top and the key objects are in the lower third, LARGE, sharp and ' +
  'fully visible, well above the bottom edge — they tell the story, so they must never be small, blurred or cut off. Vertical framing.';

type SceneSet = { mustShow: string; scenes: string[] };

const TABLE = 'on the light oak table between them';

export const PILLAR_SCENES: Record<string, SceneSet> = {
  diagnosis: {
    mustShow: 'a physician carefully reviewing information with a patient — a stethoscope, a blank folder or a blank tablet on the table',
    scenes: [
      `A physician and an adult patient (45-65) seated across a table in a consultation; the physician holds a closed blank folder and listens closely; a stethoscope rests ${TABLE}, beside a glass of water and a small plant.`,
      `A physician leaning in, pointing with a pen at a blank tablet screen that faces the patient; the patient nods; a stethoscope and a ceramic cup ${TABLE}.`,
      'A physician listening attentively as the patient explains something with open hands; a notebook with blank pages and a pen lie on the table; a bowl of lemons adds warmth.',
    ],
  },
  protocols: {
    mustShow: 'a one-to-one planning conversation — the physician sketching or explaining an individual plan to one patient',
    scenes: [
      `A physician sketching a plan on a blank notepad and turning it toward the patient, both smiling slightly; ${TABLE}, a small vase of eucalyptus and two cups of tea.`,
      'A physician explaining with a gentle hand gesture while the patient, a man in his 50s, listens thoughtfully; a blank tablet and reading glasses on the table.',
      'Close, warm moment: the physician places a hand near the patient\'s hand on the table in reassurance while talking through options; a notebook with blank pages between them.',
    ],
  },
  nutrition: {
    mustShow: 'healthy food on the table during the consultation — a bowl of fresh fruit, vegetables, or a book open to full-page food photographs',
    scenes: [
      `A physician pointing with a pen at a book open to full-page photographs of avocado, greens, grains and salmon ${TABLE}; a ceramic bowl of oranges with leaves in the foreground; the patient leans in, interested.`,
      `A physician and patient in conversation over a small spread of whole foods ${TABLE} — a bowl of berries, sliced avocado, eggs and a carafe of water.`,
      'A physician holding an orange and smiling as she explains; a bowl of citrus and a plate of leafy greens and nuts on the table; the patient seen from behind.',
    ],
  },
  supplementation: {
    mustShow: 'a small dish of a few plain, unlabeled capsules next to a glass of water and fresh fruit on the consultation table',
    scenes: [
      `A physician gesturing toward a small ceramic dish holding a few plain unlabeled capsules ${TABLE}, next to a glass of water and a bowl of fruit; the patient listens with a thoughtful expression.`,
      'A physician reviewing a blank tablet with the patient; in the foreground a single plain glass jar of unlabeled capsules, a lemon and a sprig of herbs.',
      'A physician holding up one plain capsule between two fingers while explaining; a glass of water and a bowl of greens on the table.',
    ],
  },
  movement: {
    mustShow: 'movement or exercise in the consultation — a resistance band, a gentle range-of-motion check, or the patient in light activewear',
    scenes: [
      'A physician gently guiding a seated patient\'s knee through a slow range-of-motion check; the patient wears light activewear; a rolled yoga mat leans against the wall; plants and daylight.',
      `A physician handing a light resistance band to a patient in their 60s wearing activewear; a water bottle and a small towel ${TABLE}.`,
      'Physician and patient standing near the window; the physician demonstrates a simple shoulder stretch and the patient mirrors it, both relaxed and smiling.',
    ],
  },
  sleep: {
    mustShow: 'sleep and rest cues in the consultation — a cup of herbal tea, a lavender sprig, soft evening light, a relaxed patient',
    scenes: [
      `A calm consultation in soft late-afternoon golden light; a cup of chamomile tea and a small bunch of lavender ${TABLE}; the patient relaxed with shoulders down as the physician speaks gently.`,
      'A physician listening as the patient, holding a warm mug with both hands, describes their evenings; a linen throw on the chair and a lavender sprig on the table.',
      'A physician and patient sitting side by side on a linen sofa in a quiet corner of the practice, a cup of herbal tea on a side table, warm dusk light through sheer curtains.',
    ],
  },
  prevention: {
    mustShow: 'a routine, reassuring check-up — a blood-pressure cuff on the patient\'s arm or a stethoscope in use',
    scenes: [
      'A physician fitting a blood-pressure cuff on the relaxed patient\'s upper arm at the table, both calm and smiling; a plant and daylight behind.',
      'A physician listening with a stethoscope to the back of a seated patient in their 50s, natural light, reassuring atmosphere.',
      `A physician and a healthy adult patient in a relaxed conversation; a stethoscope and a blank notebook ${TABLE}, a bowl of green apples beside them.`,
    ],
  },
  cancun: {
    mustShow: 'Cancun: the window or terrace behind the consultation shows the turquoise Caribbean sea, white sand or palm trees',
    scenes: [
      'A bright consultation beside a large window that opens onto the turquoise Caribbean sea and palm trees; physician and patient talk across a light oak table; a bowl of tropical fruit on the table.',
      'Physician and patient seated on a shaded terrace of the practice overlooking a calm turquoise sea, two glasses of water with lime on a small table.',
      'A patient with a small travel bag beside the chair, smiling as the physician welcomes them; through the window, palms and a turquoise sea in soft focus.',
    ],
  },
  'follow-up': {
    mustShow: 'follow-up care — the patient reviewing progress with the physician, or a video call from home with the physician',
    scenes: [
      'A physician and a returning patient smiling as they review progress together on a blank tablet; a notebook with blank pages and a plant on the table.',
      'An adult at a light oak table at home, on a video call with a physician (the laptop screen shows only a softly blurred face, no interface), a cup of coffee and a notebook beside them, warm daylight.',
      'A physician shaking hands warmly with a patient at the end of a consultation, both smiling; daylight and plants behind.',
    ],
  },
  recovery: {
    mustShow: 'rest and recovery — the patient resting comfortably with a glass of water while the physician checks in',
    scenes: [
      'A patient resting in a reclined cream lounge chair with a light linen blanket and a glass of water, the physician crouching beside them kindly checking in; plants and soft daylight.',
      'A physician handing a glass of water to a relaxed patient sitting on a linen sofa, a folded blanket nearby, calm afternoon light.',
      'A quiet recovery corner of the practice with reclining chairs and plants; the physician and patient talking softly, the patient comfortable with feet up.',
    ],
  },
  'active-living': {
    mustShow: 'an active patient — light activewear, sneakers or a water bottle — chatting with the physician, with an outdoor path or pool visible',
    scenes: [
      'A physician chatting with a fit patient in their 60s dressed in light activewear and sneakers, a water bottle on the table; through the window, a tree-lined walking path.',
      'Physician and patient standing by an open door to a garden path, the patient holding a water bottle and a small towel, both laughing easily.',
      'A physician and a mature couple in activewear talking at the table, a rolled yoga mat and a water bottle beside them, bright daylight.',
    ],
  },
  'practical-nutrition': {
    mustShow: 'an everyday healthy meal or snack on the table — a protein-rich breakfast, a snack box, or a balanced plate',
    scenes: [
      `A physician gesturing at a protein-rich breakfast ${TABLE} — Greek yogurt with berries, eggs, whole-grain toast — while the patient smiles; a bowl of oranges in the foreground.`,
      'A physician and patient looking at a small reusable box of nuts, fruit and cheese — a travel snack — set between them, relaxed conversation.',
      'A balanced plate of grilled fish, salad and quinoa on the table as the physician explains portions with open hands; a carafe of water with lemon.',
    ],
  },
  stress: {
    mustShow: 'calm and stress relief — the patient breathing slowly with eyes softly closed, or holding a warm cup of tea',
    scenes: [
      'A physician guiding the patient through a slow breath, both with a hand resting on the chest, eyes softly closed, serene expressions; plants and soft light.',
      `The patient holding a warm cup of herbal tea with both hands, shoulders relaxed, as the physician speaks gently; a small ceramic dish of dried lavender ${TABLE}.`,
      'Physician and patient seated in two armchairs angled toward a window full of greenery, a peaceful pause in the conversation.',
    ],
  },
  'recovery-cancun': {
    mustShow: 'a calm recovery day in Cancun — a shaded terrace or window with the turquoise sea, the patient resting',
    scenes: [
      'A patient resting on a shaded terrace lounge chair overlooking a turquoise Caribbean sea, the physician seated beside them in a light blazer checking in; a glass of water with lime.',
      'A physician and patient walking slowly along a palm-lined path by the sea, both relaxed, the patient in light clothing and a hat.',
      'A companion and the patient sitting together by a large window with a sea view while the physician talks with them, a bowl of tropical fruit on the table.',
    ],
  },
};

/**
 * The cover titles: one short headline per angle the strategy lists.
 *
 * Written, not generated — they appear in large type on the picture, so each
 * one was chosen to read like the reference ("The Importance of Nutrition"):
 * a few words, title case, no claim. An angle that is not listed falls back to
 * "The Importance of <pillar>".
 */
export const TITLES: Record<string, string> = {
  // Diagnosis and assessment
  'Why effective care begins with a thorough evaluation': 'Care Begins with Evaluation',
  'Why similar symptoms may have different causes': 'Same Symptoms, Different Causes',
  'What information a physician needs before recommending a protocol': 'What Your Physician Needs to Know',
  'The importance of reviewing laboratory results, imaging, and medical history': 'Why Your Medical History Matters',
  'Why comparing treatments without comparing evaluations can be misleading': 'Compare Evaluations, Not Just Treatments',
  // Personalization
  'Why one protocol does not work the same way for every person': 'No Two Patients Are Alike',
  'How age, diagnosis, medications, and lifestyle influence planning': 'What Shapes Your Care Plan',
  'The difference between a standard package and a personalized medical plan': 'A Plan, Not a Package',
  'How therapies, number of sessions, and routes of administration are selected': 'How a Protocol Is Designed',
  'Why the right protocol depends on the patient, not only the condition': 'The Patient, Not Just the Condition',
  // Nutrition
  'The role of protein in recovery': 'Protein and Recovery',
  'Nutrition and inflammation': 'Nutrition and Inflammation',
  'Hydration and cellular health': 'Hydration and Cellular Health',
  'Nutrients that help support muscle mass': 'Nutrients for Muscle Health',
  'How to prepare the body nutritionally before treatment': 'Eating Well Before Treatment',
  'Nutrition during the recovery process': 'Nutrition During Recovery',
  // Supplementation
  'Why supplementation should also be personalized': 'Personalized Supplementation',
  'Why more supplements do not necessarily mean better results': 'More Is Not Always Better',
  'Possible interactions between supplements and medications': 'Supplements and Medications',
  'The importance of identifying actual deficiencies': 'Know Your Real Deficiencies',
  'What to review before beginning a supplement routine': 'Before You Start Supplements',
  'Supplements as support, not a substitute for healthy habits': 'Support, Not a Substitute',
  // Movement
  'Why staying active matters at every age': 'Active at Every Age',
  'Muscle strength and longevity': 'Strength and Longevity',
  'Movement as a way to support joint health': 'Movement for Healthy Joints',
  'The difference between physical activity and structured training': 'Activity vs. Training',
  'How to begin moving when pain or limited mobility is present': 'Moving with Limited Mobility',
  'Why exercise should be adapted to the individual': 'Exercise Made for You',
  // Sleep
  'What happens in the body while we sleep': 'What Happens While We Sleep',
  'The relationship between sleep and recovery': 'Sleep and Recovery',
  'How poor sleep can affect inflammation': 'Sleep and Inflammation',
  'The connection between sleep, appetite, and metabolism': 'Sleep, Appetite and Metabolism',
  'Simple habits that may improve sleep quality': 'Habits for Better Sleep',
  'Why sleeping longer does not always mean resting better': 'Longer Sleep, Better Rest?',
  // Prevention
  'Why you should not wait until you feel unwell to assess your health': "Don't Wait to Feel Unwell",
  'The value of periodic health evaluations': 'The Value of Regular Check-Ups',
  'Biomarkers that help build a broader picture of health': 'What Your Biomarkers Tell',
  'Identifying changes before they affect quality of life': 'Catching Changes Early',
  'Establishing a baseline to help measure progress': 'Know Your Baseline',
  'The difference between addressing symptoms and exploring possible causes': 'Symptoms and Their Causes',
  // Cancun and health tourism
  'Why Cancun is well suited for combining medical care and rest': 'Care and Rest in Cancun',
  'Air connectivity from the United States and Canada': 'An Easy Flight to Cancun',
  'Recovering in a calm, warm environment': 'Recovering in the Warmth',
  'Hotel, dining, and low-impact activity options': 'Staying Well in Cancun',
  'What patients can do during open days in their protocol': 'Your Open Days in Cancun',
  'How to organize a medical trip that feels supported and comfortable': 'Planning a Supported Medical Trip',
  // Personalization and follow-up
  'Why a protocol may be adjusted as the patient progresses': 'A Plan That Evolves with You',
  'The importance of monitoring changes over time': 'Tracking Progress Over Time',
  'What happens after a patient returns home': 'After You Return Home',
  'How follow-ups at 1, 3, 6, and 12 months support continuity of care': 'Follow-Up at 1, 3, 6 and 12 Months',
  'Why care does not end when the patient leaves the clinic': 'Care Beyond the Clinic',
  'How progress can be evaluated while maintaining realistic expectations': 'Progress and Realistic Expectations',
  // Recovery
  'Recovery as part of the overall care plan': 'Recovery Is Part of Care',
  'Why the body needs time to respond': 'Giving Your Body Time',
  'Hydration, rest, and movement after treatment': 'Rest, Hydration and Movement',
  'Technologies that may support the recovery experience': 'Supporting Your Recovery',
  'What it means to build a personalized recovery plan': 'Your Personal Recovery Plan',
  'Why patients should avoid overloading the body immediately afterward': 'Ease Back Gently',
  // Active living
  'Simple activities that help people stay active': 'Simple Ways to Stay Active',
  'Walking, swimming, and mobility exercises': 'Walk, Swim, Move',
  'Maintaining muscle mass after 40, 50, or 60': 'Muscle After 40, 50 and 60',
  'Ways to incorporate movement while traveling': 'Moving While You Travel',
  'Options when intense exercise is not appropriate': 'Gentler Ways to Move',
  'Why consistency often matters more than intensity': 'Consistency Over Intensity',
  // Practical nutrition
  'Protein-rich breakfast ideas': 'Protein-Rich Breakfasts',
  'How to make balanced choices while traveling': 'Eating Well While Traveling',
  'Snacks that support steady energy': 'Snacks for Steady Energy',
  'How to read a nutrition label': 'Reading a Nutrition Label',
  'Common mistakes when trying to eat healthier': 'Common Healthy-Eating Mistakes',
  'What to consider when ordering at a restaurant during recovery': 'Dining Out During Recovery',
  // Sleep, stress, and rest
  'How stress can influence recovery': 'Stress and Recovery',
  'Why the body needs intentional rest': 'The Need for Intentional Rest',
  'Simple rituals to close the week': 'Rituals to Close the Week',
  'Breathing, relaxation, and the nervous system': 'Breathing and the Nervous System',
  'Mental and physical recovery': 'Mind and Body Recovery',
  'Why rest is a meaningful part of well-being': 'Rest Is Part of Well-Being',
  // Recovery in Cancun
  'What a recovery day in Cancun may look like': 'A Recovery Day in Cancun',
  'Low-intensity activities for patients': 'Gentle Activities for Patients',
  'Nature, the beach, and a calmer pace': 'Nature and a Calmer Pace',
  'How treatment can be combined with time to rest': 'Treatment and Time to Rest',
  'What a companion can do during the trip': 'Traveling with a Companion',
  'The patient experience before, during, and after the clinic visit': 'Before, During and After Your Visit',
};

function key(s: unknown): string {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Strip the "[Autopilot] " prefix the draft's topic column carries. */
export function cleanTopic(topic: unknown): string {
  return String(topic ?? '').replace(/^\s*\[autopilot\]\s*/i, '').trim();
}

const TITLE_BY_KEY = new Map(Object.entries(TITLES).map(([a, t]) => [key(a), t]));

/** The cover title for an angle; "The Importance of <pillar>" when the angle is not one the strategy lists. */
export function titleFor(angle: unknown, pillarName: string): string {
  return TITLE_BY_KEY.get(key(cleanTopic(angle))) || `The Importance of ${pillarName}`;
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
    // The article's angles are borrowed from the medical pillars; picture it as
    // the pillar it came from.
    const pillar = PILLARS.find((p) => p.angles.some((a) => key(a) === key(subject)));
    const set = (pillar && PILLAR_SCENES[pillar.id]) || PILLAR_SCENES.diagnosis;
    return { pillarId: 'article', pillarName: BLOG_SLOT.name, subject, title: titleFor(subject, pillar?.name || 'Evaluation'), ...set, size: '1024x1536' };
  }
  const pillar = PILLARS.find((p) => key(p.name) === name);
  if (!pillar) return null;
  const set = PILLAR_SCENES[pillar.id];
  if (!set) return null;
  return { pillarId: pillar.id, pillarName: pillar.name, subject, title: titleFor(subject, pillar.name), ...set, size: '1024x1536' };
}

/** The lines the image prompt carries for a planner draft (the photograph only — the title is set later). */
/**
 * THE MASTER SHOT — the team's reference photograph, described closely enough
 * that every planner image reads as part of the same series. Only three things
 * change from post to post: what is on the table, what the physician is doing
 * with her hands, and (for the Cancun themes) the view through the window.
 * Composition, people, wardrobe, light and palette stay fixed.
 */
/**
 * THE SHOT LIBRARY.
 *
 * One fixed composition made every post look like the last one: the same woman
 * at the same desk, every week. A real editorial feed varies the shot — a
 * still life, a detail of hands, a candid moment, a wide room — while the
 * light, palette and craft hold it together. Each post picks its shot from its
 * own title (so two posts rarely share one) and "New image" moves to the next.
 */
/**
 * THE FOUR FAMILIES.
 *
 * Research into the pages outranking us (September 2026) settled these weights.
 * The clinics at the top of the SERP lead with cells on science posts and with
 * life-after-treatment on commercial pages; none of them leads with a
 * consultation, which is precisely why the consultation is ours to own. It is
 * the spine — but on its own it reads softer than the competition, so the other
 * three carry the rest.
 *
 *   consult  ~50%   the room, the conversation, the clinician
 *   science  ~25%   real microscopy and real lab work (topic-gated)
 *   active   ~15%   the outcome: a person living well
 *   still    ~10%   the objects the post itself names
 */
export type ShotFamily = 'consult' | 'science' | 'active' | 'still';

export type Shot = {
  id: string;
  /**
   * What the picture reads as at a glance. Three shots can all be "two people
   * at a table" and still look like one photograph repeated, so the rotation
   * below steps through FAMILIES before it steps within one.
   */
  family: ShotFamily;
  /** True when people appear — the headroom rule and casting only matter then. */
  people: boolean;
  lines: (ctx: ShotContext) => string[];
};

type ShotContext = { objects: string; foreground: string; action: string; windowView: string; cast: Cast; subject: string };

type Cast = { clinician: string; patient: string };

/** Casting varies with the post, so the feed is not one actress over and over. */
const CLINICIANS = [
  'a woman in her early 40s, Latina, dark wavy shoulder-length hair, tailored ivory blazer over a soft beige blouse, fine gold necklace',
  'a man in his late 40s, salt-and-pepper close-cropped hair, light grey knit polo under an unstructured cream jacket, no tie',
  'a woman in her mid 50s, Black, short natural hair, camel silk shirt and slim tortoiseshell glasses',
  'a man in his mid 30s, Asian, neat dark hair, pale blue oxford shirt with the sleeves rolled, no jacket',
  'a woman in her late 30s, fair-skinned with light-brown hair in a low twist, stone-coloured linen blazer',
];
const PATIENTS = [
  'a woman in her 60s with short silver hair and a cream linen shirt',
  'a man in his 50s, broad-shouldered, in a soft olive sweater',
  'a woman in her 40s, Latina, long dark hair, in an oatmeal knit',
  'a man in his 70s, thin silver hair, pale blue shirt, relaxed and curious',
  'a woman in her 30s, athletic, hair tied back, in a sand-coloured sweatshirt',
];

/** The craft: what separates an editorial photograph from an obvious AI render. */
export const CRAFT = [
  'CRAFT: shot for a premium health magazine — Leica 50mm at f/2 on medium-format digital, natural window light through a large diffusion scrim,',
  'gentle falloff into soft shadow, true-to-life colour with a warm neutral grade, fine natural grain, a touch of optical halation in the highlights.',
  'Real skin with visible texture, pores and fine lines; no beauty retouching, no plastic sheen, no over-sharpening, no HDR.',
  'Nobody grins at the camera: expressions are quiet, warm and mid-moment, eyes usually off-camera. No stock-photo posing, no thumbs-up, no crossed arms.',
  'Clean, uncluttered set dressing: EVERY object in frame comes from what the post itself talks about. No decorative filler —',
  'no bowl of fruit, no flowers, no props added merely to fill the corner, unless the post is about them.',
  'NO RENDERS: every frame is a photograph taken with a camera. No 3D renders, no illustrations, no glowing or neon cells, no bloom, ',
  'no lens flare, no floating particles, no DNA helices, no digital overlays — the look every competing clinic already has.',
  'REAL THINGS ONLY: this is clinic photography, not a classroom. Everything in frame is an ordinary real object — real food, real cups,',
  'real paper, real linen. Absolutely no anatomical models, plastic organs, model brains, hearts or spines, skeletons, skulls, mannequins,',
  'torso models or other medical teaching props; no anatomical charts, posters, diagrams, illustrations or infographics of any kind.',
  'COLOUR: neutral white balance, daylight-accurate skin tones, a calm cream-and-oat palette with pale sage and soft grey-green;',
  'terracotta appears only as the smallest accent, if at all. No orange cast, no amber filter, no heavy golden-hour wash, no sepia.',
].join(' ');

/** The world every shot lives in. */
const WORLD = 'THE PLACE: a calm, light-filled private practice in Cancún — soft off-white and oat plaster walls, pale oak furniture, linen and ' +
  'light stone, a few living green plants, tall windows with sheer curtains and clear daylight. Palette: white, cream, oat, pale sage and light ' +
  'grey-green, with wood as the only warm tone.';

/** The band the title needs, worded for the shot at hand. */
const titleBand = (people: boolean) =>
  'TITLE SPACE: the upper third of the frame is quiet, softly lit wall or empty background with nothing in it — a title is set there afterwards.' +
  (people ? ' The top of every head sits at least 35% of the way down the frame; pull the camera back rather than crop.' : '');

export const SHOTS: Shot[] = [
  {
    id: 'consultation',
    family: 'consult',
    people: true,
    lines: (c) => [
      'SHOT: an over-the-shoulder consultation, vertical.',
      `FOREGROUND RIGHT, large and softly out of focus, seen from behind: the patient — ${c.cast.patient}.`,
      `ACROSS THE HONEY-OAK TABLE, centre-left: the clinician — ${c.cast.clinician} — mid-sentence, ${c.action}.`,
      `ON THE TABLE, clearly visible and sharp: ${c.objects}. In the lower-left foreground, slightly soft: ${c.foreground}.`,
      `BEHIND, LEFT: a tall window with warm afternoon light and a soft-focus view of ${c.windowView}.`,
    ],
  },
  {
    id: 'still-life',
    family: 'still',
    people: false,
    lines: (c) => [
      'SHOT: an editorial still life, no people at all, vertical.',
      `THE SUBJECT, arranged with restraint on pale stone or linen in low raking window light: ${c.objects}, with ${c.foreground} just behind.`,
      'Shallow depth of field, long soft shadows falling to the right, a few crumbs, drops or fallen leaves left where they fell — real, not styled to death.',
      'The background is a plain warm wall falling into shadow toward the top of the frame.',
    ],
  },
  {
    id: 'hands',
    family: 'consult',
    people: true,
    lines: (c) => [
      'SHOT: a close detail across the consultation table, vertical. Two pairs of adult hands — the clinician\'s and the patient\'s — no faces in frame, or only a jaw and a shoulder at the very edge.',
      `THE ACTION, filling the lower two-thirds: the clinician's hands ${c.action}, with ${c.objects} on the honey-oak table between them and ${c.foreground} nearby; the patient's hands rest at the edge of frame, listening.`,
      'Skin is real — knuckles, veins, a wedding ring; a cuff of an ivory blazer at one wrist. The movement is caught mid-gesture, slightly soft at the edges.',
      'Above the hands, the frame opens into plain sunlit tabletop and consulting-room wall.',
    ],
  },
  {
    id: 'candid',
    family: 'active',
    people: true,
    lines: (c) => [
      'SHOT: a candid lifestyle moment away from the clinic, vertical — this is the patient\'s own life, not a medical setting.',
      `THE PERSON: ${c.cast.patient}, absorbed in what they are doing, unaware of the camera, in a home, kitchen, garden or seafront that suits "${c.subject}".`,
      `IN FRAME WITH THEM, unmistakable: ${c.objects}; ${c.foreground} nearby.`,
      'Natural daylight, honest everyday setting, nothing staged.',
    ],
  },
  {
    id: 'environment',
    family: 'consult',
    people: true,
    lines: (c) => [
      'SHOT: a wide environmental frame of the practice, vertical, people small within it.',
      `IN THE LOWER HALF: the clinician — ${c.cast.clinician} — and the patient — ${c.cast.patient} — seated at a table, talking, ${c.action}.`,
      `On the table, catching the light: ${c.objects}; ${c.foreground} in the near foreground, out of focus.`,
      `The room breathes around them: tall windows onto ${c.windowView}, sheer curtains moving, plants, warm shadow across the upper wall.`,
    ],
  },
  {
    id: 'portrait',
    family: 'consult',
    people: true,
    lines: (c) => [
      'SHOT: a three-quarter editorial portrait, vertical, the subject turned slightly away and looking out of frame.',
      `THE SUBJECT: ${c.cast.clinician}, caught in a quiet moment of thought, one hand resting near ${c.objects} on the table.`,
      `Just behind, softly out of focus: ${c.foreground} and a window with a view of ${c.windowView}.`,
      'A single soft key light from the window, shadow falling gently across the wall above.',
    ],
  },
  {
    id: 'flat-lay',
    family: 'still',
    people: false,
    lines: (c) => [
      'SHOT: an overhead flat lay on a pale linen or light oak surface, no people at all, vertical.',
      `LAID OUT IN THE LOWER TWO-THIRDS, shot straight down, evenly spaced with generous space between them: ${c.objects}, with ${c.foreground} at one edge.`,
      'Soft diffused daylight from one side, gentle shadows, nothing stacked or crowded, the arrangement calm rather than decorative.',
      'The upper third is bare surface — no object crosses into it.',
    ],
  },
  {
    id: 'microscopy',
    family: 'science',
    people: false,
    lines: () => [
      'SHOT: a PHOTOGRAPH taken down a laboratory microscope — a phase-contrast photomicrograph, captured with a camera on the eyepiece, vertical.',
      'THE FIELD, filling the lower two-thirds: living adherent cells in culture at about 100x. Slender spindle and stellate shapes lying flat in the plane '
        + 'of the dish, each with a darker nucleus and fine cytoplasmic texture, processes reaching out and touching neighbours; a few rounded, bright, '
        + 'refractile cells among them. Density uneven, orientation random, a little debris — a real dish, not a pattern.',
      'The optics are honest: a shallow plane of focus so cells drift soft toward the edges, faint halo fringing around each cell the way phase contrast '
        + 'actually renders it, slight chromatic softness at the corners, the gentle circular vignette of the objective.',
      'Colour: near-monochrome cool grey with the faintest warm cast from the medium. Nothing saturated, nothing glowing.',
      'IT IS NOT A PICTURE OF CELLS — it is a photograph of a microscope field. No 3D rendering, no illustration, no embossed or raised relief, no smooth '
        + 'plastic shapes, no glow, no bloom, no lens flare, no floating spheres in empty space, no scale bar, no labels, no arrows, no colour overlay.',
      'The upper third is plain, even, out-of-focus medium — empty and quiet.',
    ],
  },
  {
    id: 'lab-bench',
    family: 'science',
    people: true,
    lines: (c) => [
      'SHOT: a working laboratory, vertical, documentary rather than staged.',
      `IN THE LOWER HALF: a researcher — ${c.cast.clinician} — in a white coat, hair covered, blue nitrile gloves, `
        + 'holding a clear culture plate or a flask up to the light of an open laminar-flow hood, reading it, absorbed.',
      'Around them: brushed stainless, white bench, a closed incubator, a rack of clean unlabelled glassware, a microscope at the edge of frame.',
      'Cool even laboratory light, clean whites, no colour cast. No needles, no syringes, no blood, no ampoules, nothing labelled, no packaging, no branding.',
      'The upper third is plain clean wall or the flat face of a cabinet — nothing in it.',
    ],
  },
  {
    id: 'active-life',
    family: 'active',
    people: true,
    lines: (c) => [
      'SHOT: life after care, vertical, outdoors in daylight — the outcome, never the treatment.',
      `THE PERSON, in the lower two-thirds: ${c.cast.patient}, moving easily and unaware of the camera — walking a seafront path, `
        + `swimming steadily, stretching after a walk, or carrying something up a few steps — whichever best suits "${c.subject}".`,
      'Real clothes, real weather, mid-stride, caught rather than posed. They look capable, not triumphant; no arms raised, no leaping, no fists in the air.',
      'Natural light, open air, a soft-focus background of sea, palms, park or quiet street.',
      'The upper third opens into plain sky or distant water — uncluttered.',
    ],
  },
];

/** How many distinct shots a reroll can walk through. */
export const SHOT_COUNT = SHOTS.length;

/**
 * WHICH FAMILY EACH SLOT GETS.
 *
 * Slot 0 is always a consultation, so the safe pick is always on the table.
 * Each list below is the order for the slots AFTER that one, and running the
 * four slots of a typical post through it is what produces the ~50/25/15/10
 * weighting the research called for.
 */
const PILLAR_FAMILIES: Record<string, ShotFamily[]> = {
  // The consultation pillars: the room is the subject.
  diagnosis: ['still', 'consult', 'active'],
  protocols: ['still', 'consult', 'active'],
  'follow-up': ['still', 'consult', 'active'],
  prevention: ['still', 'active', 'consult'],
  // The biology pillars lean back on the room and the outcome; their science
  // slot comes from the post's own body, like every other pillar's.
  recovery: ['active', 'still', 'consult'],
  'recovery-cancun': ['active', 'consult', 'still'],
  // The living pillars: the outcome, not the procedure.
  movement: ['active', 'consult', 'still'],
  'active-living': ['active', 'consult', 'still'],
  cancun: ['active', 'consult', 'still'],
  // The everyday pillars: the objects the post names.
  nutrition: ['still', 'consult', 'active'],
  'practical-nutrition': ['still', 'consult', 'active'],
  supplementation: ['still', 'consult', 'active'],
  sleep: ['still', 'active', 'consult'],
  stress: ['still', 'active', 'consult'],
};

const DEFAULT_FAMILIES: ShotFamily[] = ['still', 'consult', 'active'];

/**
 * The post's own body has to earn a science picture. Without this gate a post
 * about a daily walk comes back as a microscope field, which is both wrong and
 * the kind of overclaim a clinic cannot publish.
 */
const SCIENCE_TERMS: RegExp[] = [
  /\bcellular\b|\bcells?\b/i,
  /\bstem[- ]cells?\b|\bmscs?\b/i,
  /\bexosomes?\b|\bvesicles?\b/i,
  /\btissues?\b/i,
  /\bmitochondri/i,
  /\bcollagen\b/i,
  /\binflammat/i,
  /\bimmune\b|\bimmunity\b/i,
  /\bregenerat/i,
  /\bsenescen/i,
  /\bcytokines?\b|\bgrowth factors?\b/i,
  /\bbiomarkers?\b/i,
  /\bprotein synthesis\b|\bmuscle repair\b|\bcell repair\b/i,
];

/** How many distinct biology ideas the post actually raises. */
export function scienceScore(text: unknown): number {
  const t = String(text ?? '');
  return SCIENCE_TERMS.reduce((n, re) => n + (re.test(t) ? 1 : 0), 0);
}

/**
 * Is this post ABOUT the biology, rather than merely mentioning it?
 *
 * One passing word is not enough. A post about a daily walk that happens to
 * say "muscle" came back as a microscope field, which illustrates nothing the
 * reader is there for — so the science slot now needs at least two distinct
 * biological ideas in the post's own text before it is offered at all.
 */
export function scienceAllowed(text: unknown): boolean {
  return scienceScore(text) >= 2;
}

/**
 * The family for one step of the rotation. Slot 0 is always a consultation;
 * later slots follow the pillar's order, and a science slot falls back to the
 * still life whenever the post never mentions biology.
 */
export const PLAN_LENGTH = 4;

export function familyAt(p: Pick<PlannerImage, 'pillarId' | 'science'>, sceneIndex: number): ShotFamily {
  // The plan repeats every four takes. Without the wrap, a draft that had been
  // rerolled a dozen times walked off the end of its own plan and never reached
  // the outcome shot or the science slot again.
  const step = Math.abs(Math.round(sceneIndex)) % PLAN_LENGTH;
  if (step === 0) return 'consult';
  const order = PILLAR_FAMILIES[p.pillarId] || DEFAULT_FAMILIES;
  // The third take is the science slot whenever the post's body has earned it —
  // in ANY pillar, because a sleep post about tissue repair and a nutrition post
  // about protein synthesis are both biology. The pillar table fills the rest.
  if (step === 2) return p.science ? 'science' : order[1 % order.length];
  // The fourth take comes back to the room. Two consultations in every four is
  // the ~50% the research asked for, and it means a reroll past the science or
  // the still life always has somewhere safe to land.
  if (step === 3) return 'consult';
  const want = order[(step - 1) % order.length];
  return want === 'science' && !p.science ? 'still' : want;
}

/**
 * The shot itself. Within a family the choice walks forward with each lap, so a
 * fourth or fifth take is a different picture rather than the one just
 * rejected.
 */
export function shotFor(seedBase: number, sceneIndex: number, family: ShotFamily): Shot {
  const pool = SHOTS.filter((sh) => sh.family === family);
  const step = Math.abs(Math.round(sceneIndex));
  if (!pool.length) return SHOTS[Math.abs(seedBase + step) % SHOTS.length];
  const lap = Math.floor(step / 3);
  return pool[Math.abs(seedBase + step + lap) % pool.length];
}

/** A stable number from the post's own title, so different posts get different shots. */
export function seedOf(text: string): number {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.charCodeAt(0)) % 100000;
  return h;
}

const CANCUN = new Set(['cancun', 'recovery-cancun']);

/** When no brief could be written: the pillar's own objects and gesture. */
const FALLBACK_OBJECTS: Record<string, { table: string[]; foreground: string; action: string }> = {
  diagnosis: { table: ['a stethoscope', 'a closed blank folder', 'a glass of water'], foreground: 'a ceramic bowl of lemons with leaves', action: 'listening closely, a pen resting on the blank folder' },
  protocols: { table: ['a notepad with blank pages', 'two cups of tea'], foreground: 'a small vase of eucalyptus', action: 'sketching on the blank notepad and turning it toward the patient' },
  nutrition: { table: ['a book open to full-page photographs of avocado, greens, grains and salmon'], foreground: 'a ceramic bowl of oranges with leaves', action: 'pointing at the food photographs in the book' },
  supplementation: { table: ['a small ceramic dish with a few plain unlabeled capsules', 'a glass of water'], foreground: 'a bowl of fresh fruit', action: 'gesturing gently toward the dish of capsules' },
  movement: { table: ['a light resistance band', 'a water bottle', 'a folded towel'], foreground: 'a rolled yoga mat', action: 'demonstrating a slow shoulder stretch' },
  sleep: { table: ['a cup of chamomile tea', 'a small bunch of lavender'], foreground: 'a folded linen throw', action: 'speaking gently, hands around a warm cup' },
  prevention: { table: ['a blood-pressure cuff', 'a stethoscope', 'a notebook with blank pages'], foreground: 'a bowl of green apples', action: 'resting a hand beside the blood-pressure cuff while explaining' },
  cancun: { table: ['a bowl of tropical fruit', 'two glasses of water with lime'], foreground: 'a small potted palm', action: 'gesturing toward the sea beyond the window' },
  'follow-up': { table: ['a tablet with a blank screen', 'a notebook with blank pages'], foreground: 'a small plant', action: 'reviewing the blank tablet together' },
  recovery: { table: ['a glass of water', 'a folded light linen blanket'], foreground: 'a bowl of cucumber and mint', action: 'offering a glass of water' },
  'active-living': { table: ['a water bottle', 'a pair of walking shoes', 'a folded towel'], foreground: 'a rolled yoga mat', action: 'describing a morning walk with an open hand' },
  'practical-nutrition': { table: ['Greek yogurt with berries, boiled eggs and whole-grain toast'], foreground: 'a ceramic bowl of oranges with leaves', action: 'pointing at the breakfast plate' },
  stress: { table: ['a cup of herbal tea', 'a small dish of dried lavender'], foreground: 'a folded linen throw', action: 'showing a slow breath, one hand on the chest' },
  'recovery-cancun': { table: ['a bowl of tropical fruit', 'a glass of water with lime', 'a straw sun hat'], foreground: 'a small potted palm', action: 'pointing out toward the sea' },
};

export function plannerPromptLines(p: PlannerImage, sceneIndex: number, direction?: string | null, family?: ShotFamily | null): string[] {
  const dir = String(direction || '').trim();
  const d = p.dynamic;
  const pid = p.pillarId === 'article' ? (Object.keys(PILLAR_SCENES).find((k) => PILLAR_SCENES[k].scenes === p.scenes) || 'diagnosis') : p.pillarId;
  const fb = FALLBACK_OBJECTS[pid] || FALLBACK_OBJECTS.diagnosis;
  const objects = (d ? (d.props.length > 1 ? d.props.slice(1) : d.props) : fb.table).join(', ');
  const foreground = d && d.props.length > 1 ? d.props[0] : fb.foreground;
  const action = d ? d.scene.replace(/^(the )?(physician|clinician) (is )?/i, '').replace(/\.$/, '') : fb.action;
  const windowView = CANCUN.has(pid) ? 'a turquoise Caribbean sea, white sand and palm trees' : 'green trees and soft hills';
  // The shot rotates with the post itself, not only with rerolls — one fixed
  // composition made every week's picture look like the last one.
  const seed = seedOf(p.title + p.pillarName) + Math.abs(Math.round(sceneIndex));
  const shot = shotFor(seedOf(p.title + p.pillarName), sceneIndex, family || familyAt(p, sceneIndex));
  const cast: Cast = {
    clinician: CLINICIANS[seed % CLINICIANS.length],
    patient: PATIENTS[(seed + 2) % PATIENTS.length],
  };
  const ctx: ShotContext = { objects, foreground, action, windowView, cast, subject: p.subject };
  const objectLed = shot.family === 'consult' || shot.family === 'still';
  return [
    objectLed
      ? `Subject: a photograph for an educational post titled "${p.title}" (the weekly "${p.pillarName}" theme, on "${p.subject}"). It must clearly show ${d ? d.mustShow : p.mustShow}.`
      : `Subject: a photograph for an educational post titled "${p.title}" (the weekly "${p.pillarName}" theme, on "${p.subject}"). The frame below is the subject — do not add the objects the post names to it.`,
    objectLed && d?.quote ? `It illustrates this line from the post: "${d.quote}" — everything in frame comes from that.` : '',
    dir ? `Direction from the team (follow this closely, within the frame below): ${dir}` : '',
    ...shot.lines(ctx),
    titleBand(shot.people),
    WORLD,
    CRAFT,
  ].filter(Boolean);
}

/** The extra check the vision reviewer runs on a planner image. */
export function onTopicCheck(p: PlannerImage): string {
  const tail =
    'Also a DEFECT: anything in the top third, where a title will sit — a person\'s head or face, art, shelves, lamps or busy objects. ' +
    'Also a DEFECT: an anatomical model or medical teaching prop — a plastic brain, heart, spine, skeleton, skull, torso or mannequin — ' +
    'an anatomical chart, poster, diagram or illustration, or a pill, supplement, vitamin or medicine bottle, a blister pack or loose ' +
    'tablets. Set "onTopic": false when any of these fails.';
  if (p.shotFamily === 'science') {
    return 'ON-TOPIC (this one is a DEFECT, not an opinion): the image must be a believable REAL laboratory photograph — either a genuine ' +
      'microscope field of cells in culture, or a researcher working at a lab bench. A DEFECT: rendered or illustrated cells, glowing or ' +
      'neon spheres, bloom, lens flare, floating particles, a DNA helix, or any 3D-looking graphic in place of a photograph. ' +
      'Also a DEFECT: needles, syringes, ampoules, blood, or anything that reads as a treatment being given. ' + tail;
  }
  if (p.shotFamily === 'active') {
    return 'ON-TOPIC (this one is a DEFECT, not an opinion): the image must show a real person outdoors in daylight, moving easily and ' +
      'living normally — not a clinic, not a treatment, not a medical setting. A DEFECT: any clinical room, equipment, uniform or ' +
      'procedure in frame, and any triumphant pose — raised arms, leaping, fists in the air. ' + tail;
  }
  return `ON-TOPIC (this one is a DEFECT, not an opinion): the image must clearly show ${p.dynamic ? p.dynamic.mustShow : p.mustShow}. ` +
    'A generic reception desk, front desk or waiting room does NOT count. ' + tail;
}
