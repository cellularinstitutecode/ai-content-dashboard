// web/app/api/templates/strategy-upload/route.ts
// "Drop weekly strategy": a strategy PDF in, a week of Autopilot schedules out.
//
//   POST multipart/form-data { file: <PDF> }        → { plan, preview }  (reads only)
//   POST application/json { action: 'apply', plan } → inserts the templates
//
// Two steps so the team sees the week before anything is written. The plan the
// browser sends back is normalised again here (lib/strategy-upload.ts) — it is
// never trusted as it arrives.
//
// ADDITIVE ONLY. The apply step INSERTS. It does not update or delete any
// template, and it cannot publish anything: the new slots write drafts that
// wait in the review queue like every other Autopilot post.
import { NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { normalizeStrategy } from '@/lib/autopilot';
import { supportsJsonOutput } from '@/lib/anthropic-models';
import { readAnthropicStream } from '@/lib/sse-stream';
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';
import { generateContentPack, NoKeywordsError } from '@/lib/ai';
import { autoFixCitation } from '@/lib/citation-autofix';
import { claimSupportOf, claimSupportRefusal } from '@/lib/citation-gate';
import { checkCompliance } from '@/lib/compliance';
import { ensureKeywords } from '@/lib/keyword-guard';
import { avisoForUser } from '@/lib/compliance-gate';
import { fixPostCitation } from '@/lib/post-citation-fix';
import { imagesEnabled } from '@/lib/images';
import { citationVerdictLine, strategyClaimSupport } from '@/lib/strategy-claim-support';
import { loadBrandContext } from '@/lib/brand-context';
import { competitiveBrief } from '@/lib/competitive-brief';
import { ensureDraftImage } from '@/lib/images';
import { strategyBrand, strategyTopicPrompt } from '@/lib/strategy-voice';
import {
  ruleFor,
  UPLOAD_MAX_BYTES,
  DIRECT_MAX_BYTES,
  STRATEGY_BUCKET,
  mbLabel,
  UPLOAD_PROMPT,
  UPLOAD_SCHEMA,
  normalizeUpload,
  planUpload,
  uploadSummary,
  type ExistingRow,
} from '@/lib/strategy-upload';

export const runtime = 'nodejs';
export const maxDuration = 180;

const fail = (status: number, error: string, message: string) => NextResponse.json({ error, message }, { status });

/** The caption the judge, the fix and the keyword guard all read: the first channel with copy. */
const captionOf = (pack: Record<string, unknown>) => String(pack.instagram || pack.facebook || pack.blog || pack.linkedin || '');

/**
 * What the panel shows under a post as "Checked": the keywords it was written
 * around and the judge's verdict on its citation, both read off the draft's
 * own stamps — the same two things the door reads.
 */
function checksFor(pack: Record<string, unknown>, fixNote = '') {
  const semrush = (pack._semrush || null) as { keywords?: unknown; source?: unknown } | null;
  const status = claimSupportOf(pack);
  return {
    keywords: Array.isArray(semrush?.keywords) ? semrush.keywords.map(String).filter(Boolean) : [],
    keywordSource: String(semrush?.source || ''),
    citation: citationVerdictLine(status, Boolean(checkCompliance(captionOf(pack)).doi)) + (fixNote ? ' ' + fixNote : ''),
    held: claimSupportRefusal(status),
  };
}

/** How long the picture may take: the function has 180s, and the picture is all this request does. */
const PICTURE_BUDGET_MS = 150_000;
/** "Verify / fix" from the panel, on the draft alone (no post row exists yet). */
const FIX_BUDGET_MS = 120_000;

/**
 * The second ask, when the first came back with no posts. The first prompt
 * ends "if the document is not a content strategy, return an empty slots
 * array", and a model can take that exit on a document that plainly has
 * day pages — the same PDF read fine an hour earlier. So the retry says the
 * opposite, and asks for the day pages by name.
 */
const INSIST_PROMPT =
  'IMPORTANT: this document DOES contain a weekly posting plan — look for its day pages or day sections (Monday to Sunday), each with one or more posts, each post with a heading (the pillar) and a list of angles, questions or topics. ' +
  'Return EVERY one of those posts as a slot, in order. Do not return an empty slots array unless the document has no days at all.';

/** The document, read by Claude into UPLOAD_SCHEMA's shape. */
async function readStrategyPdf(pdf: Buffer, opts: { insist?: boolean } = {}): Promise<unknown> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('The AI reader is not configured (ANTHROPIC_API_KEY is missing).'), { status: 503 });
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const json = supportsJsonOutput(model);
  const url = (process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com').replace(/\/$/, '') + '/v1/messages';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      stream: true,
      messages: [{
        role: 'user',
        content: [
          // The document first, then the question about it.
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
          { type: 'text', text: UPLOAD_PROMPT + (opts.insist ? ' ' + INSIST_PROMPT : '') + (json ? '' : ' Answer with JSON only, matching this schema: ' + JSON.stringify(UPLOAD_SCHEMA)) },
        ],
      }],
      ...(json ? { output_config: { format: { type: 'json_schema', schema: UPLOAD_SCHEMA } } } : {}),
    }),
    signal: AbortSignal.timeout(170_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('anthropic ' + res.status + ': ' + body.slice(0, 300));
  }
  // Throws on a refusal and on a cut-off answer, naming which.
  const text = await readAnthropicStream(res);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The reader did not return a plan.');
  return JSON.parse(text.slice(start, end + 1));
}

