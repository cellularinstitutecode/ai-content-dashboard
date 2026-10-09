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
import { cleanTopic, familyAt, onTopicCheck, plannerImageFor, plannerPromptLines, scienceOffered, SHOT_COUNT, type PlannerImage } from '@/lib/planner-image';
import { renderTitleCover } from '@/lib/title-cover';
import { resolveCoverTitle } from '@/lib/cover-title';
import { FEED_BASELINE } from '@/lib/planner-image';
import { briefSource, briefSystemPrompt, briefUserPrompt, parseSceneBrief, type SceneBrief } from '@/lib/image-brief';
import { COVER_MIN_HEAD_TOP_PCT, ownBucketUrl, photographVerdict, type LibraryProvenance } from './library-cover.ts';
import { cleanCoverTitle, notesOf, retitleDecision, takesOf } from './cover-edit.ts';
import { setStoredFontReader } from '@/lib/brand-card';
import { readStoredFonts } from '@/lib/brand-fonts';

// Canela, once uploaded in Brand Brain, lives in private storage; the cover
// renderer reads it through the same loader the brand-card route uses.
setStoredFontReader(readStoredFonts);
import { reportError } from '@/lib/report';
import { randomUUID } from 'crypto';
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import type { BrandContext } from '@/lib/ai';
import { normalizeVisual, visualPromptBlock, brandFitRubric, type BrandVisual } from '@/lib/brand-visual';
import { classifyVerdict, imageUnshippable } from './image-verdict.ts';
import { supersededKeys } from './storage-prune.ts';
import { noteSameAccountSuccess, recordImageOutcome } from '@/lib/provider-status';

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
  // Same weight as text: a banned prop or a device on a person in frame. Such
  // an image may never be attached (lib/image-verdict.ts imageUnshippable).
  bannedProp?: boolean;
  /** Planner covers: where the highest head starts, as a percentage of the photo's height. */
  headTopPct?: number | null;
  // Advisory 0-100 from the same reviewer: does the picture live in the
  // brand's palette, materials and camera (lib/brand-visual.ts)? Shown to the
  // human; breaks ties between two clean candidates; never flags anything.
  brandFit?: number | null;
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
  // 'brand-card' marks a typographic card painted by lib/brand-card.ts from
  // approved text: its words are deliberate, so the text rule does not apply.
  source?: 'generated' | 'brand-card' | 'library' | 'upload';
  /**
   * Titled covers: `url` is the photograph WITH its title set by
   * lib/title-cover.ts; `photoUrl` is the clean, verified photograph under it.
   * `verification` describes the photograph — the title's words are ours and
   * deliberate, so the text rule does not apply to them. Weekly-planner
   * covers, and library photos set with "Use library photo with brand filter".
   */
  titled?: {
    title: string;
    photoUrl: string;
    family: string;
    /** True once a person set the words (or turned them off: title '') in the Edit image panel; regenerations keep them. */
    custom?: boolean;
  };
  /**
   * The team's notes for the picture, as last used ("two women at a table, no
   * lab coat"). Shown again in the Edit image panel and reused by "New image"
   * and "Show me 3 options" until cleared (lib/cover-edit.ts).
   */
  direction?: string;
  /** How many image generations this draft has had, across takes; the panel asks before a credit once it is 3+. */
  takes?: number;
  /** Older takes only: the library photo an AI image was styled after. That path is gone. */
  styledAfter?: string;
  /**
   * An edited take: the clean photograph this one was made FROM, with the
   * team's notes applied to it (editPackImage). The notes used to produce a
   * new, unrelated picture; this records that they changed the one that was
   * there, so the card can say so.
   */
  editedFrom?: string;
  /** Library photos: was the brand's colour filter applied (lib/library-cover.ts)? */
  brandGraded?: boolean;
  /** The ffmpeg filters that were applied; empty when the photo was already in the palette. */
  filters?: string[];
  palette?: LibraryProvenance['palette'];
  padded?: number;
  libraryFileId?: string;
  libraryName?: string;
};

const BUCKET = process.env.IMAGE_BUCKET || 'content-images';
/** The public bucket every generated, painted or imported image lands in. */
export const IMAGE_BUCKET = BUCKET;
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
// Planner covers: one generation takes ~40-60s, so the 34s budget above meant a
// flagged cover (off topic, or a head in the title band) was never retried.
// These routes run for up to 300s; allow a retry to START within 120s.
const PLANNER_RETRY_BUDGET_MS = 100_000;
// A high-quality 1024x1536 planner photo with the long master-shot prompt can
// take longer than the 50s allowed per Images call; cut off at 50s, the first
// live attempt failed with "This operation was aborted". Planner calls get
// 110s (the routes that run them allow 300s).
const PLANNER_IMAGE_CALL_MS = 110_000;
// Every other draft got 50s — the allowance of the sixty-second function this
// began in — and gpt-image-1 at `high` takes 40-100s for a 1536x1024
// photograph. So the first rung was cut off on most calls, and since a timeout
// never fell through to the rung below, a whole week of strategy previews came
// back "[gpt-image-1#1] This operation was aborted" with no picture at all.
// The call now gets the same 110s (every route that makes pictures runs for
// 300s; a caller with less time says so through budgetMs and gets what fits).
const IMAGE_CALL_MS = 110_000;
// After a timeout, the next rung (medium quality, much faster) is still tried
// when at least this much of the caller's time is left for it.
const FALLBACK_AFTER_TIMEOUT_MIN_MS = 45_000;
// The title band covers roughly the top quarter of the cover; the photo is
// cropped from the top (lib/title-cover.ts), so heads must start below this.
// One number for planner covers and titled library photos.
const PLANNER_MIN_HEAD_TOP_PCT = COVER_MIN_HEAD_TOP_PCT;
// A retry that cannot finish before the caller's deadline is not started:
// FIX runs inside a 300 s function, and a planner take (brief + generation +
// check) needs about this long; the Images call itself is shortened to fit.
const PLANNER_ATTEMPT_MS = 120_000;
// The same for every draft now that the call itself may take 110s.
const ATTEMPT_MS = 120_000;

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
  // Each variant is a scene from the brand guide's own photography direction
  // (8.2) and mockups (7.1): the world the pictures live in, not a generic clinic.
  'Composition: wide editorial shot of the clinic reception — cream travertine desk, walnut panelling with warm recessed light lines, pale sage armchairs, generous negative space; any screens off, any signage blank or out of focus.',
  'Composition: consultation moment — a clinician in plain black scrubs with a patient in a warm, calm treatment room in cream and walnut; eye-level camera, natural unposed expressions, shallow depth of field; no charts, no labels.',
  'Composition: portrait against a plain terracotta / rust backdrop — a relaxed adult (40-70) or a small clinical team in black scrubs, warm soft light, minimal styling, natural expression, plenty of empty backdrop around them.',
  'Composition: macro scientific beauty in the brand palette — unlabeled glassware, plain culture plates or abstract luminous cellular forms in warm amber, rust and cream tones on a soft neutral ground; no printed labels or markings.',
  'Composition: minimal premium still-life — a few clean unlabeled wellness objects on pale stone or pearl linen, one walnut or terracotta accent, soft directional light, wide negative space; no packaging text.',
];

