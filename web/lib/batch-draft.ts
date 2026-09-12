// web/lib/batch-draft.ts
// One topic, taken all the way to a Metricool draft awaiting approval.
//
// The clinic's ask was "it can draft all of the posts, it can send them all the
// way to the finish line for us to approve at the end". This is the finish line:
// research, write in the clinic's voice, prove the copy carries the advertising
// notice and a citation, save it to the drafts feed, and hand Metricool a DRAFT.
//
// What it is NOT, and cannot become by changing an argument: a publish. There is
// no autoPublish parameter here. `autoPublish: false, draft: true` are constants
// in the body below, for the same reason they are constants in
// app/api/metricool/schedule/route.ts — whether a medical clinic's post goes
// live is a property of this code, not of a request somebody can craft.
import 'server-only';

import { generateContentPack, type BrandContext, type ContentType } from '@/lib/ai';
import { complianceGate } from '@/lib/compliance-gate';
import { ensureAviso } from '@/lib/compliance';
import { apiBase as metricoolApiBase, normalizeMedia } from '@/lib/metricool';
import { youtubeDataFor } from '@/lib/youtube-meta';
import { normalizePublishAt, METRICOOL_TIMEZONE } from '@/lib/metricool-time';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { DEFAULT_BLOG_ID, ALLOWED_BLOG_IDS } from '@/lib/access';
import { reportError, redact } from '@/lib/report';

const NETWORK_MAP: Record<string, string> = {
  facebook: 'facebook',
  instagram: 'instagram',
  twitter: 'twitter',
  x: 'twitter',
  linkedin: 'linkedin',
  tiktok: 'tiktok',
  youtube: 'youtube',
  threads: 'threads',
};

export type BatchItem = {
  topic: string;
  network: string;
  /** ISO datetime, clinic-local wall clock. */
  publishAt: string;
  format?: ContentType;
  /** A shareable media URL, if this item carries a video or image. */
  mediaUrl?: string;
};

export type BatchOutcome = {
  topic: string;
  network: string;
  publishAt: string;
  /** 'queued' is the only success: a draft exists in Metricool. */
  state: 'queued' | 'refused' | 'failed' | 'not_started';
  draftId?: string;
  metricoolId?: string;
  /** Why it is not queued, in a sentence for a person. */
  problem?: string;
  /** True when the draft is in Metricool but this dashboard failed to record it. */
  untracked?: boolean;
};

/**
 * Research, write, check, save, queue — one item.
 *
 * Never throws: a batch of eight must not lose seven because the third topic
 * upset the generator. Every failure comes back as an outcome with a sentence.
 */
