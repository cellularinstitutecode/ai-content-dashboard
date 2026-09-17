// web/lib/youtube-meta.ts
// The extra things YouTube needs that no other network does.
//
// A YouTube draft reached Metricool and sat there refusing to save with:
//
//   ▶ Add at least 1 video.
//   ▶ Video or short title is required and must be shorter than 100
//     characters. The characters < or > are not allowed.
//   ▶ It is necessary to select the audience of the video.
//
// Every other network takes a body of text and a media file. YouTube also
// wants a TITLE (separate from the description), whether it is a long video or
// a Short, who the audience is, and how visible it should be. None of that was
// ever sent, so every YouTube draft was dead on arrival — the person had to
// fill four fields by hand before Approve would even light up.
//
// Pure, so the rules are unit-tested without a network (lib/youtube-meta.test.ts).

/** Metricool's `youtubeData` object. Field names come from its scheduler schema. */
import { cleanVideoTitle, looksLikeFilename } from './video-title.ts';
import { isVerticalFormat } from './video-format.ts';

export type YoutubeData = {
  title: string;
  type: 'video' | 'short';
  privacy: 'public' | 'unlisted' | 'private';
  madeForKids: boolean;
};

/** YouTube's own ceiling is 100; Metricool refuses at 100, so 99 is the last safe length. */
export const YOUTUBE_TITLE_MAX = 99;

/**
 * A title YouTube will accept.
 *
 * `<` and `>` are refused outright by YouTube (they break its own markup), so
 * they are removed rather than escaped — an escaped entity would show up
 * literally in the title. Falls back to the first line of the post when a row
 * has no title of its own, which is how most sheet rows arrive.
 */
export function youtubeTitleFrom(title: string | null | undefined, body?: string | null): string {
  const firstLine = String(body || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  // A FILENAME IS NOT A TITLE.
  //
  // The title handed in here is the Drive file's name, and the clinic's files
  // are named for whoever shot and edited them — so "Reel_RedLightRyall_Rodrigo"
  // was going onto YouTube verbatim as the video's public title, staff names,
  // "Reel_" prefix, extension and all. Cleaned into what the video is actually
  // about (lib/video-title.ts); a title somebody actually typed is left alone.
  const supplied = String(title || '').trim();
  const raw = (supplied && looksLikeFilename(supplied) ? cleanVideoTitle(supplied) : supplied) || firstLine;
  const clean = raw
    .replace(/[<>]/g, '')
    // A title is one line. A stray newline or run of spaces from the sheet
    // would otherwise be sent verbatim.
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  // The first sentence, when the line has more than one and the first is a
  // real sentence on its own. A caption's opening line often runs on ("Quality
  // in regenerative medicine isn't just about the cells, it's about how
  // they're made. At Cellular Institute…"): the title is the first sentence,
  // not the first ninety-nine characters cut mid-word.
  const sentence = firstSentence(clean);
  const candidate = sentence && sentence.length < clean.length && sentence.length >= 12 && sentence.length <= YOUTUBE_TITLE_MAX ? sentence : clean;
  if (candidate.length <= YOUTUBE_TITLE_MAX) return candidate;
  // Cut on a word boundary where there is one close to the limit, so a title
  // does not end mid-word.
  const cut = candidate.slice(0, YOUTUBE_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > YOUTUBE_TITLE_MAX - 20 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Long video or Short?
 *
 * Deliberately conservative: 'short' only when the sheet's FORMATO says so in
 * as many words. YouTube rejects a Short longer than three minutes, and the
 * sheet does not record duration — so an unrecognised format is uploaded as an
 * ordinary video, which YouTube is free to surface as a Short on its own if it
 * qualifies. Guessing the other way turns a rejection into the default.
 */
export function youtubeTypeFor(format: string | null | undefined): 'video' | 'short' {
  return isVerticalFormat(format) ? 'short' : 'video';
}

/**
 * The first sentence of a line: up to the first . ! ? or … that ends a word
 * (followed by a space or the end of the line), or up to a spaced em dash.
 * A trailing full stop is dropped — a title does not need one, and a line
 * that is one sentence should not read differently from one that is two.
 */
export function firstSentence(line: string): string {
  const m = /^(.+?[.!?\u2026])(?=\s|$)|^(.+?)\s+\u2014\s/.exec(String(line || ''));
  const s = (m ? (m[1] || m[2]) : '').trim();
  return s.replace(/\.$/, '').trim();
}

/**
 * How visible the video is once a person presses Approve.
 *
 * Public by default: these are marketing videos, and a draft that publishes to
 * nobody makes Approve a no-op the person then has to undo in YouTube Studio.
 * The sheet wins where it says otherwise — the YOUTUBE column sometimes holds
 * the word "Unlisted" rather than a link, and that is the clinic's own
 * instruction for that row.
 */
export function youtubePrivacyFor(sheetValue?: string | null, fallback?: string | null): YoutubeData['privacy'] {
  const v = String(sheetValue || '').trim().toLowerCase();
  if (/^unlisted$|^no listado|^oculto/.test(v)) return 'unlisted';
  if (/^private$|^privado/.test(v)) return 'private';
  const env = String(fallback || '').trim().toLowerCase();
  if (env === 'unlisted' || env === 'private' || env === 'public') return env;
  return 'public';
}

/**
 * Everything Metricool needs for a YouTube post, or null when there is no
 * usable title.
 *
 * Null rather than a placeholder: a video published under "Untitled" on a
 * clinic's channel is worse than a draft that says what is missing.
 */
export function youtubeDataFor(input: {
  title?: string | null;
  body?: string | null;
  format?: string | null;
  /** The sheet's YOUTUBE cell, when there is one. */
  sheetYoutube?: string | null;
  /** YOUTUBE_DEFAULT_PRIVACY, for a deployment that wants a different default. */
  defaultPrivacy?: string | null;
}): YoutubeData | null {
  const title = youtubeTitleFrom(input.title, input.body);
  if (!title) return null;
  return {
    title,
    type: youtubeTypeFor(input.format),
    privacy: youtubePrivacyFor(input.sheetYoutube, input.defaultPrivacy),
    // A regenerative-medicine clinic is not children's content, and YouTube
    // treats "made for kids" as a legal declaration — it is not a field to
    // leave to a guess or to a language model.
    madeForKids: false,
  };
}
