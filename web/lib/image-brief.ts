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
  /** One or two sentences: who, doing what, where — in the house style. */
  scene: string;
  /** 2-4 concrete, photographable objects that make this post's subject obvious. */
  props: string[];
  /** The single clearest visual cue — what the checker insists on seeing. */
  mustShow: string;
};

/** The post text the brief is written from: the article when there is one, else the caption; no hashtags, REF or AVISO. */
export function briefSource(pack: unknown, max = 1600): string {
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
    'You choose the props for ONE photograph in a fixed series. The composition never changes: an over-the-shoulder consultation —',
    'the patient seen from behind in the right foreground; across a light oak table, a smiling physician in a white blazer facing the camera;',
    'a sunlit window on the left; a bowl or small object in the lower-left foreground.',
    'Your job is only: what the physician is doing with her hands, and which objects are on the table and in the foreground,',
    'so that a reader recognises THIS post\'s specific subject at a glance.',
    'Pick 2-4 concrete, everyday, photographable objects that belong to the subject (for protein: boiled eggs, grilled salmon, lentils;',
    'for a nutrition label: a plain food package held with its blank side to the camera; for sleep habits: a phone placed face-down, a cup of chamomile tea).',
    'The FIRST prop is the lower-left foreground object (a bowl, plate or small item); the others go on the table in front of the physician.',
    'Never: any text, writing, labels, logos or brands; screens showing content; needles, syringes, IV lines, blood; exposed bodies;',
    'before/after; medicine or supplement bottles with markings; named devices; anything alarming.',
    'Answer with STRICT JSON only:',
    '{"scene": "what the physician is doing, one short clause, e.g. pointing with a pen at the plate of salmon", "props": ["foreground object", "table object", "table object"], "mustShow": "the single clearest visual cue, a short phrase"}',
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

const BANNED = /\b(text|label(?:led|ed)?s?|logo|brand|needle|syringe|iv\b|drip|blood|scalpel|injection|before\/after|screen showing|monitor showing|pill bottle)\b/i;

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
  const props = (Array.isArray(o.props) ? o.props : [])
    .map((p) => clean(p, 60))
    .filter((p) => p && !BANNED.test(p))
    .slice(0, 4);
  if (scene.length < 20 || !mustShow || props.length < 1) return null;
  if (BANNED.test(scene) || BANNED.test(mustShow)) return null;
  return { scene, props, mustShow };
}
