// web/lib/library-cover.ts
// "Use library photo with brand filter": the decisions behind turning one of
// the clinic's own photographs into a post's hero image — no image model.
//
//   grade      what lib/palette.ts says the photo needs to sit in the brand's
//              palette; a photo past the limits still gets the filter, at its
//              limit, and the card is told.
//   headroom   the title sits in the top band (lib/title-cover-layout.ts), so
//              when the vision check finds a head up there the photo is given
//              more sky: a blurred mirror of its own top edge, padded above it,
//              until the head clears the band. Never a crop — nothing of the
//              photo is lost.
//   title      the post's short title, as planner covers already choose it.
//   verdict    the same checks as a generated picture, read for a photograph
//              somebody chose: signage or a prop in a REAL clinic photo is a
//              note, not a defect; a head in the title band and (for a weekly
//              planner post) the wrong subject still flag it.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
// lib/library-hero.ts runs ffmpeg and the renderer on what is decided here.
import { BRAND_TARGET, GRADE_LIMITS, gradeFor, type Grade, type PaletteStats } from './palette.ts';
import { cleanTopic, plannerImageFor } from './planner-image.ts';
import type { ImageVerdict } from './image-verdict.ts';

/** A head starting above this (percent of the photo's height) reaches into the title band. Same number the planner covers use. */
export const COVER_MIN_HEAD_TOP_PCT = 30;
/** Where the highest head lands after padding — below the limit with room, and clear of the reviewer's "top third". */
export const COVER_HEAD_CLEAR_PCT = 36;
/** More than this much added sky and the picture is mostly filler; the flag stands instead. */
export const MAX_PAD_FRACTION = 0.45;
/** Longer than this is a sentence, not a cover title. */
export const MAX_COVER_TITLE_CHARS = 60;

export type GradeDecision = {
  /** 'unmeasured' when ffmpeg could not read the photo: it is used as it is. */
  verdict: Grade['verdict'] | 'unmeasured';
  filters: string[];
  distance: number | null;
  /** One line for the response when the filter was applied at its limit, or not at all. */
  note: string | null;
};

/** The stats, moved to the nearest point a grade may honestly reach. */
export function cappedStats(s: PaletteStats, target: PaletteStats = BRAND_TARGET): PaletteStats {
  const clampTo = (v: number, t: number, limit: number) => t - Math.max(-limit, Math.min(limit, t - v));
  const r = clampTo(s.warm, target.warm, GRADE_LIMITS.warm);
  return {
    ...s,
    warm: r,
    sat: clampTo(s.sat, target.sat, GRADE_LIMITS.sat),
    lum: clampTo(s.lum, target.lum, GRADE_LIMITS.lum),
  };
}

/**
 * What to run on one photograph. 'ready' skips the grade; 'grade' runs the
 * filters as measured; 'outside' runs them at the limits and says so.
 */
export function gradeDecision(stats: PaletteStats | null | undefined): GradeDecision {
  if (!stats) return { verdict: 'unmeasured', filters: [], distance: null, note: 'the photo could not be measured, so it was used without the brand filter' };
  const g = gradeFor(stats);
  if (g.verdict !== 'outside') return { verdict: g.verdict, filters: g.filters, distance: g.distance, note: null };
  const capped = gradeFor(cappedStats(stats));
  return {
    verdict: 'outside',
    filters: capped.filters,
    distance: g.distance,
    note: 'this photo is outside the brand palette (' + g.reason + '); the filter was applied at its limit, so it may still look different from the feed',
  };
}

/**
 * How much to add above the photo, as a fraction of its height, so the
 * highest head starts at COVER_HEAD_CLEAR_PCT. 0 when it already clears the
 * band, was not measured, or would need more than MAX_PAD_FRACTION.
 */
export function headroomPad(headTopPct: number | null | undefined, min = COVER_MIN_HEAD_TOP_PCT, clear = COVER_HEAD_CLEAR_PCT): number {
  if (typeof headTopPct !== 'number' || !Number.isFinite(headTopPct)) return 0;
  if (headTopPct >= min) return 0;
  const h = Math.max(0, headTopPct) / 100;
  const c = clear / 100;
  // (h + p) / (1 + p) = c  →  p = (c - h) / (1 - c)
  const pad = Math.round(((c - h) / (1 - c)) * 1000) / 1000;
  return pad > MAX_PAD_FRACTION ? 0 : pad;
}

/** Where the head starts once `pad` of the height was added on top. */
export function headTopAfterPad(headTopPct: number, pad: number): number {
  return Math.round(((headTopPct / 100 + pad) / (1 + pad)) * 1000) / 10;
}

/**
 * The words set on the cover, without a model: a title the team set on the
 * current picture, else the one written for this draft and kept on the pack
 * (lib/cover-title.ts), else the words already painted on the current
 * picture, else the planner's own, else the post's topic, short.
 */
