// web/lib/library-hero.ts
// A library photograph as a post's hero image: the brand's colour filter,
// and — for "Use library photo with brand filter" — the post's title on it.
// No image model is involved anywhere here.
//
// The decisions are pure and tested in lib/library-cover.ts; this file runs
// them: the photo is fetched from the app's own bucket (import_image put it
// there), measured with ffmpeg (lib/palette-measure.ts), graded with the
// filters lib/palette.ts already computes, checked by the same reviewer a
// generated cover gets (where the highest head starts), padded when the head
// would sit under the title, titled by lib/title-cover.ts, and stored.
//
// Fail-soft the way import_image is: without ffmpeg the photo goes in as it
// is and the result says so; without the checker the title takes its classic
// place. The only hard failures are a photo that cannot be fetched at all and
// a store that refuses the bytes.
import 'server-only';

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { BrandContext } from '@/lib/ai';
import { resolveFfmpeg } from '@/lib/audio-extract';
import { IMAGE_BUCKET, storeBytes, verifyLibraryPhoto, type ImageVerification, type PackImage } from '@/lib/images';
import { measureImage } from '@/lib/palette-measure';
import { plannerImageFor } from '@/lib/planner-image';
import { renderTitleCover } from '@/lib/title-cover';
import { reportError } from '@/lib/report';
import { coverTitleFor, ffmpegCoverArgs, gradeDecision, headroomPad, libraryProvenance, needsFfmpeg, ownBucketUrl, type GradeDecision } from './library-cover.ts';

const run = promisify(execFile);

/** A stored library photo is at most this big (import_image scales anything larger). */
const MAX_PHOTO_BYTES = 30 * 1024 * 1024;

export type LibraryHeroResult = {
  image: PackImage;
  /** What the person should know: the filter at its limit, ffmpeg missing, the head that could not be cleared. */
  notes: string[];
  decision: GradeDecision;
};

/** The stored photo's bytes, from the app's own public bucket. Also what a retitle (lib/retitle.ts) reads the clean photo with. */
export async function fetchPhoto(url: string): Promise<{ bytes: Buffer; contentType: string; ext: string }> {
  // Fetched on the server, so only from the app's own bucket: a request must
  // not be able to point this at any address it likes.
  if (!ownBucketUrl(url, process.env.NEXT_PUBLIC_SUPABASE_URL, IMAGE_BUCKET)) throw new Error('that photo is not one the dashboard stored');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'error' });
    if (!res.ok) throw new Error('photo fetch ' + res.status);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new Error('photo fetch: empty');
    if (bytes.length > MAX_PHOTO_BYTES) throw new Error('photo fetch: too large');
    const declared = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const png = bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50;
    const contentType = png ? 'image/png' : /^image\//.test(declared) ? declared : 'image/jpeg';
    return { bytes, contentType, ext: png ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg' };
  } finally {
    clearTimeout(timer);
  }
}

/** Run the filters (and the headroom pad) on the photo. Null when ffmpeg is missing or refuses it. */
async function gradePhoto(input: string, filters: readonly string[], pad: number): Promise<Buffer | null> {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg.ok) {
    reportError('library-hero:binary', new Error(ffmpeg.detail), { reason: ffmpeg.reason });
    return null;
  }
  const output = input + '.graded.jpg';
  try {
    await run(ffmpeg.path, ffmpegCoverArgs(input, output, { filters, pad }), { timeout: 120_000, maxBuffer: 1024 * 1024 });
    const out = await readFile(output);
    return out.length ? out : null;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    reportError('library-hero:ffmpeg', new Error(String(err?.stderr || err?.message || 'ffmpeg failed').slice(0, 200)));
    return null;
  }
}

/**
 * The hero image for a draft from one library photo.
 *
 * `title: true` sets the post's short title on the graded photo (the
 * "Use library photo with brand filter" button); false grades it and stops
 * (the "Choose from Image Library" button — a plain photo, in the palette).
 */
