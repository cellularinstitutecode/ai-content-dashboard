// web/lib/content-strategy.snapshot.test.ts
//
// The strategy document, word for word, pinned against lib/content-strategy.ts.
//
// Every literal below was taken from the PDF itself ("Cellular Institute —
// Weekly Social Content Strategy"), not copied from the module under test, so
// a change to either side is a disagreement this file reports. Each string
// here ends up in a published medical advertisement's brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY_THEMES, FREQUENCY_PILLARS, WEEK, pillarById } from './content-strategy.ts';

/** Pages 4-10: day, Post number, Post heading, the day's subtitle, and its bullets. */
const DOCUMENT_POSTS: { day: number; post: number; heading: string; theme: string; angles: string[] }[] = [
  { day: 1, post: 1, heading: "Diagnosis and assessment", theme: "Understand before treating", angles: [
    "Why effective care begins with a thorough evaluation",
    "Why similar symptoms may have different causes",
    "What information a physician needs before recommending a protocol",
    "The importance of reviewing laboratory results, imaging, and medical history",
    "Why comparing treatments without comparing evaluations can be misleading"
  ] },
  { day: 1, post: 2, heading: "Personalization", theme: "Understand before treating", angles: [
    "Why one protocol does not work the same way for every person",
    "How age, diagnosis, medications, and lifestyle influence planning",
    "The difference between a standard package and a personalized medical plan",
    "How therapies, number of sessions, and routes of administration are selected",
    "Why the right protocol depends on the patient, not only the condition"
  ] },
  { day: 2, post: 1, heading: "Nutrition", theme: "Support the body from within", angles: [
    "The role of protein in recovery",
    "Nutrition and inflammation",
    "Hydration and cellular health",
    "Nutrients that help support muscle mass",
    "How to prepare the body nutritionally before treatment",
    "Nutrition during the recovery process"
  ] },
  { day: 2, post: 2, heading: "Supplementation", theme: "Support the body from within", angles: [
    "Why supplementation should also be personalized",
    "Why more supplements do not necessarily mean better results",
    "Possible interactions between supplements and medications",
    "The importance of identifying actual deficiencies",
    "What to review before beginning a supplement routine",
    "Supplements as support, not a substitute for healthy habits"
  ] },
  { day: 3, post: 1, heading: "Movement", theme: "Movement and restoration", angles: [
    "Why staying active matters at every age",
    "Muscle strength and longevity",
    "Movement as a way to support joint health",
    "The difference between physical activity and structured training",
    "How to begin moving when pain or limited mobility is present",
    "Why exercise should be adapted to the individual"
  ] },
  { day: 3, post: 2, heading: "Sleep", theme: "Movement and restoration", angles: [
    "What happens in the body while we sleep",
    "The relationship between sleep and recovery",
    "How poor sleep can affect inflammation",
    "The connection between sleep, appetite, and metabolism",
    "Simple habits that may improve sleep quality",
    "Why sleeping longer does not always mean resting better"
  ] },
  { day: 4, post: 1, heading: "Prevention", theme: "Prevention and destination", angles: [
    "Why you should not wait until you feel unwell to assess your health",
    "The value of periodic health evaluations",
    "Biomarkers that help build a broader picture of health",
    "Identifying changes before they affect quality of life",
    "Establishing a baseline to help measure progress",
    "The difference between addressing symptoms and exploring possible causes"
  ] },
  { day: 4, post: 2, heading: "Cancun and health tourism", theme: "Prevention and destination", angles: [
    "Why Cancun is well suited for combining medical care and rest",
    "Air connectivity from the United States and Canada",
    "Recovering in a calm, warm environment",
    "Hotel, dining, and low-impact activity options",
    "What patients can do during open days in their protocol",
    "How to organize a medical trip that feels supported and comfortable"
  ] },
  { day: 5, post: 1, heading: "Personalization and follow-up", theme: "Guidance beyond the appointment", angles: [
    "Why a protocol may be adjusted as the patient progresses",
    "The importance of monitoring changes over time",
    "What happens after a patient returns home",
    "How follow-ups at 1, 3, 6, and 12 months support continuity of care",
    "Why care does not end when the patient leaves the clinic",
    "How progress can be evaluated while maintaining realistic expectations"
  ] },
  { day: 5, post: 2, heading: "Recovery", theme: "Guidance beyond the appointment", angles: [
    "Recovery as part of the overall care plan",
    "Why the body needs time to respond",
    "Hydration, rest, and movement after treatment",
    "Technologies that may support the recovery experience",
    "What it means to build a personalized recovery plan",
    "Why patients should avoid overloading the body immediately afterward"
  ] },
  { day: 6, post: 1, heading: "Active living", theme: "Healthy habits in real life", angles: [
    "Simple activities that help people stay active",
    "Walking, swimming, and mobility exercises",
    "Maintaining muscle mass after 40, 50, or 60",
    "Ways to incorporate movement while traveling",
    "Options when intense exercise is not appropriate",
    "Why consistency often matters more than intensity"
  ] },
  { day: 6, post: 2, heading: "Practical nutrition", theme: "Healthy habits in real life", angles: [
    "Protein-rich breakfast ideas",
    "How to make balanced choices while traveling",
    "Snacks that support steady energy",
    "How to read a nutrition label",
    "Common mistakes when trying to eat healthier",
    "What to consider when ordering at a restaurant during recovery"
  ] },
  { day: 0, post: 1, heading: "Sleep, stress, and rest", theme: "Well-being and the Cancun experience", angles: [
    "How stress can influence recovery",
    "Why the body needs intentional rest",
    "Simple rituals to close the week",
    "Breathing, relaxation, and the nervous system",
    "Mental and physical recovery",
    "Why rest is a meaningful part of well-being"
  ] },
  { day: 0, post: 2, heading: "Recovery in Cancun", theme: "Well-being and the Cancun experience", angles: [
    "What a recovery day in Cancun may look like",
    "Low-intensity activities for patients",
    "Nature, the beach, and a calmer pace",
    "How treatment can be combined with time to rest",
    "What a companion can do during the trip",
    "The patient experience before, during, and after the clinic visit"
  ] },
];