async function existingTemplates(userId: string) {
  const sb = await supabaseServer();
  const { data, error } = await sb
    .from('schedule_templates')
    .select('name, weekdays, time_of_day, active, strategy')
    .eq('user_id', userId);
  return { sb, rows: (data || []) as ExistingRow[], error };
}

export async function POST(req: Request) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;

  const type = req.headers.get('content-type') || '';

  // ---- Step 2: create the schedules --------------------------------------
  if (type.includes('application/json')) {
    let body: { action?: unknown; plan?: unknown; path?: unknown };
    try { body = await req.json(); } catch { return fail(400, 'bad_request', 'The plan could not be read.'); }
    // Writing the week's posts has its own, larger allowance: fourteen posts
    // are twenty-eight requests, started as soon as the week is read.
    const writingPosts = body.action === 'draft' || body.action === 'picture' || body.action === 'fix';
    const rl = await checkRateLimit(auth.userId, writingPosts ? 'strategy-draft' : 'templates');
    if (!rl.ok) return fail(429, 'rate_limited', writingPosts ? 'Too many posts written in the last hour — the rest can be written shortly.' : 'Too many strategy uploads in the last hour — try again shortly.');

    // ---- A large PDF: park it in storage first ---------------------------
    //
    // Vercel refuses request bodies over 4.5 MB, which is where the old 4 MB
    // cap came from. A bigger document is uploaded by the browser straight to
    // a private bucket, on a signed URL good for one object under this user's
    // own prefix, and read from there below. The object is removed once read.
    if (body.action === 'sign') {
      const admin = supabaseAdmin();
      try {
        const { data: buckets } = await admin.storage.listBuckets();
        if (!(buckets || []).some((b) => b.name === STRATEGY_BUCKET)) {
          await admin.storage.createBucket(STRATEGY_BUCKET, { public: false, fileSizeLimit: String(UPLOAD_MAX_BYTES + 1024 * 1024), allowedMimeTypes: ['application/pdf'] });
        }
      } catch (e) { reportError('templates:upload-bucket', e); }
      const path = auth.userId + '/' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) + '.pdf';
      const { data, error } = await admin.storage.from(STRATEGY_BUCKET).createSignedUploadUrl(path);
      if (error || !data?.token) {
        reportError('templates:upload-sign', error || new Error('no token'));
        return fail(503, 'sign_failed', 'A place to upload the PDF could not be prepared just now. Try again in a moment.');
      }
      return NextResponse.json({ path, token: data.token, bucket: STRATEGY_BUCKET });
    }
    if (body.action === 'read') {
      const path = String(body.path || '');
      const expectedSize = Number((body as { size?: unknown }).size) || 0;
      // Only an object under this user's own prefix, with no way up out of it.
      if (!path.startsWith(auth.userId + '/') || path.includes('..')) return fail(400, 'bad_request', 'That upload is not yours to read.');
      const admin = supabaseAdmin();
      let buf: Buffer;
      try {
        const { data, error } = await admin.storage.from(STRATEGY_BUCKET).download(path);
        if (error || !data) throw error || new Error('empty download');
        buf = Buffer.from(await data.arrayBuffer());
      } catch (e) {
        reportError('templates:upload-download', e, { path });
        return fail(502, 'download_failed', 'The uploaded PDF could not be read back from storage. Drop it again.');
      }
      // The browser says how big the file was; a shorter object is a cut-off
      // upload, and reading it would be reading half a strategy.
      if (expectedSize && buf.length !== expectedSize) {
        void admin.storage.from(STRATEGY_BUCKET).remove([path]);
        return fail(502, 'upload_incomplete', 'The PDF did not upload completely (' + buf.length + ' of ' + expectedSize + ' bytes arrived). Drop it again.');
      }
      // Read, then removed whatever happened: the bucket is a waiting room, not a library.
      try {
        return await readIntoPlan(buf, auth.userId);
      } finally {
        void admin.storage.from(STRATEGY_BUCKET).remove([path]).then(({ error }) => { if (error) reportError('templates:upload-remove', error, { path }); });
      }
    }

    // ---- One post of a slot, written for real ----------------------------
    //
    // The week is a plan; a person reviewing it wants to see a post, not a
    // list of titles. This writes one occurrence of the slot exactly as the
    // Autopilot will — the strategy's voice, the slot's rule and day theme,
    // keywords, the competition, a REF line only when a health claim is made
    // — saves it under Recent Drafts like any other draft, makes its picture,
    // and hands the whole thing back to show in the panel.
    if (body.action === 'draft') {
      const b = body as { slot?: unknown; direction?: unknown; angle?: unknown };
      const plan = normalizeUpload({ slots: [b.slot], direction: String(b.direction || '') });
      const slot = plan.slots[0];
      if (!slot) return fail(400, 'bad_request', 'That post has no pillar or day yet.');
      const wanted = String(b.angle || '').trim();
      const angle = (wanted && slot.angles.find((a) => a === wanted)) || slot.angles[0] || slot.pillar;
      const admin = supabaseAdmin();
      // The brand and the competition are read side by side; neither waits on the other.
      const [brand, rivals] = await Promise.all([
        loadBrandContext(admin, auth.userId).catch((e: unknown) => { reportError('templates:draft-brand', e); return undefined; }),
        competitiveBrief(slot.pillar + ' ' + angle).catch((e: unknown) => { reportError('templates:draft-rivals', e); return null; }),
      ]);
      const topic = strategyTopicPrompt({ angle, pillarName: slot.pillar, rule: ruleFor(slot, plan.direction), dayTheme: slot.theme || undefined });
      let pack: Record<string, unknown>;
      try {
        const out = await generateContentPack({
          topic,
          brand: strategyBrand(brand, { citation: 'if-health-claim' }),
          contentType: slot.format === 'blog' ? 'blog' : 'social',
          channels: slot.providers,
          citationPolicy: 'if-health-claim',
          landscapeHint: rivals?.hint || undefined,
          budgetMs: 60_000,
        });
        pack = out.pack as unknown as Record<string, unknown>;
      } catch (e) {
        // No keywords, no post: the ladder (Semrush, the cache, the model's own
        // terms, the brief's words) found nothing to write around. Said as such,
        // not as "the writer did not answer".
        if (e instanceof NoKeywordsError) {
          return fail(422, 'no_keywords', 'Not written: no keywords could be researched for "' + angle + '". Every post is written around researched keywords, so this one waits until Semrush or the fallbacks have something for it. Give the angle a clearer subject and write it again.');
        }
        reportError('templates:draft-write', e);
        return fail(502, 'write_failed', 'The post could not be written just now: ' + (e instanceof Error ? e.message : 'the writer did not answer') + '. Try again in a moment.');
      }
      pack._strategyPreview = { pillar: slot.pillar, angle, weekday: slot.weekday, time: slot.time, theme: slot.theme };
      const { data: made, error: saveError } = await admin
        .from('drafts')
        .insert({ user_id: auth.userId, topic: slot.pillar + ' — ' + angle, pack, provider: 'anthropic' })
        .select('id')
        .single();
      if (saveError || !made) {
        reportError('templates:draft-save', saveError || new Error('no row'));
        return NextResponse.json({ draftId: null, pack, image: null, note: 'Written, but it could not be saved to Recent Drafts just now.' });
      }
      const draftId = String((made as { id: string }).id);

      // APPROVED AND FIXED, like every other post — here, at draft time, not
      // later at the door. The same three steps the Autopilot's score step
      // runs on a strategy post (lib/autopilot.ts):
      //   1. the judge: does the cited study back what the post says?
      //   2. "Verify / fix", by default: a citation the judge did not accept
      //      is swapped for a study that backs the claim (lib/citation-autofix.ts);
      //   3. keywords, last check: the ladder already stamped `_semrush` on
      //      the pack, or refused above; this backfills a stamp an edit lost.
      // Each fails open — the post is shown with whatever the step concluded —
      // and the verdict is written on the draft, so the card, the door and
      // this panel all read the same one.
      const caption = captionOf(pack);
      let stamp = await strategyClaimSupport(pack);
      let fixNote = '';
      if (stamp && stamp.status !== 'supported') {
        const fixed = await autoFixCitation({ userId: auth.userId, draftId, text: caption, pack, budgetMs: 60_000 });
        if (fixed.pack) pack = fixed.pack;
        if (fixed.swapped) { fixNote = fixed.note; stamp = null; /* stamped and saved by the repair */ }
      }
      if (stamp) {
        pack._claimSupport = stamp;
        const { error: stampError } = await admin.from('drafts').update({ pack }).eq('id', draftId).eq('user_id', auth.userId);
        if (stampError) reportError('templates:draft-claim-support-save', stampError, { draftId });
      }
      const kw = await ensureKeywords({ userId: auth.userId, draftId, text: caption, pack });
      if (kw.pack) pack = kw.pack;
      const checks = checksFor(pack, fixNote);
      // The copy goes back now; the picture is a second request (action
      // 'picture'), so the person reads the post while it is being made.
      return NextResponse.json({ draftId, pack, image: null, note: checks.held ? 'Saved to Recent Drafts, held.' : 'Saved to Recent Drafts.', checks });
    }
    if (body.action === 'picture') {
      const draftId = String((body as { draftId?: unknown }).draftId || '').trim();
      if (!draftId) return fail(400, 'bad_request', 'Which draft?');
      // The whole function's time, less a margin: a 60s allowance left the
      // Images call 30s, which is why a week's previews came back with "no
      // picture was made this time" and no reason. When it still fails, the
      // reason goes back, so the panel can say it instead of shrugging.
      if (!imagesEnabled()) return NextResponse.json({ draftId, image: null, reason: 'Pictures are switched off on this deployment (IMAGE_GEN=off or no OPENAI_API_KEY).' });
      let image: { url: string; alt?: string | null } | null = null;
      let reason = '';
      try {
        image = (await ensureDraftImage(draftId, auth.userId, { force: Boolean((body as { again?: unknown }).again), budgetMs: PICTURE_BUDGET_MS })) as { url: string; alt?: string | null } | null;
        if (!image) reason = 'That draft could not be found to make a picture for.';
      } catch (e) {
        reportError('templates:draft-image', e, { draftId });
        reason = 'The picture could not be made: ' + (e instanceof Error ? e.message : 'the image service did not answer') + '.';
      }
      return NextResponse.json({ draftId, image, reason: reason || undefined });
    }

    // ---- "Verify / fix", pressed on a previewed post -----------------------
    //
    // The same ladder the calendar's button runs on a scheduled post
    // (lib/post-citation-fix.ts), on the draft alone: no post row exists yet.
    // The judge reads the cited study against the copy; when it does not back
    // it, a study that does is searched for and the REF line swapped on every
    // channel. The verdict is stamped on the draft and handed back with the
    // pack, so the panel shows the corrected post and the new "Checked" box.
    if (body.action === 'fix') {
      const draftId = String((body as { draftId?: unknown }).draftId || '').trim();
      if (!draftId) return fail(400, 'bad_request', 'Which draft?');
      const admin = supabaseAdmin();
      const { data: row } = await admin.from('drafts').select('pack').eq('id', draftId).eq('user_id', auth.userId).maybeSingle();
      const pack = ((row as { pack?: Record<string, unknown> } | null)?.pack || null) as Record<string, unknown> | null;
      if (!pack) return fail(404, 'not_found', 'That draft could not be found.');
      let fix: Awaited<ReturnType<typeof fixPostCitation>>;
      try {
        fix = await fixPostCitation({ text: captionOf(pack), pack, aviso: await avisoForUser(auth.userId), budgetMs: FIX_BUDGET_MS });
      } catch (e) {
        reportError('templates:draft-fix', e, { draftId });
        return fail(502, 'fix_failed', 'The citation could not be checked just now. Nothing was changed — try again in a moment.');
      }
      let next = pack;
      if (Object.keys(fix.packPatch).length) {
        // Merged over a fresh read: the picture may have landed since the read above.
        const { data: fresh } = await admin.from('drafts').select('pack').eq('id', draftId).eq('user_id', auth.userId).maybeSingle();
        next = { ...(((fresh as { pack?: Record<string, unknown> } | null)?.pack) || pack), ...fix.packPatch };
        const { error } = await admin.from('drafts').update({ pack: next }).eq('id', draftId).eq('user_id', auth.userId);
        if (error) {
          reportError('templates:draft-fix-save', error, { draftId });
          return fail(503, 'draft_update_failed', 'The check ran, but the draft could not be updated. Nothing was changed — try again in a moment.');
        }
      }
      return NextResponse.json({ draftId, pack: next, swapped: fix.swapped, note: fix.note, checks: checksFor(next) });
    }

    if (body.action !== 'apply') return fail(400, 'bad_request', 'Unknown action.');
    const plan = normalizeUpload(body.plan);
    if (!plan.slots.length) return fail(400, 'empty', 'There are no slots to create.');

    const { sb, rows, error: readError } = await existingTemplates(auth.userId);
    if (readError) {
      // Fail closed: without knowing what is there, a second press could double the week.
      reportError('templates:upload-read', readError);
      return fail(503, 'unverified', 'Your existing templates could not be read just now, so nothing was created. Try again in a moment.');
    }
    const applyPlan = planUpload(plan, rows);
    if (applyPlan.create.length) {
      const now = new Date().toISOString();
      const insert = applyPlan.create.map((r) => ({
        user_id: auth.userId,
        name: r.name,
        providers: r.providers,
        // NOT NULL; a pillars template writes its own text every week.
        text: '',
        weekdays: r.weekdays,
        time_of_day: r.time_of_day,
        active: r.active,
        // Through the engine's own normaliser, so nothing is stored the engine would not read.
        strategy: normalizeStrategy(r.strategy),
        updated_at: now,
      }));
      const { error } = await sb.from('schedule_templates').insert(insert).select('id');
      if (error) {
        reportError('templates:upload-write', new Error(error.message));
        return fail(500, 'write_failed', 'The schedules could not be created: ' + error.message + ' Nothing was changed.');
      }
    }
    return NextResponse.json({
      ok: true,
      created: applyPlan.create.length,
      already: applyPlan.already.length,
      clashes: applyPlan.clashes,
      message: uploadSummary(applyPlan),
    });
  }

  // ---- Step 1: read the PDF into a week ----------------------------------
  //
  // A small PDF comes in the request itself; a large one arrives through
  // storage (action 'sign' then 'read' above). The panel picks which.
  const rl = await checkRateLimit(auth.userId, 'templates');
  if (!rl.ok) return fail(429, 'rate_limited', 'Too many strategy uploads in the last hour — try again shortly.');
  let form: FormData;
  try { form = await req.formData(); } catch { return fail(400, 'bad_request', 'Drop a PDF file.'); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail(400, 'bad_request', 'Drop a PDF file.');
  if (file.size > DIRECT_MAX_BYTES) return fail(413, 'too_large', 'A PDF over ' + mbLabel(DIRECT_MAX_BYTES) + ' has to be uploaded through storage — reload the page and drop it again.');
  const buf = Buffer.from(await file.arrayBuffer());
  return readIntoPlan(buf, auth.userId);
}

