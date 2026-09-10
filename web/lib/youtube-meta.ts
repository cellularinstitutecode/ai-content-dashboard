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
  const raw = String(title || '').trim() || firstLine;
  const clean = raw
    .replace(/[<>]/g, '')
    // A title is one line. A stray newline or run of spaces from the sheet
    // would otherwise be sent verbatim.
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  if (clean.length <= YOUTUBE_TITLE_MAX) return clean;
  // Cut on a word boundary where there is one close to the limit, so a title
  // does not end mid-word.
  const cut = clean.slice(0, YOUTUBE_TITLE_MAX);
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
  const f = String(format || '').toLowerCase();
  if (!f) return 'video';
  if (/\bshorts?\b|\breels?\b|vertical|9\s*[:x/]\s*16/.test(f)) return 'short';
  return 'video';
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
