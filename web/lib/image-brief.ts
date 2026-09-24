// web/lib/image-brief.ts
// Dynamic art direction: the picture is briefed from what THIS post actually
// says, not only from its pillar.
//
// WHY. A pillar's three fixed scenes can only say "nutrition" — oranges and a
// food book. A post about hydration, or about reading a nutrition label, or
// about protein at breakfast, deserves a picture a reader recognises as THAT
// subject at a glance, the way the team's reference ("The Importance of
// Nutrition") is recognisably about food. So before each planner image is
// generated, a small text model reads the post and writes the scene: the
// action, and 2-4 concrete objects that make this specific subject obvious.
// The master shot (lib/planner-image.ts masterShot) is fixed around
// it, and the vision checker then verifies the picture shows the cue it named.
//
// This file is pure — the prompt, the source text and the parser — so the rules
// are unit-tested; lib/images.ts makes the call and falls back to the pillar's
// fixed scenes whenever the brief cannot be had.

export type SceneBrief = {
  /** The line from the post the picture illustrates — quoted back, so the objects are never arbitrary. */
  quote?: string;
  /** One or two sentences: who, doing what, where — in the house style. */
  scene: string;
  /** 2-4 concrete, photographable objects that make this post's subject obvious. */
  props: string[];
  /** The single clearest visual cue — what the checker insists on seeing. */
  mustShow: string;
};

/** The post text the brief is written from: the article when there is one, else the caption; no hashtags, REF or AVISO. */
export function briefSource(pack: unknown, max = 2600): string {
  const p = (pack && typeof pack === 'object' ? pack : {}) as Record<string, unknown>;
  const raw = [p.blog, p.instagram, p.linkedin, p.facebook].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  if (!raw) return '';
  return raw
    .split('\n')
    .filter((l) => !/^\s*REF:/i.test(l) && !/AVISO DE PUBLICIDAD/i.test(l))
    .join(' ')
    .replace(/#[\w-]+/g, '')
    .replace(/[*_`>#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Compositions to steer toward, so "New image" gives a genuinely different picture. */
const COMPOSITIONS = [
  'the physician points at the key object with a pen',
  'the physician holds the key object up gently as she explains',
  'the physician rests one hand beside the key object, the other open in a warm gesture',
  'the physician slides the key object toward the patient',
];

export function briefSystemPrompt(): string {
  return [
    'You choose what is IN a photograph that illustrates a specific post. The framing is decided elsewhere (it may be a consultation,',
    'a still life with no people, a close-up of hands, or a candid moment at home), so describe only the action and the objects.',
    'READ THE POST FIRST. Every object you choose must come from what the post actually says — something it names, describes or plainly implies.',
    'Quote the line you are illustrating back to me. If the post never mentions fruit, there is no fruit in the picture.',
    'No decorative filler: no bowls of fruit, flowers or props to fill a corner unless the post is about them.',
    'Pick 2-4 concrete, everyday, photographable objects (for protein: boiled eggs, grilled salmon, lentils; for a nutrition label:',
    'a plain food package held with its blank side to the camera; for sleep habits: a phone placed face-down, a cup of chamomile tea).',
    'The FIRST prop is the secondary object just behind or beside; the others are the ones in sharp focus.',
    'Never: any text, writing, labels, logos or brands; screens showing content; needles, syringes, vials, ampoules, IV lines, blood;',
    'pill or supplement bottles; exposed bodies; before/after; named devices or medicines; anything alarming or clinical-looking.',
    'Never on a person: no blood-pressure cuff on an arm, ECG leads, pulse oximeter, IV line, cannula, drip, glucose monitor, oxygen mask,',
    'bandage or dressing, and nothing held as though it were being administered. A device may rest on the table, unused. This is a',
    'conversation, never a procedure.',
    'Never a teaching prop: no anatomical model, plastic brain, heart, spine, skeleton, skull, torso or mannequin, and no anatomical chart,',
    'poster, diagram, illustration or infographic. Choose ordinary real objects a photographer could put on a table.',
    'Answer with STRICT JSON only:',
    '{"quote": "the sentence from the post this picture illustrates", "scene": "what the hands are doing, one short clause",',
    '"props": ["secondary object", "main object", "main object"], "mustShow": "the single clearest visual cue, a short phrase"}',
  ].join(' ');
}

export function briefUserPrompt(opts: { title: string; angle: string; pillarName: string; text: string; variant: number }): string {
  const comp = COMPOSITIONS[Math.abs(Math.round(opts.variant)) % COMPOSITIONS.length];
  return [
    `Post title: ${opts.title}`,
    `Weekly theme: ${opts.pillarName}`,
    `Angle: ${opts.angle}`,
    `Hands: ${comp}.`,
    opts.text ? `The post says: ${opts.text}` : '',
  ].filter(Boolean).join('\n');
}

const BANNED =
  /\b(text|label(?:led|ed)?s?|logo|brand|needle|syringe|vial|ampoule|iv\b|drip|blood|scalpel|injection|before\/after|screen showing|monitor showing|(pill|supplement|medicine) bottle|anatomical|anatomy|skeleton|skull|mannequin|torso|teaching (?:model|prop|aid)|(?:plastic|model|replica) (?:brain|heart|spine|lung|kidney|organ|bone)|(?:brain|heart|spine|organ|body) model|model of (?:a|an|the)|diagram|infographic|(?:anatomical|wall|medical|eye) chart|poster|illustration)\b/i;

/** Parse and sanitise the model's answer. Null when it is unusable — the caller then uses the pillar's fixed scenes. */
export function parseSceneBrief(raw: unknown): SceneBrief | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { obj = JSON.parse(m[0]); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const clean = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const scene = clean(o.scene, 400);
  const mustShow = clean(o.mustShow, 160);
  const quote = clean(o.quote, 240);
  const props = (Array.isArray(o.props) ? o.props : [])
    .map((p) => clean(p, 60))
    .filter((p) => p && !BANNED.test(p))
    .slice(0, 4);
  if (scene.length < 20 || !mustShow || props.length < 1) return null;
  if (BANNED.test(scene) || BANNED.test(mustShow)) return null;
  return { scene, props, mustShow, ...(quote ? { quote } : {}) };
}
