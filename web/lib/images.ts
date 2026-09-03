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
import { reportError } from '@/lib/report';
import { randomUUID } from 'crypto';
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { BrandContext } from '@/lib/ai';
import { classifyVerdict } from './image-verdict.ts';
import { recordImageOutcome } from '@/lib/provider-status';

// Machine verification: every generated image is inspected by a vision model
// before it is accepted, so hallucinated output (garbled text, warped
// anatomy, logos, off-topic or medically inappropriate scenes) is caught
// WITHOUT waiting for a human to notice.
export type ImageVerification = {
  status: 'approved' | 'flagged' | 'unchecked'; // unchecked = the check itself was unavailable
  score: number | null; // 0-100 quality/safety confidence from the checker
  // BLOCKING findings — the reasons the status is 'flagged'. Defects only:
  // text, anatomy, logos, graphic content (see lib/image-verdict.ts).
  issues: string[];
  // Matters of taste the reviewer raised — relevance, composition, mood —
  // shown to a person, never a reason to flag or regenerate. Four of five
  // usable images used to wear an amber warning for exactly these.
  advisory?: string[];
  // HARD RULE: generated visuals must be pure CONTENT images — any words,
  // letters, numbers or pseudo-typography the checker sees sets this flag,
  // and the pipeline treats it as the worst possible outcome (always
  // regenerates; a text-bearing candidate can never beat a text-free one).
  textDetected?: boolean;
  model: string | null;
  checkedAt: string;
};

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
  verification?: ImageVerification;
};

const BUCKET = process.env.IMAGE_BUCKET || 'content-images';
const PRIMARY_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
// Live testing (Aug 2026) showed 'dall-e-3' no longer exists on the Images
// API — the fallback is now the cheaper gpt-image tier, overridable by env.
const FALLBACK_MODEL = process.env.OPENAI_IMAGE_FALLBACK_MODEL || 'gpt-image-1-mini';
const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';
// A flagged image triggers automatic regeneration with the next composition
// variant (time-budget permitting) before surfacing to a human. Text in the
// image is a hard fail, so give the loop enough attempts to shake it off.
const MAX_GEN_ATTEMPTS = 3;
// Keep retrying while there is real time left in the serverless budget
// (route maxDuration is 60s; one generate+verify cycle is ~25s).
const RETRY_TIME_BUDGET_MS = 34_000;

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
  'Composition: wide editorial hero shot — premium modern clinic interior or a calm physician-patient consultation moment; any screens are off, any signage is blank or out of focus.',
  'Composition: macro scientific beauty — unlabeled laboratory glassware, pipettes, plain cell-culture plates, abstract luminous cellular forms; no printed labels, markings or stickers on anything.',
  'Composition: warm lifestyle — healthy, active adults (40-70) outdoors in bright coastal light, vitality and movement; plain unbranded clothing, no signage in the scene.',
  'Composition: minimal premium still-life — clean unlabeled medical/wellness objects on a soft neutral background, generous negative space; no packaging text or printed labels.',
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
    // The no-text mandate leads the prompt (image models weight the opening
    // heavily) and is repeated at the end. Every visual must be a pure
    // CONTENT image — the message is carried by the scene, never by writing.
    'A purely visual, text-free photograph. Absolutely NO text of any kind:',
    'no words, no letters, no numbers, no typography, no captions, no subtitles,',
    'no signage, no labels, no logos, no watermarks, no charts, no UI elements.',
    `Editorial hero photograph for ${brandName}.`,
    `Subject: ${opts.topic}.`,
    excerpt ? `Context from the article: ${excerpt}` : '',
    variant,
    'Style: bright, clean, modern medical-wellness aesthetic; soft natural light;',
    'calm, hopeful, trustworthy mood; photorealistic; shallow depth of field.',
    'Strict rules (must all hold): the image contains ZERO written characters in any language or script;',
    'all packaging, screens, documents and signs in the scene are blank, turned off, or absent;',
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
    // (1536x1024 is the valid landscape size for the gpt-image family; the
    // old 1792x1024 was a DALL·E-3-only size and got this rung rejected.)
    { model: FALLBACK_MODEL, body: { model: FALLBACK_MODEL, prompt: prompt.slice(0, 3900), n: 1, size: '1536x1024' } },
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
// Verification: a vision model inspects every generated image before it is
// accepted. AI image models hallucinate — garbled pseudo-text, extra fingers,
// warped faces, accidental logos — and none of that may reach a patient-facing
// channel unnoticed. Fail-soft: if the CHECK itself is unavailable the image
// is stamped 'unchecked' (surfaced as "review manually" in the UI), because
// verification must never take down image generation entirely.
// ---------------------------------------------------------------------------

