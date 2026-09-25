// GET /api/sources/caption
//
// Reads the team's Drive photo folder with the vision model and reports what is
// in it: what each photograph shows, what the cover rules would refuse it for,
// and — the question this was built to answer — how many usable pictures exist
// for each weekly pillar.
//
// Read-only. Nothing is imported, stored or changed; the captions come back in
// the response for a person to look at before any of this is wired into
// picture-picking.
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { downloadDriveFile, listFolderImages, sourcesConfigured } from '@/lib/google-sources';

// The camera exports in the folder run 30-45 MB. Both of these routes scale the
// picture down before they look at it, so the only thing the ceiling has to do
// here is refuse something pathological.
const BIG_FILE_MAX_BYTES = 64 * 1024 * 1024;
import { PILLARS } from '@/lib/content-strategy';
import { captionSystemPrompt, coverSafe, inventory, parseCaption, pillarsFor, type Caption } from '@/lib/library-caption';
import { smallJpeg } from '@/lib/image-small';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';
export const maxDuration = 300;

const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';

async function captionOne(bytes: Buffer, contentType: string, key: string): Promise<Caption | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 220,
      // Cataloguing the same photograph twice used to give two different
      // answers: across 39 photographs read more than once, 7 flipped between
      // cover-safe and not, and 12 changed which blocker they reported. A
      // library whose verdict depends on the roll is not a library.
      temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: captionSystemPrompt() },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Catalogue this photograph.' },
              // "low" detail is deliberate: the questions are what the picture
              // is OF and whether words are visible, both of which survive a
              // small image, and the folder holds 30 MB camera exports.
              { type: 'image_url', image_url: { url: `data:${contentType};base64,${bytes.toString('base64')}`, detail: 'low' } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const j = await res.json();
    return parseCaption(j?.choices?.[0]?.message?.content ?? '');
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const gate = await requireAllowlistedUser();
  if (!gate.ok) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  if (!sourcesConfigured()) return NextResponse.json({ error: 'sources_not_configured' }, { status: 503 });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: 'no_openai_key' }, { status: 503 });

  const url = new URL(req.url);
  // Each photograph here is a Drive download of up to 45 MB, an ffmpeg pass and
  // a vision call, all inside one function. A page of 25 quietly ran out of room:
  // one sweep skipped 21 of 25, and the same 20 files read perfectly in pages of
  // five. The page size, not the pictures, was the problem.
  const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit')) || 8));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  try {
    const all = await listFolderImages();
    const slice = all.slice(offset, offset + limit);
    const rows: Array<Record<string, unknown>> = [];
    const caps: Caption[] = [];
    for (const f of slice) {
      try {
        const file = await downloadDriveFile(f.id, BIG_FILE_MAX_BYTES);
        const ext = /png$/i.test(file.contentType) ? 'png' : /webp$/i.test(file.contentType) ? 'webp' : 'jpg';
        // A 30 MB camera export is far more than the model needs and more than
        // the request will carry, so it is scaled first rather than skipped —
        // those files are the best photography in the folder.
        const small = file.bytes.length > 2 * 1024 * 1024 ? await smallJpeg(file.bytes, ext) : null;
        if (!small && file.bytes.length > 12 * 1024 * 1024) {
          rows.push({ id: f.id, name: f.name, skipped: 'too_large', mb: Math.round(file.bytes.length / 1048576) });
          continue;
        }
        const c = await captionOne(small ?? file.bytes, small ? 'image/jpeg' : file.contentType, key);
        if (!c) { rows.push({ id: f.id, name: f.name, skipped: 'no_caption' }); continue; }
        caps.push(c);
        const safe = coverSafe(c);
        rows.push({ id: f.id, name: f.name, caption: c.caption, subjects: c.subjects, blockers: c.blockers,
                    pillars: pillarsFor(c), coverSafe: safe.ok, needsConsent: safe.needsConsent });
      } catch (e) {
        reportError('sources-caption:one', e);
        // 'unreadable' told us nothing and cost an afternoon: it was read as
      // 'this file cannot be read' when it meant 'this attempt did not finish'.
      rows.push({ id: f.id, name: f.name, skipped: 'failed', why: e instanceof Error ? e.message.slice(0, 140) : 'unknown' });
      }
    }
    return NextResponse.json({
      total: all.length,
      offset,
      captioned: caps.length,
      skipped: rows.filter((r) => r.skipped).length,
      inventory: inventory(caps, PILLARS.map((p) => p.id)),
      rows,
    });
  } catch (e) {
    reportError('sources-caption', e);
    return NextResponse.json({ error: e instanceof Error ? e.message : 'failed' }, { status: 500 });
  }
}
