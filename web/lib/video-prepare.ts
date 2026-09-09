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

import { generateContentPack, type BrandContext, type ContentPack, type SemrushStamp } from '@/lib/ai';
import { checkCompliance } from '@/lib/compliance';
import { resolveTranscript, type TranscriptOrigin } from '@/lib/video-transcript';
import { keywordLineFrom } from '@/lib/video-row';
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
  let pack: ContentPack;
  let semrush: SemrushStamp | null = null;
  try {
    const out = await generateContentPack({
      topic,
      contentType: 'social',
      channels: ['linkedin', 'instagram'],
      brand,
      audience: brand?.audience,
      tone: 'clear, warm, credible',
    });
    pack = out.pack;
    semrush = out.semrush;
  } catch (e) {
    reportError('videos:prepare-generate', e);
    return { ok: false, status: 502, error: 'generation_failed', message: 'The writer did not answer just now. Try again in a moment.', needsPaste: false, title };
  }

  // The Instagram-style caption (short, hashtags, REF + AVISO) is the TikTok
  // caption; LinkedIn gets the longer, insight-led post plus the video link.
  const linkedin = String(pack.linkedin || '').trim() + '\n\nWatch: ' + url;
  const tiktok = String(pack.instagram || '').trim();
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
    try {
      const { data } = await supabaseAdmin()
        .from('drafts')
        .insert({ user_id: input.userId, topic: 'Video · ' + title, channels: ['linkedin', 'tiktok'], pack: videoPack, provider: 'anthropic' })
        .select('id')
        .single();
      draftId = (data as { id?: string } | null)?.id || null;
    } catch (e) {
      reportError('videos:prepare-save', e);
    }
  }

  // The citation the compliance pass verified, pulled back out so it can go in
  // the sheet's own REF column beside the copy.
  const ref = checkCompliance(tiktok).ref || checkCompliance(String(pack.facebook || '')).ref || '';

  return {
    ok: true,
    draftId,
    title,
    videoId: t.videoId || '',
    transcript: { source: t.origin, language: t.language, chars: transcript.length, preview: transcript.slice(0, 600), full: transcript },
    keywords: semrush,
    keywordLine: keywordLineFrom(semrush),
    ref,
    compliance: (pack as ContentPack & { _compliance?: unknown })._compliance ?? null,
    linkedin,
    tiktok,
    pack: videoPack,
  };
}