const VERIFY_SYSTEM = `You are a strict visual QA reviewer for a premium regenerative medicine clinic's marketing images. Every image MUST be a pure CONTENT image — a photographic scene with ZERO written characters. You will be shown ONE AI-generated image plus its intended topic. Inspect it for generation defects and brand-safety problems:
1. TEXT CHECK (the hard rule): scan the ENTIRE image, including backgrounds, signs, screens, labels, packaging, clothing and edges, for ANY visible text, words, letters, numbers, or garbled pseudo-typography (AI text artifacts) in ANY language or script — even partial, blurry, or decorative lettering counts. Any hit is an automatic fail.
2. Anatomical errors: wrong number of fingers, warped hands/faces/limbs, merged bodies, impossible poses.
3. Logos, watermarks, brand marks, or recognizable trademarks (even without readable letters).
4. Graphic or inappropriate medical content: needles piercing skin, blood, wounds, distressing imagery.
5. Uncanny, distorted, or low-quality rendering unfit for a premium medical brand.
6. Relevance: the scene should plausibly illustrate the given topic for a clinic audience.
Return STRICT JSON only: {"approved": boolean, "textDetected": boolean, "score": number 0-100, "blocking": string[], "advisory": string[]}. textDetected=true whenever check 1 finds ANYTHING (when unsure, say true). "blocking" lists each DEFECT from checks 1-4 as a short phrase — these fail the image. "advisory" lists observations from checks 5-6 (rendering quality, relevance, composition) as short phrases — these are notes for a human and do NOT fail the image. approved=false only when "blocking" is non-empty. Both lists empty when the image is clean.`;

