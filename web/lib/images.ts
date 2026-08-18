// web/lib/images.ts
// AI image generation for content packs.
//
// Mirrors the Make.com blog automation (which generates featured/inline
// images with OpenAI's image model for WordPress posts): every dashboard
// content pack can get ONE on-brand hero image, generated with OpenAI
// Images (gpt-image-1, DALL·E 3 fallback), stored in a public Supabase
// Storage bucket, and stamped on the draft's pack as `_image` — the same
// provenance pattern as `_semrush` / `_autopilot`, so no schema migration
// is needed and the image travels with the draft everywhere it renders.
//
// Design constraints honored:
// - Fail-soft: image generation must NEVER block or fail text generation,
//   drafting, scoring or approval. Callers wrap in try/catch; a missing
//   key or a provider error just means a text-only pack, like before.
// - Idempotent: ensureDraftImage() skips drafts that already carry an
//   image, so retries and concurrent callers don't double-spend.
// - No new secrets: reuses OPENAI_API_KEY + the Supabase service role.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase';
import type { BrandContext } from '@/lib/ai';

export type PackImage = {
  url: string;
  prompt: string;
  alt: string;
  model: string;
  createdAt: string;
  // Which composition variant produced this image. Regeneration advances the
  // variant, so "New image" always yields a visibly different take — never a
  // re-roll of the same prompt.
  variant: number;
};

const BUCKET = process.env.IMAGE_BUCKET || 'content-images';
const PRIMARY_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const FALLBACK_MODEL = 'dall-e-3';

// Kill switch: set IMAGE_GEN=off to disable image generation everywhere
// without redeploying callers. Default is ON whenever OPENAI_API_KEY exists.
export function imagesEnabled(): boolean {
  if (String(process.env.IMAGE_GEN || '').toLowerCase() === 'off') return false;
  return Boolean(process.env.OPENAI_API_KEY);
}

// ---------------------------------------------------------------------------
// Prompt builder: medically conservative, premium clinic aesthetic.
// ---------------------------------------------------------------------------

function excerptOf(pack: Record<string, unknown> | null | undefined): string {
  if (!pack || typeof pack !== 'object') return '';
  const src = [pack.blog, pack.instagram, pack.linkedin, pack.facebook]
    .find((v) => typeof v === 'string' && (v as string).trim());
  if (!src) return '';
  return String(src)
    .replace(/#[\w-]+/g, '') // strip hashtags
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

// Composition variants: regeneration cycles through these so every "New
// image" is a genuinely different visual proposition, not a near-duplicate.
export const STYLE_VARIANTS: string[] = [
  'Composition: wide editorial hero shot — premium modern clinic interior or a calm physician-patient consultation moment.',
  'Composition: macro scientific beauty — laboratory glassware, pipettes, cell-culture plates, abstract luminous cellular forms.',
  'Composition: warm lifestyle — healthy, active adults (40-70) outdoors in bright coastal light, vitality and movement.',
  'Composition: minimal premium still-life — clean medical/wellness objects on a soft neutral background, generous negative space.',
];

export function buildImagePrompt(opts: {
  topic: string;
  pack?: Record<string, unknown> | null;
  brand?: BrandContext | null;
  variant?: number;
}): string {
  const brandName = opts.brand?.name || 'a premium regenerative medicine and longevity clinic';
  const excerpt = excerptOf(opts.pack);
  const variant = STYLE_VARIANTS[Math.abs(Math.round(opts.variant ?? 0)) % STYLE_VARIANTS.length];
  return [
    `Editorial hero photograph for ${brandName}.`,
    `Subject: ${opts.topic}.`,
    excerpt ? `Context from the article: ${excerpt}` : '',
    variant,
    'Style: bright, clean, modern medical-wellness aesthetic; soft natural light;',
    'calm, hopeful, trustworthy mood; photorealistic; shallow depth of field.',
    'Strict rules: NO text, NO words, NO letters, NO logos, NO watermarks,',
    'no needles piercing skin, no blood, no graphic medical procedures, nothing that implies a medical claim.',
  ].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// OpenAI Images call (gpt-image-1 primary, DALL·E 3 fallback on API errors).
// ---------------------------------------------------------------------------

// One Images-API call. Returns whichever the API gives us — inline base64 or
// a short-lived asset URL — so callers survive response-shape differences
// between models and API revisions.
async function callImagesApi(
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<{ b64?: string; url?: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`openai images ${res.status}: ${txt.slice(0, 300)}`);
      (err as Error & { apiStatus?: number }).apiStatus = res.status;
      throw err;
    }
    const data = await res.json();
    const first = data?.data?.[0] || {};
    if (!first.b64_json && !first.url) throw new Error('openai images: empty response');
    return { b64: first.b64_json ? String(first.b64_json) : undefined, url: first.url ? String(first.url) : undefined };
  } finally {
    clearTimeout(timer);
  }
}

// Download an API-returned image asset (OpenAI serves short-lived URLs for
// some models) so we can persist it in our own storage before it expires.
async function fetchImageBytes(url: string, timeoutMs: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`image asset fetch ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// Byte-sniff the real format (the API's default output differs per model).
function sniffImage(bytes: Buffer): { contentType: string; ext: string } {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return { contentType: 'image/png', ext: 'png' };
  if (bytes.length > 12 && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { contentType: 'image/webp', ext: 'webp' };
  return { contentType: 'image/jpeg', ext: 'jpg' };
}

type GeneratedImage = { bytes: Buffer; contentType: string; ext: string; model: string };

// The OpenAI Images API drifts: parameters like response_format / output_*
// have been added and removed across revisions, and gpt-image access varies
// by org. So we try a ladder of requests — richest first, most-compatible
// last — falling through ONLY on 4xx API rejections (never on timeouts,
// where a second slow call would bust the serverless budget). Every rung's
// error is kept so a total failure surfaces the full story, not just the
// last fallback's complaint.
async function generateImageBytes(prompt: string): Promise<GeneratedImage> {
  const attempts: { model: string; body: Record<string, unknown> }[] = [
    {
      model: PRIMARY_MODEL,
      body: {
        model: PRIMARY_MODEL,
        prompt,
        n: 1,
        size: '1536x1024',
        quality: 'medium', // medium keeps latency inside serverless limits
        output_format: 'jpeg',
        output_compression: 80,
      },
    },
    // Same model, minimal parameter set — survives parameter deprecations.
    { model: PRIMARY_MODEL, body: { model: PRIMARY_MODEL, prompt, n: 1, size: '1536x1024' } },
    // Different model, minimal parameter set — survives model-access issues.
    { model: FALLBACK_MODEL, body: { model: FALLBACK_MODEL, prompt: prompt.slice(0, 3900), n: 1, size: '1792x1024' } },
  ];

  const errors: string[] = [];
  for (let i = 0; i < attempts.length; i++) {
    try {
      const out = await callImagesApi(attempts[i].body, 50_000);
      const bytes = out.b64 ? Buffer.from(out.b64, 'base64') : await fetchImageBytes(out.url as string, 30_000);
      if (!bytes.length) throw new Error('empty image payload');
      return { bytes, ...sniffImage(bytes), model: attempts[i].model };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      errors.push(`[${attempts[i].model}#${i + 1}] ${msg}`);
      const status = (e as Error & { apiStatus?: number }).apiStatus;
      const isLast = i === attempts.length - 1;
      // Only API-level rejections fall through to the next rung.
      if (isLast || !(status && status >= 400 && status < 500)) {
        throw new Error('image generation failed: ' + errors.join(' | '));
      }
    }
  }
  throw new Error('image generation failed: ' + errors.join(' | '));
}

