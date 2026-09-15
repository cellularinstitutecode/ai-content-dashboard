// web/lib/anthropic-models.ts
// Which Claude models accept structured output (`output_config.format`).
//
// The writer asks for one JSON object and parses it. A model that supports
// structured output is made to return exactly that shape — no raw line breaks
// inside strings, no prose around the object, no missing key — which removes
// the "incomplete or garbled" failure at its source. A model that does not
// support it answers 400 to the parameter, so the request must only carry it
// where it is understood. Pure, no imports: run directly by the test runner.

/**
 * Model ids (prefixes) documented as supporting structured output. A model
 * outside this list gets the plain request, exactly as before.
 */
const JSON_OUTPUT_MODELS = [
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-haiku-4-5',
  'claude-fable-5',
  'claude-mythos-5',
];

/**
 * Should the writer ask this model for a schema-checked JSON answer?
 * `ANTHROPIC_JSON_OUTPUT=off` switches it off without a deploy.
 */
export function supportsJsonOutput(model: string, env: Record<string, string | undefined> = process.env): boolean {
  const flag = String(env.ANTHROPIC_JSON_OUTPUT || '').trim().toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === '0' || flag === 'no') return false;
  const id = String(model || '').trim().toLowerCase();
  if (!id) return false;
  return JSON_OUTPUT_MODELS.some((prefix) => id === prefix || id.startsWith(prefix + '-') || id.startsWith(prefix + '@'));
}

/** The writer's answer, as a schema: four strings, nothing else. */
export const PACK_SCHEMA = {
  type: 'object',
  properties: {
    instagram: { type: 'string' },
    facebook: { type: 'string' },
    linkedin: { type: 'string' },
    blog: { type: 'string' },
  },
  required: ['instagram', 'facebook', 'linkedin', 'blog'],
  additionalProperties: false,
} as const;