export function coverTitleFor(pack: unknown, topic: unknown): string {
  const titled = (pack && typeof pack === 'object' ? (pack as { _image?: { titled?: { title?: unknown; custom?: unknown } } })._image?.titled : null) || null;
  // A title somebody typed in the Edit image panel outlives the picture it was
  // typed on — including "no title", which is '' here and honoured.
  if (titled && titled.custom === true) return String(titled.title ?? '').trim();
  const kept = pack && typeof pack === 'object' ? String((pack as { _coverTitle?: unknown })._coverTitle ?? '').replace(/\s+/g, ' ').trim() : '';
  if (kept) return kept;
  const painted = titled ? String(titled.title ?? '').replace(/\s+/g, ' ').trim() : '';
  if (painted) return painted;
  const planner = plannerImageFor(pack);
  if (planner?.title) return planner.title;
  const t = cleanTopic(topic).replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_COVER_TITLE_CHARS) return t;
  return t.slice(0, MAX_COVER_TITLE_CHARS).replace(/\s+\S*$/, '').replace(/[,;:\-–—]\s*$/, '');
}

/** The strip of the photo's top edge that is mirrored and blurred into the added sky. */
const PAD_STRIP_FRACTION = 0.12;

/**
 * One ffmpeg run: pad (when needed), grade, fit inside 2048px, write a JPEG.
 * The grade comes after the pad so the sky is graded with the photo.
 */
export function ffmpegCoverArgs(input: string, output: string, opts: { filters: readonly string[]; pad: number }): string[] {
  const fit = "scale=w='min(iw,2048)':h='min(ih,2048)':force_original_aspect_ratio=decrease:flags=lanczos";
  const chain = [...opts.filters, fit, 'format=yuvj420p'].join(',');
  const graph = opts.pad > 0
    ? '[0:v]split=2[base][strip];' +
      `[strip]crop=iw:max(2\\,ih*${PAD_STRIP_FRACTION}):0:0,vflip,scale=iw:ih*${(opts.pad / PAD_STRIP_FRACTION).toFixed(3)}:flags=lanczos,gblur=sigma=40[top];` +
      '[top][base]vstack=inputs=2,' + chain
    : '[0:v]' + chain;
  return ['-nostdin', '-loglevel', 'error', '-y', '-i', input, '-frames:v', '1', '-filter_complex', graph, '-c:v', 'mjpeg', '-q:v', '3', output];
}

/** Does this photo need ffmpeg at all? */
export function needsFfmpeg(decision: Pick<GradeDecision, 'filters'>, pad: number): boolean {
  return decision.filters.length > 0 || pad > 0;
}

/** The blocking findings that still apply to a photograph a person chose. */
const PHOTO_DEFECT_RE = /head reaches into the title area|off-topic/i;

/**
 * The reviewer's verdict, read for a real photograph. Text, props and
 * "anatomy" are what an image MODEL gets wrong; on a clinic photo they are
 * notes for the reviewer. A head in the title band, and the wrong subject on
 * a planner post, remain defects — FIX makes an AI image in their place.
 */
export function photographVerdict(v: ImageVerdict): ImageVerdict {
  const blocking = v.issues.filter((i) => PHOTO_DEFECT_RE.test(i));
  const noted = v.issues.filter((i) => !PHOTO_DEFECT_RE.test(i));
  return {
    ...v,
    status: blocking.length ? 'flagged' : 'approved',
    issues: blocking,
    advisory: [...noted, ...v.advisory].slice(0, 8),
    textDetected: false,
    bannedProp: false,
  };
}

/** What a brand-graded library photo records about where it came from. */
export type LibraryProvenance = {
  source: 'library';
  brandGraded: boolean;
  filters: string[];
  /** The palette verdict the grade was decided on. */
  palette: GradeDecision['verdict'];
  /** Sky added on top for the title, as a fraction of the height; absent when none. */
  padded?: number;
  libraryFileId?: string;
  libraryName?: string;
};

export function libraryProvenance(input: {
  decision: Pick<GradeDecision, 'verdict' | 'filters'>;
  /** False when ffmpeg was unavailable and the photo went in as it was. */
  applied: boolean;
  pad?: number;
  libraryFileId?: string | null;
  libraryName?: string | null;
}): LibraryProvenance {
  const applied = input.applied && input.decision.filters.length > 0;
  return {
    source: 'library',
    brandGraded: applied || input.decision.verdict === 'ready',
    filters: applied ? [...input.decision.filters] : [],
    palette: input.decision.verdict,
    ...(input.pad && input.applied ? { padded: input.pad } : {}),
    ...(input.libraryFileId ? { libraryFileId: String(input.libraryFileId) } : {}),
    ...(input.libraryName ? { libraryName: String(input.libraryName).slice(0, 200) } : {}),
  };
}

/**
 * Is `url` a file in the app's own public image bucket?
 *
 * libraryHero fetches the photo on the server, so the address the browser
 * sends must be one the dashboard stored (import_image put it there), not any
 * https address a request names: same origin as the Supabase project, under
 * /storage/v1/object/public/<bucket>/, and no userinfo or odd port tricks.
 */
export function ownBucketUrl(url: string, supabaseUrl: string | null | undefined, bucket: string): boolean {
  let u: URL;
  let base: URL;
  try { u = new URL(String(url || '')); base = new URL(String(supabaseUrl || '')); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (u.origin !== base.origin) return false;
  const prefix = '/storage/v1/object/public/' + bucket + '/';
  return u.pathname.startsWith(prefix) && u.pathname.length > prefix.length && !u.pathname.includes('/../');
}