export function buildImagePrompt(opts: {
  topic: string;
  pack?: Record<string, unknown> | null;
  brand?: BrandContext | null;
  variant?: number;
  /**
   * What the team asked for, in their own words.
   *
   * Added because "the photos look too AI" is a direction nobody could give:
   * the prompt was built entirely from the post and a rotating style variant,
   * and the only control was to press New image and hope. It is inserted as
   * DIRECTION rather than replacing the prompt, so the no-text mandate and the
   * brand's palette still hold — an image with words in it is refused by the
   * verifier either way, and a prompt that loses the brand block paints
   * somebody else's clinic.
   */
  direction?: string | null;
  /** Weekly-planner drafts only: pictured from their pillar and angle (lib/planner-image.ts). */
  planner?: PlannerImage | null;
  /** The plan slot this take belongs to, when the caller is asking for a specific one. */
  slot?: number | null;
}): string {
  const brandName = opts.brand?.name || 'a premium regenerative medicine and longevity clinic';
  const excerpt = excerptOf(opts.pack);
  const variant = STYLE_VARIANTS[Math.abs(Math.round(opts.variant ?? 0)) % STYLE_VARIANTS.length];
  // The brand's own palette, materials and camera — from Brand Brain, or the
  // guide's defaults. Without this the model paints "a clinic": cool light,
  // white and steel, someone else's brand.
  const visual = visualPromptBlock(normalizeVisual(opts.brand?.visual));
  const direction = String(opts.direction || '').trim();
  const noText = [
    // The no-text mandate leads the prompt (image models weight the opening
    // heavily) and is repeated at the end. Every visual must be a pure
    // CONTENT image — the message is carried by the scene, never by writing.
    'A purely visual, text-free photograph. Absolutely NO text of any kind:',
    'no words, no letters, no numbers, no typography, no captions, no subtitles,',
    'no signage, no labels, no logos, no watermarks, no charts, no UI elements.',
  ];
  const strict = [
    'Strict rules (must all hold): the image contains ZERO written characters in any language or script;',
    'all packaging, screens, documents and signs in the scene are blank, turned off, or absent;',
    'no needles piercing skin, no blood, no graphic medical procedures, nothing that implies a medical claim.',
  ];
  // WEEKLY-PLANNER DRAFTS: the look the clinic chose (lib/planner-image.ts) —
  // a bright daylight consultation with the topic on the table, and the top
  // third left clear for the title lib/title-cover.ts sets afterwards. The
  // Brand Brain's materials line (dark walnut, black scrubs) is deliberately
  // not used here; its palette survives as small accents.
  if (opts.planner) {
    const palette = normalizeVisual(opts.brand?.visual).palette.filter((c) => c.role !== 'dark').map((c) => c.name.toLowerCase()).join(', ');
    return [
      ...noText,
      `Editorial photograph for ${brandName}.`,
      ...plannerPromptLines(opts.planner, opts.variant ?? 0, direction, opts.planner.shotFamily || null),
      excerpt ? `Context from the post: ${excerpt}` : '',
      `The brand's colours may appear only as the faintest accents (${palette}); the frame itself stays light, neutral and clean — never orange-tinted.`,
      'Never: stock-photo poses or forced smiles at the camera; cool blue clinical light; chrome and glass laboratory clichés; dark or moody lighting; clutter;',
      'no supplement, medicine or pill bottles, no vials, ampoules or syringes, no branded packaging, no uniforms with logos.',
      'Style: photorealistic, high-end lifestyle editorial, soft window light, gentle shadows, natural colour.',
      ...strict,
    ].filter(Boolean).join(' ');
  }
  return [
    ...noText,
    `Editorial hero photograph for ${brandName}.`,
    `Subject: ${opts.topic}.`,
    excerpt ? `Context from the article: ${excerpt}` : '',
    // The team's own direction outranks the rotating style variant: when
    // somebody has said what they want, a composition picked by a counter is
    // noise. Both are kept when there is no direction.
    direction ? `Direction from the team (follow this closely): ${direction}` : variant,
    FEED_BASELINE,
    visual,
    'Style: warm, quiet, premium editorial photograph; soft directional light; calm, confident, trustworthy mood; photorealistic; shallow depth of field.',
    ...strict,
  ].filter(Boolean).join(' ');
}

/**
 * The prompt for EDITING the picture a draft already has.
 *
 * "Notes for the picture" used to be a text-to-image prompt: the stored
 * photograph was never shown to the model, so "warmer light, no glasses"
 * produced a different photograph of different people in a different room.
 * This asks for the picture that is there, changed only where the notes say.
 * The no-text mandate and the medical limits hold exactly as they do for a
 * fresh take, and the verifier reads the result either way.
 */