export async function libraryHero(opts: {
  url: string;
  title: boolean;
  pack: Record<string, unknown>;
  topic: string;
  brand?: BrandContext | null;
  libraryFileId?: string | null;
  libraryName?: string | null;
  /** The words to set (lib/cover-title.ts); without them, coverTitleFor's static answer. */
  titleWords?: string | null;
}): Promise<LibraryHeroResult> {
  const notes: string[] = [];
  const photo = await fetchPhoto(opts.url);
  const dir = await mkdtemp(path.join(tmpdir(), 'chi-library-'));
  try {
    const input = path.join(dir, 'in.' + photo.ext);
    await writeFile(input, photo.bytes);

    // 1. Measure, decide the grade.
    const decision = gradeDecision(await measureImage(input));
    if (decision.note) notes.push(decision.note);

    // 2. The reviewer, on the photo as it is: where does the highest head
    //    start? (And, for a planner post, is this the subject?) Only a titled
    //    cover needs to know; a plain photo is theirs as chosen.
    const planner = plannerImageFor(opts.pack);
    const subject = planner ? planner.subject : opts.topic;
    let verification: ImageVerification | undefined;
    let pad = 0;
    if (opts.title) {
      verification = await verifyLibraryPhoto({ bytes: photo.bytes, contentType: photo.contentType }, { subject, brand: opts.brand, planner });
      pad = headroomPad(verification.headTopPct);
    }

    // 3. ffmpeg: the filter, and the sky the title needs.
    let graded: Buffer | null = null;
    let contentType = photo.contentType;
    let ext = photo.ext;
    if (needsFfmpeg(decision, pad)) {
      graded = await gradePhoto(input, decision.filters, pad);
      if (!graded) notes.push('the brand filter could not be applied here (the image tool did not run), so the photo was used as it is');
      else { contentType = 'image/jpeg'; ext = 'jpg'; }
    }
    const applied = graded != null;
    const bytes = graded ?? photo.bytes;

    // 4. Padded for the title: check the padded photo, so the stored verdict
    //    is of the picture that ships and the head check passes on it.
    if (opts.title && pad > 0 && applied) {
      verification = await verifyLibraryPhoto({ bytes, contentType }, { subject, brand: opts.brand, planner });
    }
    if (verification?.status === 'flagged') notes.push('the checker flagged this photo: ' + verification.issues.slice(0, 2).join('; '));

    // 5. Store the photo, then the titled cover over it.
    const nameHint = (opts.libraryName || subject || 'library').replace(/\.[a-z0-9]+$/i, '');
    const photoUrl = await storeBytes(bytes, contentType, ext, nameHint);
    let url = photoUrl;
    let titled: PackImage['titled'];
    const title = opts.title ? (opts.titleWords != null ? opts.titleWords : coverTitleFor(opts.pack, opts.topic)) : '';
    // Words the team set on the previous picture stay theirs on this one.
    const custom = (opts.pack as { _image?: { titled?: { custom?: unknown } } })._image?.titled?.custom === true;
    if (opts.title && !title) {
      // The team turned the title off on this draft (lib/cover-edit.ts): the
      // graded photo is the hero, and the record keeps saying so.
      titled = { title: '', photoUrl, family: 'none', custom: true };
    } else if (title) {
      try {
        const cover = await renderTitleCover({ title, photo: { bytes, contentType }, headTopPct: verification?.headTopPct ?? null });
        url = await storeBytes(cover.png, 'image/png', 'png', nameHint + '-cover');
        titled = { title, photoUrl, family: cover.family, ...(custom ? { custom: true } : {}) };
      } catch (err) {
        reportError('library-hero:title-cover', err, { title });
        notes.push('the title could not be set on the photo, so it was used without one');
      }
    }

    const provenance = libraryProvenance({ decision, applied, pad, libraryFileId: opts.libraryFileId, libraryName: opts.libraryName });
    const image: PackImage = {
      url,
      ...(titled ? { titled } : {}),
      prompt: '',
      alt: (titled ? title + ' — ' : '') + (opts.libraryName || 'Photograph chosen by the clinic'),
      model: 'library',
      createdAt: new Date().toISOString(),
      variant: 0,
      ...(verification ? { verification } : {}),
      ...provenance,
    };
    return { image, notes, decision };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
