// web/lib/picture-brief.ts
// A PICTURE AS THE IDEA. Somebody drops a photograph on "Your idea" and the
// post is written around what is in it: the vision model says what the
// picture shows and what it suggests, and that becomes the topic the writer
// researches keywords for, reads the competition on and writes to — the same
// pipeline a typed idea goes through. The picture itself becomes the post's
// picture (app/page.tsx, the drop on the idea box; app/api/generate/see).
//
// Pure: the prompt, the parsing and the topic line are what decide what gets
// written, so they are tested rather than trusted.

export type PictureBrief = {
  /** What the picture shows, one or two plain sentences. */
  description: string;
  /** The post idea it suggests, one line, as somebody would type it in "Your idea". */
  idea: string;
  /** Anything the copy should not say about the picture (a treatment in progress, a patient). */
  caution: string;
};

export function pictureBriefSystemPrompt(): string {
  return [
    'You look at one picture for the content team of a regenerative-medicine clinic in Cancún (stem cells, exosomes, IV therapies, recovery, nutrition, sleep, movement).',
    'Answer in JSON with exactly these keys:',
    '"description": what the picture shows, one or two plain sentences, as a person would say it — the setting, who or what is in it, the mood. No guessing at names or diagnoses.',
    '"idea": the social post it suggests for this clinic, one line, written the way somebody would type a post idea (e.g. "How morning light and a short walk help the body recover after a treatment"). Make it about what is actually in the picture. Never a promotion, never a claim of a cure.',
    '"caution": one line on anything the post must not say or show because of the picture — a treatment being given, a device on a person, a recognisable patient, visible text — or an empty string.',
  ].join('\n');
}

/** The model's JSON, read defensively; null when nothing usable came back. */
export function parsePictureBrief(raw: unknown): PictureBrief | null {
  let o: Record<string, unknown> | null = null;
  if (raw && typeof raw === 'object') o = raw as Record<string, unknown>;
  else if (typeof raw === 'string') {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { o = JSON.parse(text); } catch { o = null; }
  }
  if (!o) return null;
  const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const description = clean(o.description, 600);
  const idea = clean(o.idea, 240);
  if (!description && !idea) return null;
  return { description, idea: idea || description, caution: clean(o.caution, 300) };
}

/**
 * The topic the writer gets: what the person typed (if anything), then the
 * picture, so the keywords, the competition and the copy are all about the
 * thing in the photograph — and the copy never describes what is not there.
 */
export function topicFromPicture(typed: string, brief: PictureBrief): string {
  const idea = typed.trim() || brief.idea;
  const lines = [
    idea,
    'The post is built around a photograph the team supplied, which is its picture. The photograph shows: ' + brief.description,
    'Write so the copy matches what is in the photograph; do not describe anything that is not in it.',
  ];
  if (brief.caution) lines.push('About the photograph: ' + brief.caution);
  return lines.join('\n').slice(0, 2000);
}
