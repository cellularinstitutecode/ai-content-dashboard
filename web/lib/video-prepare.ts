// web/lib/video-prepare.ts
// One produced video → publish-ready copy, keywords and a citation.
//
// This is the whole manual routine, in one function: get the words that were
// actually said (lib/video-transcript.ts), run the keyword brief on what the
// video is about, have the writer produce a LinkedIn post and a TikTok caption
// that stay inside the transcript, and let the compliance pass stamp the
// AVISO line and verify the REF citation's DOI.
//
// It lives here rather than in the route because two callers need it: the
// "Prepare" button in the Video Library, and the sweep that runs when a new
// link appears in the sheet (lib/video-autopilot.ts). A copy of this logic in
// each is a copy that drifts, and the half that drifts is the compliance half.
//
// It never publishes and never ticks a network column. Approve is still a person.
import 'server-only';

import { autoKeywordBrief, generateContentPack, type BrandContext, type ContentPack, type SemrushStamp } from '@/lib/ai';
import { avisoNumberFor, checkCompliance } from '@/lib/compliance';
import { resolveTranscript, type TranscriptOrigin } from '@/lib/video-transcript';
import { keywordLineFrom } from '@/lib/video-row';
import { composeCaption, topicFromTranscript, videoSubject } from '@/lib/video-copy';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

const MAX_TRANSCRIPT = 12000; // characters handed to the writer

export type VideoPack = ContentPack & {
  kind: 'video';
  title: string;
  sourceUrl: string;
  videoId: string;
  transcript: string;
  transcriptSource: TranscriptOrigin;
  transcriptLanguage: string | null;
  linkedin: string;
  tiktok: string;
};

export type PrepareOk = {
  ok: true;
  draftId: string | null;
  title: string;
  videoId: string;
  transcript: { source: TranscriptOrigin; language: string | null; chars: number; preview: string; full: string };
  keywords: SemrushStamp | null;
  /** The keyword brief flattened for a spreadsheet cell: "primary · a, b, c". */
  keywordLine: string;
  /**
   * Did real keyword data reach the writer?
   *
   * False whenever Semrush was unset, errored, or below its unit floor — in
   * which case the copy is ordinary good copy that no keyword brief shaped,
   * and the row must not look the same as one that got the full treatment.
   */
  hasKeywords: boolean;
  /** The REF citation the writer produced, without the label, or ''. */
  ref: string;
  compliance: unknown;
  linkedin: string;
  tiktok: string;
  pack: VideoPack;
};

export type PrepareFail = {
  ok: false;
  status: number;
  error: string;
  message: string;
  needsPaste: boolean;
  title: string | null;
};

export type PrepareInput = {
  userId: string;
  /** The link on the row — a Drive file or a YouTube URL. */
  url: string;
  /** The sheet's YOUTUBE column, when it holds a published URL. */
  youtubeUrl?: string | null;
  pasted?: string | null;
  /** A title from the sheet, preferred over anything guessed from the words. */
  title?: string | null;
  /** Save a draft row. The sweep does; a dry run does not. */
  saveDraft?: boolean;
};

/** Did Semrush actually answer, or is this the fallback? The retry above and
 *  the red badge on the Prepare screen must agree on what "no keyword data"
 *  means, so they ask the same question. */
function hasSemrushData(stamp: SemrushStamp | null | undefined): boolean {
  return stamp?.source === 'semrush' && Boolean(stamp.primary);
}