/** The document into a week: size and shape checks, the AI reader, the preview. */
async function readIntoPlan(buf: Buffer, userId: string): Promise<NextResponse> {
  if (buf.length > UPLOAD_MAX_BYTES) return fail(413, 'too_large', 'That PDF is over ' + mbLabel(UPLOAD_MAX_BYTES) + '. Export a smaller copy (text, not scanned pages) and drop it again.');
  // By content, not by name: "%PDF" opens every PDF.
  if (buf.subarray(0, 4).toString('latin1') !== '%PDF') return fail(415, 'not_pdf', 'That file is not a PDF.');

  let raw: unknown;
  try {
    raw = await readStrategyPdf(buf);
    // Nothing found: ask once more, firmly, before telling a person the plan
    // is not there. The same PDF has read as a full week and as nothing an
    // hour apart, and the difference was the reader, not the document.
    if (!normalizeUpload(raw).slots.length) {
      const first = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      reportError('templates:upload-empty', new Error('reader returned no slots'), { keys: Object.keys(first).join(','), title: String(first.title || '').slice(0, 80), bytes: String(buf.length) });
      raw = await readStrategyPdf(buf, { insist: true });
    }
  } catch (e) {
    reportError('templates:upload-read-pdf', e);
    const msg = e instanceof Error ? e.message : String(e);
    if (/refusal/i.test(msg)) return fail(422, 'refused', 'The AI reader declined this document. Check it is the content strategy and try again.');
    if (/max_tokens|cut off/i.test(msg)) return fail(422, 'too_long', 'The strategy was too long to read in one go. Try a shorter document, one week per file.');
    const status = (e as { status?: number }).status === 503 ? 503 : 502;
    return fail(status, 'read_failed', status === 503 ? msg : 'The PDF could not be read just now. Try again in a moment.');
  }
  const plan = normalizeUpload(raw);
  if (!plan.slots.length) {
    // In the reader's own words, so the person can see what it took the document for.
    const said = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const about = [String(said.title || '').trim(), String(said.summary || '').trim()].filter(Boolean).join(' — ').slice(0, 240);
    return fail(422, 'no_slots',
      'No weekly posting plan was found in that PDF, on two readings. It should list what to post on each day.' +
      (about ? ' The reader took it for: “' + about + '”.' : '') +
      ' If this is the weekly strategy, try again in a moment; if it keeps happening, export the PDF as text (not scanned pages) and drop it again.');
  }

  // What "Create schedules" would do — so the preview can say it up front.
  const { rows, error } = await existingTemplates(userId);
  const preview = error ? null : planUpload(plan, rows);
  return NextResponse.json({
    plan,
    preview: preview ? { create: preview.create.length, already: preview.already.length, clashes: preview.clashes } : null,
  });
}