/** Page 2, the day map: [weekday, Post 1, Post 2]. 0 = Sunday. */
const DOCUMENT_DAY_MAP: [number, string, string][] = [
  [1, "Diagnosis and comprehensive assessment", "Personalized protocols"],
  [2, "Nutrition", "Supplementation"],
  [3, "Movement and exercise", "Sleep and rest"],
  [4, "Prevention and early detection", "Cancun as a health tourism destination"],
  [5, "Personalization and follow-up", "Recovery and restoration"],
  [6, "Active living and longevity", "Practical nutrition"],
  [0, "Sleep, stress, and well-being", "Recovery, rest, and the Cancun experience"],
];

/** Page 3, "Content pillar frequency": [pillar, days, frequency]. */
const DOCUMENT_FREQUENCY: [string, string, string][] = [
  ['Diagnosis, assessment, and prevention', 'Monday and Thursday', '2x weekly'],
  ['Personalized protocols', 'Monday and Friday', '2x weekly'],
  ['Nutrition', 'Tuesday and Saturday', '2x weekly'],
  ['Supplementation', 'Tuesday', '1x weekly'],
  ['Movement and exercise', 'Wednesday and Saturday', '2x weekly'],
  ['Sleep and stress management', 'Wednesday and Sunday', '2x weekly'],
  ['Recovery and restoration', 'Friday and Sunday', '2x weekly'],
  ['Cancun and health tourism', 'Thursday and Sunday', '2x weekly'],
  ['Patient follow-up', 'Primarily Friday; also integrated into assessment content', '1-2x weekly'],
];

test('all 82 angles, in order, word for word', () => {
  assert.equal(DOCUMENT_POSTS.reduce((n, p) => n + p.angles.length, 0), 82);
  for (const doc of DOCUMENT_POSTS) {
    const slot = WEEK.find((s) => s.day === doc.day && s.post === doc.post);
    assert.ok(slot, 'no slot for day ' + doc.day + ' post ' + doc.post);
    const pillar = pillarById(slot!.pillarId)!;
    assert.equal(pillar.name, doc.heading, 'the Post heading');
    assert.deepEqual(pillar.angles, doc.angles, doc.heading);
  }
});

test('the day subtitles', () => {
  for (const doc of DOCUMENT_POSTS) assert.equal(DAY_THEMES[doc.day as 0 | 1 | 2 | 3 | 4 | 5 | 6], doc.theme);
});

test('the page-2 day map, cell for cell', () => {
  for (const [day, p1, p2] of DOCUMENT_DAY_MAP) {
    assert.equal(WEEK.find((s) => s.day === day && s.post === 1)!.mapName, p1);
    assert.equal(WEEK.find((s) => s.day === day && s.post === 2)!.mapName, p2);
  }
});

test('the frequency table, row for row', () => {
  assert.deepEqual(FREQUENCY_PILLARS.map((f) => [f.name, f.days, f.frequency]), DOCUMENT_FREQUENCY);
});