export async function draftAndQueue(
  userId: string,
  item: BatchItem,
  brand: BrandContext | undefined,
  opts: { budgetMs?: number } = {},
): Promise<BatchOutcome> {
  const topic = String(item.topic || '').trim();
  const network = String(item.network || '').toLowerCase();
  const base: BatchOutcome = { topic, network, publishAt: item.publishAt, state: 'failed' };

  const provider = NETWORK_MAP[network];
  if (!topic) return { ...base, problem: 'No topic was given for this item.' };
  if (!provider) return { ...base, problem: 'There is no network called "' + network + '".' };

  const when = normalizePublishAt(item.publishAt);
  if (!when) return { ...base, problem: 'That is not a usable date and time.' };
  // Metricool accepts a past date and then refuses it when somebody opens the
  // draft to approve it — by which point it has been sitting in the queue
  // looking finished.
  if (Date.parse(when.instant) <= Date.now()) {
    return { ...base, problem: 'That time has already passed, so Metricool would refuse the draft when you opened it.' };
  }

  const token = process.env.METRICOOL_USER_TOKEN;
  const mcUserId = process.env.METRICOOL_USER_ID;
  if (!token || !mcUserId) {
    return { ...base, problem: 'Metricool is not configured on this deployment, so nothing can be queued.' };
  }
  const blogId = DEFAULT_BLOG_ID;
  if (!ALLOWED_BLOG_IDS.has(blogId)) {
    return { ...base, problem: 'The configured Metricool brand profile is not on this deployment’s allowlist.' };
  }

  // --- write ---------------------------------------------------------------
  let text = '';
  let pack: Record<string, any> | null = null;
  try {
    const result = await generateContentPack({
      topic,
      brand,
      contentType: (item.format || 'social') as ContentType,
      // Sized to the clock the caller has left, so a batch that is running out
      // of time stops retrying rather than dying mid-write. The field is
      // budgetMs; passing it through an `as any` under the wrong name is how it
      // would have been silently dropped and the fixed 3 x 30s retry plan used
      // instead — which is roughly three times the budget a batch item has.
      ...(opts.budgetMs ? { budgetMs: opts.budgetMs } : {}),
    });
    pack = (result?.pack || result) as Record<string, any>;
    text = pickText(pack, network).trim();
  } catch (e) {
    reportError('batch:generate', e, { topic });
    return { ...base, problem: 'The copy could not be written for this one. Nothing was queued.' };
  }
  if (!text) return { ...base, problem: 'The generator returned no text for this network.' };

  // The AVISO is the clinic's own advertising notice, from the Brand Brain.
  // Added here rather than hoped for from the model: a notice that depends on
  // the model remembering to include it is not a compliance control.
  const gate0 = await complianceGate(userId, text, network);
  if (gate0.applies) text = ensureAviso(text, gate0.aviso);

  // --- the gate ------------------------------------------------------------
  const gate = await complianceGate(userId, text, network);
  if (!gate.ok) {
    // REFUSED, not fixed quietly. A missing citation is the model having no
    // source, and inventing one is worse than not posting.
    return {
      ...base,
      state: 'refused',
      problem: gate.message || 'This draft does not satisfy the advertising rules, so it was not queued.',
    };
  }

  // --- save the draft locally ---------------------------------------------
  let draftId: string | undefined;
  try {
    const { data, error } = await supabaseAdmin()
      .from('drafts')
      .insert({ user_id: userId, topic, pack: pack ?? { instagram: text }, provider: 'anthropic' })
      .select('id')
      .maybeSingle();
    // Read, not assumed: supabase-js resolves a failed insert.
    if (error) throw error;
    if (data?.id) draftId = String(data.id);
  } catch (e) {
    // Not fatal. The draft's real home is Metricool; this is the local copy.
    reportError('batch:save-draft', e, { topic });
  }

  // --- queue the Metricool DRAFT ------------------------------------------
  const body: Record<string, any> = {
    text,
    publicationDate: { dateTime: when.wallClock, timezone: METRICOOL_TIMEZONE },
    providers: [{ network: provider }],
    // Constants. See the note at the top of this file.
    autoPublish: false,
    draft: true,
  };

  if (item.mediaUrl) {
    // Normalised first and sent as a URL STRING. Both halves matter: Metricool
    // answers 200 and silently drops an un-normalised URL, so "attached" meant
    // nothing until a person opened the draft and read "Add at least 1 image".
    try {
      body.media = [await normalizeMedia(String(item.mediaUrl))];
    } catch (e) {
      reportError('batch:normalize-media', e, { topic });
      return { ...base, draftId, problem: 'The video could not be prepared for Metricool, so this was not queued without it.' };
    }
  }

  if (provider === 'youtube') {
    // YouTube will not let a draft be SAVED without a title, a Short-or-video
    // answer and a stated audience — let alone approved.
    const yt = youtubeDataFor({
      title: '',
      body: text,
      format: String(item.format || ''),
      defaultPrivacy: process.env.YOUTUBE_DEFAULT_PRIVACY,
    });
    if (!yt) return { ...base, draftId, problem: 'A YouTube post needs a title and this copy has no usable first line.' };
    body.youtubeData = yt;
  }

  const url = metricoolApiBase() + '/v2/scheduler/posts?blogId=' + encodeURIComponent(blogId) +
    '&userId=' + encodeURIComponent(mcUserId);

  let metricoolId: string | undefined;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Mc-Auth': token },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    if (!r.ok) {
      console.error('batch: Metricool rejected', r.status, redact(raw.slice(0, 500)));
      return { ...base, draftId, problem: 'Metricool refused this one (' + r.status + '). The copy is saved as a draft here.' };
    }
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const post = parsed?.data ?? parsed;
    if (post?.id || post?.postId) metricoolId = String(post.id || post.postId);
  } catch (e) {
    reportError('batch:metricool', e, { topic });
    return { ...base, draftId, problem: 'Metricool could not be reached for this one. The copy is saved as a draft here.' };
  }

  // --- bookkeeping ---------------------------------------------------------
  let untracked = false;
  try {
    const { error } = await supabaseAdmin().from('posts').insert({
      user_id: userId,
      providers: [provider],
      text,
      publication_date: when.wallClock,
      metricool_post_id: metricoolId ?? null,
      // Never 'scheduled': Metricool says that about a post it is HOLDING for
      // review, and storing its word made our rows claim an approval nobody gave.
      status: 'pending_review',
    });
    if (error) throw error;
  } catch (e) {
    reportError('batch:posts-insert', e, { topic });
    untracked = true;
  }

  return { ...base, state: 'queued', draftId, metricoolId, untracked };
}

/** The pack field that belongs on this network. Mirrors the assistant's own mapping. */
function pickText(pack: Record<string, any> | null, network: string): string {
  if (!pack) return '';
  const key =
    network === 'twitter' || network === 'x'
      ? 'instagram'
      : ['instagram', 'facebook', 'linkedin', 'blog'].includes(network)
        ? network
        : 'instagram';
  const v = pack[key] ?? pack.instagram ?? pack.facebook ?? pack.linkedin ?? pack.blog ?? '';
  return typeof v === 'string' ? v : String(v || '');
}