export async function prepareVideo(input: PrepareInput): Promise<PrepareOk | PrepareFail> {
  const url = String(input.url || '').trim();

  // 1) The words.
  const t = await resolveTranscript({ url, youtubeUrl: input.youtubeUrl, pasted: input.pasted });
  if (!t.ok) {
    return {
      ok: false,
      // 422: the request was well-formed, we just cannot get a transcript from
      // it. The Video Library distinguishes this from a 400 to offer the paste box.
      status: 422,
      error: t.reason === 'no_source' ? 'invalid_url' : 'no_transcript',
      message: t.message,
      needsPaste: t.needsPaste,
      title: t.title,
    };
  }

  const transcript = t.text;
  const excerpt = transcript.slice(0, MAX_TRANSCRIPT);
  let title = String(input.title || '').trim() || String(t.title || '').trim();
  if (!title) title = excerpt.split(/[.!?]/)[0].slice(0, 90);

  // 2) Brand voice — the same profile every generator in the app uses.
  let brand: BrandContext | undefined;
  try {
    const { data: bp } = await supabaseAdmin()
      .from('brand_profiles')
      .select('name, mission, voice, audience, keywords, guidelines, aviso_publicidad')
      .eq('user_id', input.userId)
      .maybeSingle();
    if (bp) brand = bp as BrandContext;
  } catch { /* default voice */ }

  // 3) Keywords + copy. The writer is held to the transcript; the keyword
  //    brief runs on what the video is about.
  const topic =
    'Write social copy for this published video titled "' + title + '". Base every claim ONLY on what is said in the transcript below — do not add ' +
    'treatments, results or numbers that are not in it. Speak as the clinic sharing its own video.\n\nTRANSCRIPT:\n' + excerpt;

  // Research the SUBJECT, not the prompt.
  //
  // generateContentPack researches whatever `topic` it is given, and the topic
  // above is an instruction wrapped around a twelve-thousand-character
  // transcript. Semrush takes that as a literal search phrase, matched
  // nothing, and every single video came back "no keyword data" while the
  // account sat on 48,000 unspent units — the keyword research this pipeline
  // exists for had never once run. The brief is built here from two or three
  // words naming the video, and handed over so the auto-lookup does not fire.
  const subject = videoSubject(title, excerpt);
  let brief = await autoKeywordBrief(subject);

  // The filename is not always about anything. "Reel_RyallCellgenicScript16"
  // reduces to a partner's name and a script number, Semrush has no such
  // phrase, and the copy is written blind — which is exactly what the red "NO
  // keyword data" badge was reporting.
  //
  // What the video is about is in the video. Ask again with the phrase the
  // speaker actually repeats, but only when the first attempt found nothing:
  // a filename that names its subject is still the better seed, and this costs
  // a second lookup only on the videos that would otherwise get none.
  if (!hasSemrushData(brief.stamp) && excerpt) {
    const spoken = topicFromTranscript(excerpt);
    if (spoken && spoken.toLowerCase() !== subject.toLowerCase()) {
      const retry = await autoKeywordBrief(spoken);
      if (hasSemrushData(retry.stamp)) brief = retry;
    }
  }

  let pack: ContentPack;
  let semrush: SemrushStamp | null = brief.stamp;
  try {
    const out = await generateContentPack({
      topic,
      keywordHint: brief.hint ?? '',
      contentType: 'social',
      channels: ['linkedin', 'instagram'],
      brand,
      audience: brand?.audience,
      tone: 'clear, warm, credible',
    });
    pack = out.pack;
  } catch (e) {
    reportError('videos:prepare-generate', e);
    return { ok: false, status: 502, error: 'generation_failed', message: 'The writer did not answer just now. Try again in a moment.', needsPaste: false, title };
  }

  // The Instagram-style caption (short, hashtags, REF + AVISO) is the TikTok
  // caption; LinkedIn gets the longer, insight-led post plus the video link.
  const aviso = avisoNumberFor(brand?.aviso_publicidad);

  // Assembled, not trusted where the writer left it. In production the model
  // produced "AVISO DE PUBLICIDAD COFEPRIS 2425N2SSA01827" — no colon, an
  // extra word, and a permit number it had invented — which the matcher in
  // lib/compliance.ts did not recognise, so the real notice was appended
  // underneath and the post went out carrying two permit numbers, one
  // fictional, on a medical advertisement. composeCaption strips every notice
  // and writes exactly one, and puts the hashtags last as the clinic's own
  // captions always have.
  const tiktok = composeCaption(String(pack.instagram || ''), aviso);

  // The citation the compliance pass verified, taken from whichever variant
  // the writer put it on.
  const ref = checkCompliance(tiktok).ref || checkCompliance(String(pack.facebook || '')).ref || '';

  // LinkedIn carries the notice and the citation too.
  //
  // lib/compliance.ts scopes the advertising rule to Instagram and Facebook,
  // so the writer is only ever asked for a REF line on those two and the AVISO
  // is only stamped there — which left the LinkedIn post going out with
  // neither. The same post, the same claims, the same clinic: it gets the same
  // two lines, reusing the citation already verified against Crossref rather
  // than asking for a second one that would need verifying again.
  let linkedin = String(pack.linkedin || '').trim() + '\n\nWatch: ' + url;
  if (ref && !checkCompliance(linkedin).ref) linkedin += '\n\nREF: ' + ref;
  linkedin = composeCaption(linkedin, aviso);
  const videoPack: VideoPack = {
    ...pack,
    kind: 'video',
    title,
    sourceUrl: url,
    videoId: t.videoId || '',
    transcript: excerpt,
    transcriptSource: t.origin,
    transcriptLanguage: t.language,
    linkedin,
    tiktok,
  };

  // 4) Save as a draft so it is in the library and editable.
  let draftId: string | null = null;
  if (input.saveDraft !== false) {
    // The `error` half matters: supabase-js RESOLVES a failed insert rather
    // than throwing, so a try/catch alone catches nothing and a draft that
    // never saved leaves no trace anywhere — the row is written, Metricool
    // gets the post, and only the library is quietly missing it.
    const saved = await supabaseAdmin()
      .from('drafts')
      .insert({ user_id: input.userId, topic: 'Video · ' + title, channels: ['linkedin', 'tiktok'], pack: videoPack, provider: 'anthropic' })
      .select('id')
      .single()
      .then((r) => r, (e: unknown) => ({ data: null, error: e as { message?: string } }));
    if (saved.error) reportError('videos:prepare-save', saved.error, { userId: input.userId });
    draftId = (saved.data as { id?: string } | null)?.id || null;
  }

  return {
    ok: true,
    draftId,
    title,
    videoId: t.videoId || '',
    transcript: { source: t.origin, language: t.language, chars: transcript.length, preview: transcript.slice(0, 600), full: transcript },
    keywords: semrush,
    keywordLine: keywordLineFrom(semrush),
    hasKeywords: hasSemrushData(semrush),
    ref,
    compliance: (pack as ContentPack & { _compliance?: unknown })._compliance ?? null,
    linkedin,
    tiktok,
    pack: videoPack,
  };
}
