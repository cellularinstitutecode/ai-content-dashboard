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
// The house style (bright consultation, blazer, clear top 40%) is fixed around
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
  'seated across a light oak table, both visible, seen from slightly above',
  'a closer view over the table, the objects prominent in the foreground, the people softly behind them',
  'standing together near a large window, one of them holding or showing the key object',
  'side by side on a linen sofa or two armchairs, the objects on a low table in front',
];

export function briefSystemPrompt(): string {
  return [
    'You art-direct ONE editorial photograph for a clinic\'s educational social post. The house style is fixed:',
    'a bright, airy daylight consultation between a physician (tailored white or cream blazer, never scrubs) and a patient,',
    'warm beige walls, light oak, plants, a soft window view; the upper 40% of the frame is empty wall; people sit low in the frame.',
    'Your job: choose what happens and what is in view so that a reader recognises THIS post\'s specific subject at a glance.',
    'Rules: pick 2-4 concrete, everyday, photographable objects that belong to the subject (for protein: eggs, salmon, lentils;',
    'for a nutrition label: a plain food package held so its blank side faces the camera; for sleep habits: a phone placed face-down, a dimmed lamp).',
    'Never: any text, writing, labels, logos or brands; screens showing content; needles, syringes, IV lines, blood; exposed bodies;',
    'before/after; specific medicines or supplement bottles with markings; devices named as products; anything alarming.',
    'Keep it calm, warm and credible. Answer with STRICT JSON only:',
    '{"scene": "one or two sentences in plain English", "props": ["object", "object"], "mustShow": "the single clearest visual cue, a short phrase"}',
  ].join(' ');
}

export function briefUserPrompt(opts: { title: string; angle: string; pillarName: string; text: string; variant: number }): string {
  const comp = COMPOSITIONS[Math.abs(Math.round(opts.variant)) % COMPOSITIONS.length];
  return [
    `Post title: ${opts.title}`,
    `Weekly theme: ${opts.pillarName}`,
    `Angle: ${opts.angle}`,
    `Composition to use: ${comp}.`,
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