// ---------------------------------------------------------------------------
// Storage: public Supabase bucket, created on first use.
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
}

async function storeImage(img: GeneratedImage, nameHint: string): Promise<string> {
  const db = supabaseAdmin();
  const path = `packs/${Date.now()}-${slugify(nameHint)}.${img.ext}`;
  const doUpload = () =>
    db.storage.from(BUCKET).upload(path, img.bytes, { contentType: img.contentType, upsert: true });

  let { error } = await doUpload();
  if (error && /bucket/i.test(error.message || '')) {
    // First run: create the public bucket, then retry once.
    try {
      await db.storage.createBucket(BUCKET, { public: true });
    } catch { /* raced another request — retry the upload regardless */ }
    ({ error } = await doUpload());
  }
  if (error) throw new Error('image upload failed: ' + error.message);
  const { data } = db.storage.from(BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error('image upload: no public URL');
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Generate + store one hero image for a pack. Throws on failure — callers
// decide whether that is fatal (it never should be).
export async function generatePackImage(opts: {
  topic: string;
  pack?: Record<string, unknown> | null;
  brand?: BrandContext | null;
  variant?: number;
}): Promise<PackImage> {
  if (!imagesEnabled()) throw new Error('image generation disabled (IMAGE_GEN=off or no OPENAI_API_KEY)');
  const variant = Math.abs(Math.round(opts.variant ?? 0)) % STYLE_VARIANTS.length;
  const prompt = buildImagePrompt({ ...opts, variant });
  const img = await generateImageBytes(prompt);
  const url = await storeImage(img, opts.topic);
  return {
    url,
    prompt,
    alt: `${opts.topic} — illustrative image for ${opts.brand?.name || 'Cellular Institute'}`,
    model: img.model,
    createdAt: new Date().toISOString(),
    variant,
  };
}

// Idempotent: give a draft an image if it doesn't have one yet. Uses the
// service-role client so Autopilot (no user session) can call it too.
// Returns the image (existing or new) or null when skipped/disabled.
export async function ensureDraftImage(draftId: string): Promise<PackImage | null> {
  if (!imagesEnabled()) return null;
  const db = supabaseAdmin();
  const { data: d } = await db.from('drafts').select('id, user_id, topic, pack').eq('id', draftId).maybeSingle();
  if (!d) return null;
  const row = d as { user_id: string; topic: string | null; pack: Record<string, unknown> | null };
  const pack = row.pack && typeof row.pack === 'object' ? row.pack : {};
  if ((pack as { kind?: string }).kind === 'clip') return null; // clips have video stills already
  const existing = (pack as { _image?: PackImage })._image;
  if (existing?.url) return existing;

  // Brand voice makes the image on-brand too (best-effort).
  let brand: BrandContext | null = null;
  try {
    const { data: bp } = await db
      .from('brand_profiles')
      .select('name, mission, voice, audience, keywords, guidelines')
      .eq('user_id', row.user_id)
      .maybeSingle();
    if (bp) brand = bp as BrandContext;
  } catch { /* optional */ }

  const image = await generatePackImage({ topic: String(row.topic || 'regenerative medicine'), pack, brand });
  const { error } = await db.from('drafts').update({ pack: { ...pack, _image: image } }).eq('id', draftId);
  if (error) throw new Error('draft image stamp failed: ' + error.message);
  return image;
}
