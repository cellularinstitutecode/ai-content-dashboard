// web/lib/image-reference.ts
// "AI image styled after a library photo."
//
// The Images API path this app uses (lib/images.ts, /v1/images/generations)
// takes a prompt and no picture, so a library photo cannot be handed to the
// model as a reference. Instead the vision model that already checks every
// generated image DESCRIBES the photo — light, palette, setting, camera, mood —
// and that description becomes the prompt's direction. The post's own subject,
// the brand block and the no-text rule are added on top by buildImagePrompt,
// and the result goes through the same verification as any other take.
//
// Pure: no imports, so the test runner reads this file directly.

/** How long a description may get before it starts steering the subject too. */
export const MAX_DESCRIPTION_CHARS = 500;

export const REFERENCE_DESCRIBE_SYSTEM =
  'You describe a reference photograph for an image generator, so it can make a DIFFERENT scene in the same style. ' +
  'Write one paragraph of at most 80 words covering: the light (source, warmth, softness), the colour palette, the setting and materials, ' +
  'the camera (distance, angle, depth of field), and the mood. Describe style only: do NOT name people, do NOT transcribe any text, logos or signage, ' +
  'and do NOT dictate the subject. Return STRICT JSON only: {"style": string}.';

/** The text the vision model returned, as a clean style description (or null when it gave nothing usable). */
export function parseReferenceDescription(raw: string | null | undefined): string | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  let text = s;
  try {
    const parsed = JSON.parse(s) as { style?: unknown } | null;
    if (parsed && typeof parsed === 'object' && typeof parsed.style === 'string') text = parsed.style;
  } catch { /* plain prose is fine too */ }
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > MAX_DESCRIPTION_CHARS ? clean.slice(0, MAX_DESCRIPTION_CHARS).replace(/\s+\S*$/, '') : clean;
}

/**
 * The direction handed to buildImagePrompt: the reference's style, and the
 * team's own note when they wrote one. Worded so the model borrows the look
 * without copying the picture.
 */
export function styleDirection(description: string, note?: string | null): string {
  const n = String(note || '').trim();
  return 'Match the style of this reference photograph (its light, palette, setting, camera and mood), but compose a new scene for the subject: ' +
    description.trim() + (n ? ' Also: ' + n : '');
}
