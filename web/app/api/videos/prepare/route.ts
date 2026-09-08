// POST /api/videos/prepare
// body: { url, transcript?, title? }
//
// A YouTube link becomes publish-ready copy in one call: the video's own
// captions (or a pasted transcript) → the Semrush keyword brief for what the
// video is about → Claude writes a LinkedIn post and a TikTok caption from
// what was actually said, with the REF citation and the AVISO line → saved as
// a draft (kind: 'video') so it shows in Recent Drafts and can be edited. The
// route never posts anything; sending to Metricool is a separate, explicit
// step from the Video Library, and Approve is still a person.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { generateContentPack, type BrandContext, type ContentPack } from '@/lib/ai';
import { parseVideoUrl } from '@/lib/composer';
import { fetchYouTubeTranscript } from '@/lib/youtube-transcript';
import { checkRateLimit } from '@/lib/rate-limit';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

const MAX_TRANSCRIPT = 12000; // characters handed to the writer

export type VideoPack = ContentPack & {
  kind: 'video';
  title: string;
  sourceUrl: string;
  videoId: string;
  transcript: string;
  transcriptSource: 'youtube' | 'pasted';
  transcriptLanguage: string | null;
  linkedin: string;
  tiktok: string;
};

export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const rl = await checkRateLimit(auth.userId, 'generate');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited', limit: rl.limit }, { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } });

  let body: any = null;
  try { body = await req.json(); } catch { body = null; }
  const url = String(body?.url || '').trim();
  const pasted = typeof body?.transcript === 'string' ? body.transcript.trim() : '';
  const parsed = parseVideoUrl(url);
  if (!parsed.ok || parsed.source !== 'YouTube') {
    return NextResponse.json({ error: 'invalid_url', message: parsed.ok ? 'Only YouTube links can be prepared here.' : parsed.reason }, { status: 400 });
  }

  // 1) Transcript
  let transcript = pasted;
  let transcriptSource: 'youtube' | 'pasted' = 'pasted';
  let language: string | null = null;
  let title = String(body?.title || '').trim();
  if (!transcript) {
    const t = await fetchYouTubeTranscript(parsed.id);
    if (!t.ok) {
      return NextResponse.json({ error: 'no_transcript', reason: t.reason, message: t.message, title: t.title }, { status: 422 });
    }
    transcript = t.text;
    transcriptSource = 'youtube';
    language = t.language;
    if (!title && t.title) title = t.title;
  }
  transcript = transcript.replace(/\s+/g, ' ').trim();
  if (transcript.length < 40) {
    return NextResponse.json({ error: 'transcript_too_short', message: 'That transcript is too short to write from.' }, { status: 422 });
  }
  const excerpt = transcript.slice(0, MAX_TRANSCRIPT);
  if (!title) title = excerpt.split(/[.!?]/)[0].slice(0, 90);

  // 2) Brand voice (same profile every generator uses)
  let brand: BrandContext | undefined;
  try {
    const sb = await supabaseServer();
    const { data: bp } = await sb.from('brand_profiles').select('name, mission, voice, audience, keywords, guidelines, aviso_publicidad').eq('user_id', auth.userId).maybeSingle();
    if (bp) brand = bp as BrandContext;
  } catch { /* default voice */ }

  // 3) Keywords + copy. The keyword brief is run on the video's subject; the
  //    writer gets the transcript and is told to stay inside it.
  const topic =
    'Write social copy for this published video titled "' + title + '". Base every claim ONLY on what is said in the transcript below — do not add ' +
    'treatments, results or numbers that are not in it. Speak as the clinic sharing its own video.\n\nTRANSCRIPT:\n' + excerpt;
  let pack: ContentPack;
  let semrush: unknown = null;
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
    return NextResponse.json({ error: 'generation_failed', message: 'The writer did not answer just now. Try again in a moment.' }, { status: 502 });
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
    videoId: parsed.id,
    transcript: excerpt,
    transcriptSource,
    transcriptLanguage: language,
    linkedin,
    tiktok,
  };

  // 4) Save as a draft so it is in the library and editable.
  let draftId: string | null = null;
  try {
    const { data } = await supabaseAdmin()
      .from('drafts')
      .insert({ user_id: auth.userId, topic: 'Video · ' + title, channels: ['linkedin', 'tiktok'], pack: videoPack, provider: 'anthropic' })
      .select('id')
      .single();
    draftId = (data as { id?: string } | null)?.id || null;
  } catch (e) {
    reportError('videos:prepare-save', e);
  }

  return NextResponse.json({
    ok: true,
    draftId,
    title,
    videoId: parsed.id,
    transcript: { source: transcriptSource, language, chars: transcript.length, preview: transcript.slice(0, 600) },
    keywords: semrush,
    compliance: (pack as ContentPack & { _compliance?: unknown })._compliance ?? null,
    linkedin,
    tiktok,
  });
}