export function buildEditPrompt(opts: {
  direction?: string | null;
  topic: string;
  brand?: BrandContext | null;
  /** A planner cover gets its title set on the top third afterwards, so that band must stay clear. */
  planner?: PlannerImage | null;
}): string {
  const brandName = opts.brand?.name || 'a premium regenerative medicine and longevity clinic';
  const direction = String(opts.direction || '').trim();
  return [
    'Edit this photograph as directed. Keep everything the direction does not mention exactly as it is:',
    'the same people and their faces, the same setting, framing, camera angle and lighting.',
    direction
      ? `Direction from the team (follow this closely): ${direction}`
      : 'No specific direction was given: make a subtly refined take of the same scene — natural, photorealistic, nothing added.',
    `The picture illustrates a post for ${brandName} about: ${String(opts.topic || '').trim()}.`,
    FEED_BASELINE,
    opts.planner ? 'Keep the top third of the frame clear and uncluttered: a title is set there afterwards.' : '',
    'The result is a purely visual, text-free photograph: no words, letters, numbers, typography, signage, labels, logos or watermarks anywhere;',
    'no needles piercing skin, no blood, no graphic medical procedures, nothing that implies a medical claim.',
    'Photorealistic, natural colour, soft light; no stock-photo poses or forced smiles at the camera.',
  ].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// OpenAI Images call (gpt-image-1 primary, DALL·E 3 fallback on API errors).
// ---------------------------------------------------------------------------

/**
 * One call to the Images API, generations or edits. Returns whichever the API
 * gives us — inline base64 or a short-lived asset URL — so callers survive
 * response-shape differences between models and API revisions.
 */
async function postImages(
  endpoint: 'generations' | 'edits',
  body: string | FormData,
  timeoutMs: number,
): Promise<{ b64?: string; url?: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      // A FormData body sets its own multipart content-type (with the boundary).
      res = await fetch('https://api.openai.com/v1/images/' + endpoint, {
        method: 'POST',
        headers: { ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${key}` },
        body,
        signal: controller.signal,
      });
    } catch (e) {
      // Our own timer, said as such: "This operation was aborted" told the
      // team nothing about what to do, and read like OpenAI had refused.
      if (controller.signal.aborted) {
        const err = new Error('no picture within ' + Math.round(timeoutMs / 1000) + 's');
        (err as Error & { timedOut?: boolean }).timedOut = true;
        throw err;
      }
      throw e;
    }
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

/** Text to image. */
async function callImagesApi(body: Record<string, unknown>, timeoutMs: number): Promise<{ b64?: string; url?: string }> {
  return postImages('generations', JSON.stringify(body), timeoutMs);
}

/** Image to image: the photograph goes up with the prompt, as multipart form data. */
async function callImageEditsApi(form: FormData, timeoutMs: number): Promise<{ b64?: string; url?: string }> {
  return postImages('edits', form, timeoutMs);
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
/** Where the model ladder starts: `high` for a post that ships; `medium` (about a quarter of the price) for a preview. */
export type ImageQuality = 'high' | 'medium';

async function generateImageBytes(
  prompt: string,
  size: '1536x1024' | '1024x1024' | '1024x1536' = '1536x1024',
  callMs = IMAGE_CALL_MS,
  /** When the caller's time runs out, as a clock reading; null when it has the whole function. */
  deadline: number | null = null,
  quality: ImageQuality = 'high',
): Promise<GeneratedImage> {
  const ladder: { model: string; body: Record<string, unknown> }[] = [
    // HIGH, not medium.
    //
    // "Honestly the photos look too AI." Quality is the lever that answers that
    // most directly: at medium the model spends less on the things that read as
    // synthetic — hands, skin, the way light falls on a real surface — and
    // those are exactly what a clinical photograph is judged on.
    //
    // It was medium because "medium keeps latency inside serverless limits",
    // and that was true of a 60-second function. This route now runs at the
    // ceiling app/api/posts uses, and the rung below catches a generation that
    // still runs long, so the trade no longer has to be made in advance.
    {
      model: PRIMARY_MODEL,
      body: {
        model: PRIMARY_MODEL,
        prompt,
        n: 1,
        size,
        quality: 'high',
        output_format: 'jpeg',
        output_compression: 80,
      },
    },
    // The old first rung, kept as the second: a model that will not do `high`,
    // or a day when it is too slow, still produces an image rather than none.
    {
      model: PRIMARY_MODEL,
      body: {
        model: PRIMARY_MODEL,
        prompt,
        n: 1,
        size,
        quality: 'medium',
        output_format: 'jpeg',
        output_compression: 80,
      },
    },
    // Same model without `quality` — the parameter whose accepted values have
    // moved between model generations — but STILL asking for JPEG. The format
    // matters more than it looks: a rung that omits output_format gets PNG
    // back, and a 1536x1024 PNG is 2-5 MB where the JPEG is 250-500 KB — ten
    // times the storage for every image made on a day the first rung was
    // refused, kept for as long as the draft lives.
    { model: PRIMARY_MODEL, body: { model: PRIMARY_MODEL, prompt, n: 1, size, output_format: 'jpeg', output_compression: 80 } },
    // Different model, minimal parameter set — survives model-access issues AND
    // any output_* deprecation, which is why this last rung stays bare even
    // though it can come back as PNG. (1536x1024 is the valid landscape size
    // for the gpt-image family; the old 1792x1024 was a DALL·E-3-only size and
    // got this rung rejected.)
    { model: FALLBACK_MODEL, body: { model: FALLBACK_MODEL, prompt: prompt.slice(0, 3900), n: 1, size } },
  ];

  // A preview does not pay for `high`: its ladder starts at the medium rung.
  const attempts = quality === 'medium' ? ladder.filter((a) => a.body.quality !== 'high') : ladder;
  const errors: string[] = [];
  /** The time a rung may take: the usual allowance, or what is left of the deadline minus the check. */
  const rungMs = (): number => (deadline == null ? callMs : Math.max(20_000, Math.min(callMs, deadline - Date.now() - 30_000)));
  for (let i = 0; i < attempts.length; i++) {
    try {
      const out = await callImagesApi(attempts[i].body, rungMs());
      const bytes = out.b64 ? Buffer.from(out.b64, 'base64') : await fetchImageBytes(out.url as string, 30_000);
      if (!bytes.length) throw new Error('empty image payload');
      return { bytes, ...sniffImage(bytes), model: attempts[i].model };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      errors.push(`[${attempts[i].model}#${i + 1}] ${msg}`);
      const status = (e as Error & { apiStatus?: number }).apiStatus;
      const timedOut = Boolean((e as Error & { timedOut?: boolean }).timedOut);
      const isLast = i === attempts.length - 1;
      // API-level rejections fall through to the next rung. So does a timeout,
      // when there is time for the rung below — `high` running long is the
      // ordinary case, and the medium rung under it is several times faster —
      // never when a second slow call would bust the caller's budget.
      const timeForAnother = deadline == null || deadline - Date.now() >= FALLBACK_AFTER_TIMEOUT_MIN_MS;
      const rejected = Boolean(status && status >= 400 && status < 500);
      if (isLast || !(rejected || (timedOut && timeForAnother))) {
        throw new Error('image generation failed: ' + errors.join(' | '));
      }
    }
  }
  throw new Error('image generation failed: ' + errors.join(' | '));
}

/**
 * EDIT a photograph: the bytes go up with the prompt (POST /v1/images/edits)
 * and the model returns the same picture, changed as directed.
 *
 * The same ladder shape as generateImageBytes, for the same reasons. Two
 * things differ. `input_fidelity: high` on the first rungs keeps the faces
 * and the fine detail of the photograph that is being edited — the whole
 * point of editing rather than regenerating — and is dropped on the bare
 * rung in case a model does not take it. `size: auto` keeps the photograph's
 * own shape: a portrait planner cover stays portrait, a landscape hero stays
 * landscape, without this code having to measure anything.
 */
async function editImageBytes(
  prompt: string,
  source: { bytes: Buffer; contentType: string },
  callMs = IMAGE_CALL_MS,
  deadline: number | null = null,
  quality: ImageQuality = 'high',
): Promise<GeneratedImage> {
  const rungs: { model: string; fields: Record<string, string> }[] = [
    { model: PRIMARY_MODEL, fields: { quality: 'high', input_fidelity: 'high', output_format: 'jpeg', output_compression: '80' } },
    { model: PRIMARY_MODEL, fields: { quality: 'medium', input_fidelity: 'high', output_format: 'jpeg', output_compression: '80' } },
    { model: PRIMARY_MODEL, fields: { output_format: 'jpeg', output_compression: '80' } },
    { model: FALLBACK_MODEL, fields: {} },
  ];
  const attempts = quality === 'medium' ? rungs.filter((r) => r.fields.quality !== 'high') : rungs;
  const ext = source.contentType === 'image/png' ? 'png' : source.contentType === 'image/webp' ? 'webp' : 'jpg';
  const errors: string[] = [];
  const rungMs = (): number => (deadline == null ? callMs : Math.max(20_000, Math.min(callMs, deadline - Date.now() - 30_000)));
  for (let i = 0; i < attempts.length; i++) {
    const form = new FormData();
    form.append('model', attempts[i].model);
    form.append('prompt', prompt.slice(0, 3900));
    form.append('n', '1');
    form.append('size', 'auto');
    for (const [k, v] of Object.entries(attempts[i].fields)) form.append(k, v);
    form.append('image', new Blob([new Uint8Array(source.bytes)], { type: source.contentType }), 'photo.' + ext);
    try {
      const out = await callImageEditsApi(form, rungMs());
      const bytes = out.b64 ? Buffer.from(out.b64, 'base64') : await fetchImageBytes(out.url as string, 30_000);
      if (!bytes.length) throw new Error('empty image payload');
      return { bytes, ...sniffImage(bytes), model: attempts[i].model };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error';
      errors.push(`[${attempts[i].model}#${i + 1}] ${msg}`);
      const status = (e as Error & { apiStatus?: number }).apiStatus;
      const timedOut = Boolean((e as Error & { timedOut?: boolean }).timedOut);
      const isLast = i === attempts.length - 1;
      const timeForAnother = deadline == null || deadline - Date.now() >= FALLBACK_AFTER_TIMEOUT_MIN_MS;
      const rejected = Boolean(status && status >= 400 && status < 500);
      if (isLast || !(rejected || (timedOut && timeForAnother))) {
        throw new Error('image edit failed: ' + errors.join(' | '));
      }
    }
  }
  throw new Error('image edit failed: ' + errors.join(' | '));
}

/**
 * The photograph a draft keeps, fetched back for editing.
 *
 * Server-side, so only from the app's own bucket: a request must not be able
 * to point this at any address it likes (lib/library-cover.ts ownBucketUrl).
 */
async function fetchOwnPhoto(url: string): Promise<{ bytes: Buffer; contentType: string }> {
  if (!ownBucketUrl(url, process.env.NEXT_PUBLIC_SUPABASE_URL, IMAGE_BUCKET)) throw new Error('that picture is not one the dashboard stored');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) throw new Error('photo fetch ' + res.status);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new Error('photo fetch: empty');
    if (bytes.length > 30 * 1024 * 1024) throw new Error('photo fetch: too large');
    return { bytes, contentType: sniffImage(bytes).contentType };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Verification: a vision model inspects every generated image before it is
// accepted. AI image models hallucinate — garbled pseudo-text, extra fingers,
// warped faces, accidental logos — and none of that may reach a patient-facing
// channel unnoticed. Fail-soft: if the CHECK itself is unavailable the image
// is stamped 'unchecked' (surfaced as "review manually" in the UI), because
// verification must never take down image generation entirely.
// ---------------------------------------------------------------------------

const HEADROOM_CHECK = 'HEADROOM: measure how far down from the top edge the top of the highest person\'s head is, as a percentage of the image height (0 = top edge, 100 = bottom edge). Report it as "headTopPct". If no head is in frame at all (hands only, objects only, no people), report 100: a head out of frame is plenty of room for the title and is NEVER a defect, so never list it as one.';

/**
 * The reviewer's brief. A planner image adds the on-topic check and the
 * headroom measurement; a titled library photo asks for the headroom alone
 * (its subject is the clinic's own choice).
 */
const verifySystem = (rubric: string, planner?: PlannerImage | null, headroom = false) => {
  const base = verifySystemBase(rubric);
  const marker = 'Return STRICT JSON only: {"approved": boolean, "textDetected": boolean,';
  if (planner) {
    return base.replace(marker, '8. ' + onTopicCheck(planner) + '\n9. ' + HEADROOM_CHECK + '\nReturn STRICT JSON only: {"approved": boolean, "textDetected": boolean, "bannedProp": boolean, "onTopic": boolean, "headTopPct": number,');
  }
  if (headroom) {
    return base.replace(marker, '8. ' + HEADROOM_CHECK + '\nReturn STRICT JSON only: {"approved": boolean, "textDetected": boolean, "bannedProp": boolean, "headTopPct": number,');
  }
  return base;
};

const verifySystemBase = (rubric: string) => `You are a strict visual QA reviewer for a premium regenerative medicine clinic's marketing images. Every image MUST be a pure CONTENT image — a photographic scene with ZERO written characters. You will be shown ONE AI-generated image plus its intended topic. Inspect it for generation defects and brand-safety problems:
1. TEXT CHECK (the hard rule): scan the ENTIRE image, including backgrounds, signs, screens, labels, packaging, clothing and edges, for ANY visible text, words, letters, numbers, or garbled pseudo-typography (AI text artifacts) in ANY language or script — even partial, blurry, or decorative lettering counts. Any hit is an automatic fail.
2. Anatomical errors: wrong number of fingers, warped hands/faces/limbs, merged bodies, impossible poses.
3. Logos, watermarks, brand marks, or recognizable trademarks (even without readable letters).
4. Graphic or inappropriate medical content: needles piercing skin, blood, wounds, distressing imagery.
4b. BANNED PROPS (answer this one separately and carefully, like check 1): is there an anatomical model or medical teaching prop in frame — a model or replica brain, heart, spine, lung, kidney, skeleton, skull, torso or mannequin? Or an anatomical chart, poster or diagram? Or a pill, supplement, vitamin or medicine bottle, a blister pack, loose tablets or capsules? Or a syringe, vial or ampoule? Or a medical device WORN BY or ATTACHED TO a person, or held as though it were being administered — a blood-pressure cuff on an arm, ECG leads or electrodes, a pulse oximeter on a finger, an IV line, drip, cannula or port, a glucose monitor or patch, an oxygen mask, a bandage or dressing, or a syringe or injector pen in someone's hand? (A device lying unused on a table, connected to nobody, is fine.) Any one of these is an automatic fail. Report it as "bannedProp": true. When unsure, say true.
5. Uncanny, distorted, or low-quality rendering unfit for a premium medical brand.
6. Relevance: the scene should plausibly illustrate the given topic for a clinic audience.
7. ${rubric}
Return STRICT JSON only: {"approved": boolean, "textDetected": boolean, "bannedProp": boolean, "score": number 0-100, "brandFit": number 0-100, "blocking": string[], "advisory": string[]}. textDetected=true whenever check 1 finds ANYTHING (when unsure, say true). bannedProp=true whenever check 4b finds ANYTHING (when unsure, say true); it fails the image on its own. "blocking" lists each DEFECT from checks 1-4 as a short phrase — these fail the image. "advisory" lists observations from checks 5-7 (rendering quality, relevance, composition, brand fit) as short phrases — these are notes for a human and do NOT fail the image. "brandFit" is check 7 alone and never changes "approved". approved=false only when "blocking" is non-empty. Both lists empty when the image is clean.`;

/**
 * Dynamic art direction for a planner image: a small text model reads the post
 * and names the scene and the objects that make its subject obvious
 * (lib/image-brief.ts). Fail-soft — null means "use the pillar's fixed scenes".
 */
async function sceneBriefFor(planner: PlannerImage, pack: Record<string, unknown> | null | undefined, variant: number): Promise<SceneBrief | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key || String(process.env.IMAGE_BRIEF || '').toLowerCase() === 'off') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_BRIEF_MODEL || VISION_MODEL,
        max_tokens: 300,
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: briefSystemPrompt() },
          { role: 'user', content: briefUserPrompt({ title: planner.title, angle: planner.subject, pillarName: planner.pillarName, text: briefSource(pack), variant }) },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`brief ${res.status}`);
    const data = await res.json();
    return parseSceneBrief(String(data?.choices?.[0]?.message?.content ?? ''));
  } catch (err) {
    reportError('images:scene-brief', err, { title: planner.title });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The same reviewer, for a photograph the clinic chose from its library that
 * is about to carry a title (lib/library-hero.ts). It is asked where the
 * highest head starts, and — for a weekly-planner post — whether the picture
 * shows the subject. Text or a prop in a REAL photo is a note, not a defect
 * (lib/library-cover.ts photographVerdict). Never throws: an unreachable
 * checker leaves the photo 'unchecked', as it does a generated one.
 */
export async function verifyLibraryPhoto(
  photo: { bytes: Buffer; contentType: string },
  opts: { subject: string; brand?: BrandContext | null; planner?: PlannerImage | null },
): Promise<ImageVerification> {
  return verifyGeneratedImage(
    { bytes: photo.bytes, contentType: photo.contentType, ext: '', model: 'library' },
    opts.subject,
    normalizeVisual(opts.brand?.visual),
    opts.planner ?? null,
    { headroom: true, photograph: true },
  );
}

async function verifyGeneratedImage(
  img: GeneratedImage,
  topic: string,
  visual?: BrandVisual | null,
  planner?: PlannerImage | null,
  mode: { headroom?: boolean; photograph?: boolean } = {},
): Promise<ImageVerification> {
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
          { role: 'system', content: verifySystem(brandFitRubric(visual || normalizeVisual(null)), planner, mode.headroom) },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Topic: ${topic.slice(0, 300)}. Verify this ${mode.photograph ? 'photograph' : 'AI-generated image'} now.` },
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
    const measured = classifyVerdict(JSON.parse(raw), {
      ...(planner ? { requireOnTopic: true } : {}),
      ...(planner || mode.headroom ? { minHeadTopPct: PLANNER_MIN_HEAD_TOP_PCT } : {}),
    });
    const verdict = mode.photograph ? photographVerdict(measured) : measured;
    // The account answered: a stale "out of credit" on record is cleared.
    noteSameAccountSuccess();
    return {
      status: verdict.status,
      score: verdict.score,
      headTopPct: verdict.headTopPct ?? null,
      issues: verdict.issues,
      advisory: verdict.advisory,
      textDetected: verdict.textDetected,
      bannedProp: verdict.bannedProp,
      brandFit: verdict.brandFit,
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
  return storeBytes(img.bytes, img.contentType, img.ext, nameHint);
}

/**
 * Put any image bytes in the app's public bucket and return the URL Metricool
 * can fetch. Used by the AI pipeline above and by the Image Library, which
 * copies a Drive photo here because Drive links are not public.
 */
export async function storeBytes(bytes: Buffer, contentType: string, ext: string, nameHint: string): Promise<string> {
  const img = { bytes, contentType, ext };
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

/**
 * Remove objects from the bucket. Best-effort, never throws.
 *
 * Every write above lands under a unique name, so nothing is ever replaced by
 * a later write — without this, every regenerated hero and every re-rendered
 * carousel stayed in the bucket for good. Callers pass the keys a pack stopped
 * referencing (lib/storage-prune.ts decides which those are); a failure here
 * costs storage, not a post, so it is reported and swallowed.
 *
 * Returns how many keys were asked to go, for the caller's log line.
 */
export async function removeStoredObjects(keys: string[]): Promise<number> {
  const list = keys.map((k) => String(k || '').trim()).filter(Boolean);
  if (!list.length) return 0;
  try {
    const { error } = await supabaseAdmin().storage.from(BUCKET).remove(list);
    if (error) reportError('images:remove', error, { count: list.length });
  } catch (e) {
    reportError('images:remove', e, { count: list.length });
  }
  return list.length;
}

/**
 * Remove whatever `prev` pointed at in the bucket that `next` no longer does.
 *
 * The step that turns "store the new image" into "replace the old one". Called
 * AFTER the new pack is written, so a failed write never orphans the picture
 * the draft still shows.
 */
export async function removeSuperseded(prev: unknown, next: unknown): Promise<number> {
  return removeStoredObjects(supersededKeys(prev, next, BUCKET));
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
  /** What the team asked for, passed through to buildImagePrompt. */
  direction?: string | null;
  /** Weekly-planner drafts only: which slot of the post's picture plan to make. */
  slot?: number | null;
  /** How long the caller can wait: no retry starts that cannot finish in it. */
  budgetMs?: number | null;
  /** Planner covers: the words to set instead of the planner's own ('' = no title). Null keeps the planner's. */
  title?: string | null;
  /** Planner covers: the title written for this draft (lib/cover-title.ts) — the planner's own words when absent. Never marks the title custom. */
  coverTitle?: string | null;
  /**
   * WHAT THIS PICTURE COSTS. `high` (the default) for a post that ships;
   * `medium` for a preview — gpt-image-1 bills roughly four times less for it,
   * and a week of previews is a week of pictures that may never be used.
   */
  quality?: ImageQuality;
  /** How many takes a flagged picture may have (default 3). A preview gets one: its reviewer is a person, not a gate. */
  maxAttempts?: number;
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
  direction?: string | null;
  /**
   * Which slot of the post's plan this take is for. "Show me 3 options" asks
   * for slots 1, 2 and 3 explicitly; without it the slot would be read off the
   * draft's running variant, which on a much-rerolled draft has long since
   * walked past the outcome and science slots.
   */
  slot?: number | null;
  budgetMs?: number | null;
  title?: string | null;
  coverTitle?: string | null;
  quality?: ImageQuality;
  maxAttempts?: number;
}): Promise<PackImage> {
  // Weekly-planner drafts rotate through their pillar's own scenes and are
  // checked for being on topic; every other draft is unchanged.
  const plannerBase = plannerImageFor(opts.pack);
  const direction = String(opts.direction || '').trim();
  // Read the post once: does its own body talk about biology? Only then may a
  // microscopy or lab frame be offered for it — and never on a lifestyle theme.
  // A title the team set (or turned off) outlives the take it was set on; the
  // notes they wrote travel with the brief so the checker judges against them.
  const planner = plannerBase
    ? {
        ...plannerBase,
        ...(opts.title != null ? { title: cleanCoverTitle(opts.title) } : opts.coverTitle ? { title: cleanCoverTitle(opts.coverTitle) } : {}),
        ...(direction ? { direction } : {}),
        science: scienceOffered(plannerBase.pillarId, briefSource(opts.pack, 6000) || opts.topic),
      }
    : null;
  const sceneCount = planner ? SHOT_COUNT : STYLE_VARIANTS.length;
  const baseVariant = Math.abs(Math.round(opts.variant ?? 0)) % sceneCount;
  const subject = planner ? planner.subject : opts.topic;
  const started = Date.now();
  // The caller's deadline, when it gave one. FIX's image step used to start a
  // second planner take with two minutes of its function left and be killed
  // mid-generation — nothing stored, nothing written, the card "working on
  // it" until it went stale. A retry now starts only when a whole attempt fits.
  const deadline = opts.budgetMs && opts.budgetMs > 0 ? started + opts.budgetMs : null;
  const attemptMs = planner ? PLANNER_ATTEMPT_MS : ATTEMPT_MS;
  const fits = (): boolean => deadline == null || deadline - Date.now() >= attemptMs;
  /** The Images call gets the usual allowance, or what is left of the deadline minus the check. */
  const callMs = (): number => {
    const usual = planner ? PLANNER_IMAGE_CALL_MS : IMAGE_CALL_MS;
    if (deadline == null) return usual;
    return Math.max(20_000, Math.min(usual, deadline - Date.now() - 30_000));
  };

  let best: { img: GeneratedImage; prompt: string; variant: number; verification: ImageVerification } | null = null;
  let lastError: unknown = null;
  const maxAttempts = Math.max(1, Math.min(MAX_GEN_ATTEMPTS, Math.round(opts.maxAttempts ?? MAX_GEN_ATTEMPTS)));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // The first attempt always runs; a retry only when it can finish in time.
    if (attempt > 0 && !fits()) break;
    const variant = (baseVariant + attempt) % sceneCount;
    // Planner drafts: brief the scene from THIS post's text (no brief when the
    // team typed a direction — theirs wins). Falls back to the pillar's scenes.
    // The post's own body decides whether a science picture may be offered at
    // all, and the family this take belongs to travels with the planner so the
    // vision checker asks the right question of it.
    const family = planner ? familyAt(planner, opts.slot ?? variant) : null;
    const objectLed = family === 'consult' || family === 'still';
    const brief = planner && objectLed && !direction ? await sceneBriefFor(planner, opts.pack, variant) : null;
    const plannerNow = planner ? { ...planner, ...(family ? { shotFamily: family } : {}), ...(brief ? { dynamic: brief } : {}) } : null;
    const prompt = buildImagePrompt({ ...opts, variant, planner: plannerNow });
    // A retry that fails must not destroy an already-paid-for candidate. This
    // call sat outside any try/catch, so an OpenAI 5xx or a timeout on the
    // SECOND attempt threw straight out of this function and discarded a
    // perfectly usable first image — exactly the "silent discard that burns
    // credits with nothing to show" the retry loop exists to avoid. Under
    // approveRun that surfaced as a post shipping with no image at all.
    let img: GeneratedImage;
    try {
      img = await generateImageBytes(prompt, planner?.size, callMs(), deadline, opts.quality ?? 'high');
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
    const verification = await verifyGeneratedImage(img, subject, normalizeVisual(opts.brand?.visual), plannerNow);
    const candidate = { img, prompt, variant, verification };
    // Keep the better candidate. Ranking encodes the content-image rule:
    // approved > unchecked > flagged-without-text > ANY candidate that can
    // never ship (text, or a banned prop in frame). An unshippable image can
    // never beat a shippable one, whatever its score.
    const rank = (v: ImageVerification) =>
      (imageUnshippable(v) ? 0 : v.status === 'approved' ? 600 : v.status === 'unchecked' ? 400 : 200) + (v.score ?? 0) + (v.brandFit ?? 0) / 200;
    if (!best || rank(verification) > rank(best.verification)) best = candidate;
    if (verification.status !== 'flagged') break; // clean (or uncheckable) — done
    // Flagged (text or other defects): retry with the next composition while
    // there is real time left in the serverless budget.
    if (Date.now() - started > (planner ? PLANNER_RETRY_BUDGET_MS : RETRY_TIME_BUDGET_MS)) break;
  }
  if (!best) {
    throw lastError instanceof Error
      ? lastError
      : new Error('image generation produced no candidate');
  }

  const nameHint = cleanTopic(opts.topic) || opts.topic;
  // The clean photograph is stored FIRST and kept as `titled.photoUrl`: it is
  // what a free retitle re-renders from (lib/cover-edit.ts retitleDecision).
  const photoUrl = await storeImage(best.img, nameHint);
  let url = photoUrl;
  let titled: PackImage['titled'];
  const custom = opts.title != null;
  // Planner drafts: set the title on the verified photograph. Best-effort — if
  // the renderer fails, the clean photograph ships on its own rather than
  // nothing, and the failure is reported.
  if (planner && planner.title) {
    try {
      const cover = await renderTitleCover({ title: planner.title, photo: { bytes: best.img.bytes, contentType: best.img.contentType }, headTopPct: best.verification.headTopPct });
      url = await storeBytes(cover.png, 'image/png', 'png', nameHint + '-cover');
      titled = { title: planner.title, photoUrl, family: cover.family, ...(custom ? { custom: true } : {}) };
    } catch (err) {
      reportError('images:title-cover', err, { title: planner.title });
    }
  } else if (planner) {
    // The team turned the title off: the clean photograph is the hero, and the
    // record says so, so nothing tries to give it a cover later.
    titled = { title: '', photoUrl, family: 'none', custom: true };
  }
  return {
    url,
    ...(titled ? { titled } : {}),
    prompt: best.prompt,
    alt: `${planner ? (titled?.title ? titled.title + ' — ' : '') + subject : opts.topic} — illustrative image for ${opts.brand?.name || 'Cellular Institute'}`,
    model: best.img.model,
    createdAt: new Date().toISOString(),
    variant: best.variant,
    verification: best.verification,
    ...(direction ? { direction } : {}),
  };
}

/**
 * EDIT the picture a draft already has, as the team's notes ask.
 *
 * "Notes for the picture" and the picture sat side by side and had nothing
 * to do with each other: the notes went into a text-to-image prompt and the
 * stored photograph was never shown to the model, so "warmer light, no
 * glasses on the table" came back as a different photograph of different
 * people. This fetches the clean photograph the draft keeps (the one a free
 * retitle re-renders from — a titled cover's `titled.photoUrl`, or a library
 * photo or upload itself), sends it up WITH the notes, and treats what comes
 * back exactly like a fresh take: verified by the same checker, stored, and
 * given the same title again when the picture had one.
 *
 * Throws when the picture cannot be edited (no clean photograph behind it —
 * lib/cover-edit.ts retitleDecision says why) or when every rung of the edit
 * failed; the route says so rather than quietly making a new picture, which
 * is the one thing the person did not ask for.
 */
export async function editPackImage(opts: {
  existing: PackImage;
  topic: string;
  pack?: Record<string, unknown> | null;
  brand?: BrandContext | null;
  direction?: string | null;
  budgetMs?: number | null;
  quality?: ImageQuality;
  /** How many takes a flagged edit may have (default 2): the second asks the same of the same photograph. */
  maxAttempts?: number;
}): Promise<PackImage> {
  if (!imagesEnabled()) throw new Error('image generation disabled (IMAGE_GEN=off or no OPENAI_API_KEY)');
  const decision = retitleDecision(opts.existing);
  if (!decision.ok) throw new Error(decision.reason);
  const sourceUrl = decision.photoUrl;
  const direction = String(opts.direction || '').trim();
  const plannerBase = plannerImageFor(opts.pack);
  const planner = plannerBase
    ? { ...plannerBase, ...(direction ? { direction } : {}), science: scienceOffered(plannerBase.pillarId, briefSource(opts.pack, 6000) || opts.topic) }
    : null;
  const subject = planner ? planner.subject : opts.topic;
  try {
    const photo = await fetchOwnPhoto(sourceUrl);
    const prompt = buildEditPrompt({ direction, topic: subject, brand: opts.brand, planner });
    const started = Date.now();
    const deadline = opts.budgetMs && opts.budgetMs > 0 ? started + opts.budgetMs : null;
    const fits = (): boolean => deadline == null || deadline - Date.now() >= ATTEMPT_MS;
    const callMs = (): number => (deadline == null ? IMAGE_CALL_MS : Math.max(20_000, Math.min(IMAGE_CALL_MS, deadline - Date.now() - 30_000)));
    const maxAttempts = Math.max(1, Math.min(MAX_GEN_ATTEMPTS, Math.round(opts.maxAttempts ?? 2)));
    let best: { img: GeneratedImage; verification: ImageVerification } | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0 && !fits()) break;
      let img: GeneratedImage;
      try {
        img = await editImageBytes(prompt, photo, callMs(), deadline, opts.quality ?? 'high');
      } catch (e) {
        if (best) break;
        throw e;
      }
      const verification = await verifyGeneratedImage(img, subject, normalizeVisual(opts.brand?.visual), planner);
      const rank = (v: ImageVerification) =>
        (imageUnshippable(v) ? 0 : v.status === 'approved' ? 600 : v.status === 'unchecked' ? 400 : 200) + (v.score ?? 0) + (v.brandFit ?? 0) / 200;
      if (!best || rank(verification) > rank(best.verification)) best = { img, verification };
      if (verification.status !== 'flagged') break;
      if (Date.now() - started > RETRY_TIME_BUDGET_MS) break;
    }
    if (!best) throw new Error('image edit produced no candidate');

    const nameHint = cleanTopic(opts.topic) || opts.topic;
    // The edited photograph is stored clean first, like a fresh take, so the
    // next free retitle — and the next edit — start from it.
    const photoUrl = await storeImage(best.img, nameHint + '-edit');
    let url = photoUrl;
    let titled: PackImage['titled'];
    const had = opts.existing.titled;
    if (had && had.title) {
      try {
        const cover = await renderTitleCover({ title: had.title, photo: { bytes: best.img.bytes, contentType: best.img.contentType }, headTopPct: best.verification.headTopPct });
        url = await storeBytes(cover.png, 'image/png', 'png', nameHint + '-cover');
        titled = { title: had.title, photoUrl, family: cover.family, ...(had.custom ? { custom: true } : {}) };
      } catch (err) {
        reportError('images:edit-title-cover', err, { title: had.title });
      }
    } else if (had) {
      titled = { title: '', photoUrl, family: 'none', custom: true };
    }
    const made: PackImage = {
      ...opts.existing,
      url,
      ...(titled ? { titled } : {}),
      prompt,
      model: best.img.model,
      createdAt: new Date().toISOString(),
      verification: best.verification,
      source: 'generated',
      editedFrom: sourceUrl,
      ...(direction ? { direction } : {}),
    };
    // What a library photo recorded about itself (its filter, its Drive file)
    // no longer describes this picture.
    delete made.brandGraded; delete made.filters; delete made.palette; delete made.padded; delete made.libraryFileId; delete made.libraryName; delete made.styledAfter;
    recordImageOutcome({ ok: true });
    return made;
  } catch (e) {
    recordImageOutcome({ ok: false, message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// Idempotent: give a draft an image if it doesn't have one yet. Uses the
// service-role client so Autopilot (no user session) can call it too.
// Returns the image (existing or new) or null when skipped/disabled.
// `ownerId` is REQUIRED, not optional. This runs on the service-role client,
// which bypasses RLS, and its only caller passes a draft id read off a
// template_runs row - a column a user can point at somebody else's draft.
// Without the owner check this function both reads and WRITES that draft.
// `force` is the FIX button's "↻ New image": the stored picture is replaced
// with the next composition variant even when it is clean — used only when the
// checker flagged it (lib/fix-plan.ts imageFlagged), never as a routine reroll.
// `budgetMs` is how long the caller can wait (generatePackImage): FIX passes
// what is left of its own budget so the step ends inside the function.
export async function ensureDraftImage(draftId: string, ownerId: string, opts: { force?: boolean; budgetMs?: number | null; quality?: ImageQuality; maxAttempts?: number } = {}): Promise<PackImage | null> {
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
  // And one showing a banned prop is treated the same way: it can never ship.
  const existingHasText = imageUnshippable(existing?.verification);
  // A planner draft still carrying a pre-cover picture gets the new cover once.
  const plannerNeedsCover = Boolean(plannerImageFor(pack)) && !existing?.titled &&
    !['library', 'upload'].includes(String(existing?.source || ''));
  if (existing?.url && !existingHasText && !plannerNeedsCover && !opts.force) return existing;

  // Brand voice makes the image on-brand too (best-effort).
  let brand: BrandContext | null = null;
  try {
    const { data: bp } = await db
      .from('brand_profiles')
      .select('*')
      .eq('user_id', row.user_id)
      .maybeSingle();
    if (bp) brand = bp as BrandContext;
  } catch (err) { /* optional */ reportError('images:draft-stamp', err); }

  const made = await generatePackImage({
    topic: String(row.topic || 'regenerative medicine'),
    pack,
    brand,
    variant: existingHasText || (opts.force && existing?.url) ? (existing?.variant ?? 0) + 1 : 0,
    budgetMs: opts.budgetMs ?? null,
    quality: opts.quality,
    maxAttempts: opts.maxAttempts,
    // The team's notes and their title (or "no title") outlive the take.
    direction: notesOf(existing) || null,
    title: existing?.titled?.custom ? existing.titled.title : null,
    // The words written for this draft, so an auto-made cover wears the same
    // title a library photo of it would.
    coverTitle: plannerImageFor(pack) && !existing?.titled?.custom ? (await resolveCoverTitle({ pack, topic: String(row.topic || '') })).title : null,
  });
  const image: PackImage = { ...made, takes: takesOf(existing) + 1 };
  // Same re-read as /api/drafts/image: the pack read before generation is
  // 30-60s stale, and a redraft in that window would otherwise be silently
  // reverted by this write. Merge `_image` into whatever is there NOW.
  const { data: fresh } = await db
    .from('drafts').select('pack').eq('id', draftId).eq('user_id', ownerId).maybeSingle();
  const currentPack = (fresh as { pack?: Record<string, unknown> } | null)?.pack ?? pack;
  const nextPack = { ...currentPack, _image: image };
  const { error } = await db
    .from('drafts').update({ pack: nextPack })
    .eq('id', draftId).eq('user_id', ownerId);
  if (error) throw new Error('draft image stamp failed: ' + error.message);
  // A text-flagged image was regenerated over: the old object is now
  // unreferenced, and without this it stayed in the bucket for good.
  await removeSuperseded(currentPack, nextPack);
  return image;
}