async function verifyGeneratedImage(img: GeneratedImage, topic: string): Promise<ImageVerification> {
  const base: ImageVerification = {
    status: 'unchecked',
    score: null,
    issues: ['automatic check unavailable — review the image manually'],
    model: null,
    checkedAt: new Date().toISOString(),
  };
  if (String(process.env.IMAGE_VERIFY || '').toLowerCase() === 'off') {
    return { ...base, issues: ['automatic verification disabled (IMAGE_VERIFY=off)'] };
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) return base;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: VERIFY_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Topic: ${topic.slice(0, 300)}. Verify this AI-generated image now.` },
              { type: 'image_url', image_url: { url: `data:${img.contentType};base64,${img.bytes.toString('base64')}` } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`vision ${res.status}`);
    const data = await res.json();
    const raw = String(data?.choices?.[0]?.message?.content ?? '{}');
    // Defects flag; opinions are notes. The split (and the text hard rule)
    // lives in lib/image-verdict.ts where it is unit-tested.
    const verdict = classifyVerdict(JSON.parse(raw));
    return {
      status: verdict.status,
      score: verdict.score,
      issues: verdict.issues,
      advisory: verdict.advisory,
      textDetected: verdict.textDetected,
      model: VISION_MODEL,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    // Verification must never break generation — surface as 'unchecked'.
    return base;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Storage: public Supabase bucket, created on first use.
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
}

async function storeImage(img: GeneratedImage, nameHint: string): Promise<string> {
  const db = supabaseAdmin();
  // The bucket is public, so the object name is the only thing separating one
  // draft's image from anyone with a browser. `packs/<Date.now()>-<slug>` was
  // guessable: the slug comes from the post title and the timestamp is bounded
  // by the draft's created_at, which /api/drafts returns - about a thousand
  // unauthenticated GETs to recover someone else's image. A random component
  // makes the name unguessable; the slug stays for human legibility.
  const path = `packs/${Date.now()}-${randomUUID()}-${slugify(nameHint)}.${img.ext}`;
  const doUpload = () =>
    db.storage.from(BUCKET).upload(path, img.bytes, { contentType: img.contentType, upsert: true });

  let { error } = await doUpload();
  if (error && /bucket/i.test(error.message || '')) {
    // First run: create the public bucket, then retry once.
    try {
      await db.storage.createBucket(BUCKET, { public: true });
    } catch (err) { /* raced another request — retry the upload regardless */ reportError('images:bucket-create', err); }
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

// Generate, VERIFY, and store one hero image for a pack. Throws on failure —
// callers decide whether that is fatal (it never should be).
//
// The verify-retry loop: every candidate is inspected by the vision checker;
// a flagged image is automatically regenerated ONCE with the next composition
// variant (time-budget permitting) before anything is stored. If the retry is
// also flagged, the best candidate is stored anyway WITH its flag — the UI
// shows the issues so the human reviewer sees exactly why, and "New image"
// rolls again. Silent discards would just burn credits with nothing to show.
export async function generatePackImage(opts: {
  topic: string;
  pack?: Record<string, unknown> | null;
  brand?: BrandContext | null;
  variant?: number;
}): Promise<PackImage> {
  // Record how this went before handing the result (or the failure) on, so
  // /api/health can say whether images WORK rather than whether a key is set.
  // The refusal below is deliberately not recorded: nothing was attempted, and
  // "IMAGE_GEN is off" is already a configuration check that health can see.
  if (!imagesEnabled()) throw new Error('image generation disabled (IMAGE_GEN=off or no OPENAI_API_KEY)');
  try {
    const made = await generateBestPackImage(opts);
    recordImageOutcome({ ok: true });
    return made;
  } catch (e) {
    recordImageOutcome({ ok: false, message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function generateBestPackImage(opts: {
  topic: string;
  pack?: Record<string, unknown> | null;
  brand?: BrandContext | null;
  variant?: number;
}): Promise<PackImage> {
  const baseVariant = Math.abs(Math.round(opts.variant ?? 0)) % STYLE_VARIANTS.length;
  const started = Date.now();

  let best: { img: GeneratedImage; prompt: string; variant: number; verification: ImageVerification } | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
    const variant = (baseVariant + attempt) % STYLE_VARIANTS.length;
    const prompt = buildImagePrompt({ ...opts, variant });
    // A retry that fails must not destroy an already-paid-for candidate. This
    // call sat outside any try/catch, so an OpenAI 5xx or a timeout on the
    // SECOND attempt threw straight out of this function and discarded a
    // perfectly usable first image — exactly the "silent discard that burns
    // credits with nothing to show" the retry loop exists to avoid. Under
    // approveRun that surfaced as a post shipping with no image at all.
    let img: GeneratedImage;
    try {
      img = await generateImageBytes(prompt);
    } catch (e) {
      lastError = e;
      // With a usable candidate in hand, stop and store it. With nothing in
      // hand, fail immediately rather than retrying: generateImageBytes has
      // ALREADY walked its own 3-rung model/parameter ladder, so a throw here
      // means every rung failed. Retrying the whole loop would triple the
      // failed-call volume against an API that is out of credit or rejecting
      // our key — the exact case the fail-fast error message is for.
      if (best) break;
      throw e;
    }
    const verification = await verifyGeneratedImage(img, opts.topic);
    const candidate = { img, prompt, variant, verification };
    // Keep the better candidate. Ranking encodes the content-image rule:
    // approved > unchecked > flagged-without-text > ANY candidate with text.
    // A text-bearing image can never beat a text-free one, whatever its score.
    const rank = (v: ImageVerification) =>
      (v.textDetected ? 0 : v.status === 'approved' ? 600 : v.status === 'unchecked' ? 400 : 200) + (v.score ?? 0);
    if (!best || rank(verification) > rank(best.verification)) best = candidate;
    if (verification.status !== 'flagged') break; // clean (or uncheckable) — done
    // Flagged (text or other defects): retry with the next composition while
    // there is real time left in the serverless budget.
    if (Date.now() - started > RETRY_TIME_BUDGET_MS) break;
  }
  if (!best) {
    throw lastError instanceof Error
      ? lastError
      : new Error('image generation produced no candidate');
  }

  const url = await storeImage(best.img, opts.topic);
  return {
    url,
    prompt: best.prompt,
    alt: `${opts.topic} — illustrative image for ${opts.brand?.name || 'Cellular Institute'}`,
    model: best.img.model,
    createdAt: new Date().toISOString(),
    variant: best.variant,
    verification: best.verification,
  };
}

// Idempotent: give a draft an image if it doesn't have one yet. Uses the
// service-role client so Autopilot (no user session) can call it too.
// Returns the image (existing or new) or null when skipped/disabled.
// `ownerId` is REQUIRED, not optional. This runs on the service-role client,
// which bypasses RLS, and its only caller passes a draft id read off a
// template_runs row - a column a user can point at somebody else's draft.
// Without the owner check this function both reads and WRITES that draft.
export async function ensureDraftImage(draftId: string, ownerId: string): Promise<PackImage | null> {
  if (!imagesEnabled()) return null;
  const db = supabaseAdmin();
  const { data: d } = await db
    .from('drafts').select('id, user_id, topic, pack')
    .eq('id', draftId).eq('user_id', ownerId).maybeSingle();
  if (!d) return null;
  const row = d as { user_id: string; topic: string | null; pack: Record<string, unknown> | null };
  const pack = row.pack && typeof row.pack === 'object' ? row.pack : {};
  if ((pack as { kind?: string }).kind === 'clip') return null; // clips have video stills already
  const existing = (pack as { _image?: PackImage })._image;
  // Same content-image rule as the route: an image flagged for text is never
  // reused — regenerate with the next composition variant instead.
  const existingHasText = existing?.verification?.textDetected === true;
  if (existing?.url && !existingHasText) return existing;

  // Brand voice makes the image on-brand too (best-effort).
  let brand: BrandContext | null = null;
  try {
    const { data: bp } = await db
      .from('brand_profiles')
      .select('name, mission, voice, audience, keywords, guidelines')
      .eq('user_id', row.user_id)
      .maybeSingle();
    if (bp) brand = bp as BrandContext;
  } catch (err) { /* optional */ reportError('images:draft-stamp', err); }

  const image = await generatePackImage({
    topic: String(row.topic || 'regenerative medicine'),
    pack,
    brand,
    variant: existingHasText ? (existing?.variant ?? 0) + 1 : 0,
  });
  // Same re-read as /api/drafts/image: the pack read before generation is
  // 30-60s stale, and a redraft in that window would otherwise be silently
  // reverted by this write. Merge `_image` into whatever is there NOW.
  const { data: fresh } = await db
    .from('drafts').select('pack').eq('id', draftId).eq('user_id', ownerId).maybeSingle();
  const currentPack = (fresh as { pack?: Record<string, unknown> } | null)?.pack ?? pack;
  const { error } = await db
    .from('drafts').update({ pack: { ...currentPack, _image: image } })
    .eq('id', draftId).eq('user_id', ownerId);
  if (error) throw new Error('draft image stamp failed: ' + error.message);
  return image;
}
