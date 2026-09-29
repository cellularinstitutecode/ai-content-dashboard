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
import { reportError } from '@/lib/report';
import {
  UPLOAD_MAX_BYTES,
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

/** The document, read by Claude into UPLOAD_SCHEMA's shape. */
async function readStrategyPdf(pdf: Buffer): Promise<unknown> {
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
          { type: 'text', text: UPLOAD_PROMPT + (json ? '' : ' Answer with JSON only, matching this schema: ' + JSON.stringify(UPLOAD_SCHEMA)) },
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
  const rl = await checkRateLimit(auth.userId, 'templates');
  if (!rl.ok) return fail(429, 'rate_limited', 'Too many strategy uploads in the last hour — try again shortly.');

  const type = req.headers.get('content-type') || '';

  // ---- Step 2: create the schedules --------------------------------------
  if (type.includes('application/json')) {
    let body: { action?: unknown; plan?: unknown };
    try { body = await req.json(); } catch { return fail(400, 'bad_request', 'The plan could not be read.'); }
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
  let form: FormData;
  try { form = await req.formData(); } catch { return fail(400, 'bad_request', 'Drop a PDF file.'); }
  const file = form.get('file');
  if (!file || typeof file === 'string') return fail(400, 'bad_request', 'Drop a PDF file.');
  if (file.size > UPLOAD_MAX_BYTES) return fail(413, 'too_large', 'That PDF is over 4 MB. Export a smaller copy (text, not scanned pages) and drop it again.');
  const buf = Buffer.from(await file.arrayBuffer());
  // By content, not by name: "%PDF" opens every PDF.
  if (buf.subarray(0, 4).toString('latin1') !== '%PDF') return fail(415, 'not_pdf', 'That file is not a PDF.');

  let raw: unknown;
  try {
    raw = await readStrategyPdf(buf);
  } catch (e) {
    reportError('templates:upload-read-pdf', e);
    const msg = e instanceof Error ? e.message : String(e);
    if (/refusal/i.test(msg)) return fail(422, 'refused', 'The AI reader declined this document. Check it is the content strategy and try again.');
    if (/max_tokens|cut off/i.test(msg)) return fail(422, 'too_long', 'The strategy was too long to read in one go. Try a shorter document, one week per file.');
    const status = (e as { status?: number }).status === 503 ? 503 : 502;
    return fail(status, 'read_failed', status === 503 ? msg : 'The PDF could not be read just now. Try again in a moment.');
  }
  const plan = normalizeUpload(raw);
  if (!plan.slots.length) return fail(422, 'no_slots', 'No weekly posting plan was found in that PDF. It should list what to post on each day.');

  // What "Create schedules" would do — so the preview can say it up front.
  const { rows, error } = await existingTemplates(auth.userId);
  const preview = error ? null : planUpload(plan, rows);
  return NextResponse.json({
    plan,
    preview: preview ? { create: preview.create.length, already: preview.already.length, clashes: preview.clashes } : null,
  });
}
