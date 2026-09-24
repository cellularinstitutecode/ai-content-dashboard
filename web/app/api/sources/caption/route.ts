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
import { PILLARS } from '@/lib/content-strategy';
import { captionSystemPrompt, coverSafe, inventory, parseCaption, pillarsFor, type Caption } from '@/lib/library-caption';
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
  const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('limit')) || 25));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);

  try {
    const all = await listFolderImages();
    const slice = all.slice(offset, offset + limit);
    const rows: Array<Record<string, unknown>> = [];
    const caps: Caption[] = [];
    for (const f of slice) {
      try {
        const file = await downloadDriveFile(f.id);
        // A 30 MB PNG is far more than the model needs, and more than the
        // request will carry; those are reported rather than silently skipped.
        if (file.bytes.length > 12 * 1024 * 1024) {
          rows.push({ id: f.id, name: f.name, skipped: 'too_large', mb: Math.round(file.bytes.length / 1048576) });
          continue;
        }
        const c = await captionOne(file.bytes, file.contentType, key);
        if (!c) { rows.push({ id: f.id, name: f.name, skipped: 'unreadable' }); continue; }
        caps.push(c);
        const safe = coverSafe(c);
        rows.push({ id: f.id, name: f.name, caption: c.caption, subjects: c.subjects, blockers: c.blockers,
                    pillars: pillarsFor(c), coverSafe: safe.ok, needsConsent: safe.needsConsent });
      } catch (e) {
        reportError('sources-caption:one', e);
        rows.push({ id: f.id, name: f.name, skipped: 'unreadable' });
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
