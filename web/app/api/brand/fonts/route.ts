// /api/brand/fonts — the clinic's licensed typefaces, uploaded from Brand
// Brain into PRIVATE storage so the brand cards can be set in Canela, Nexa or
// Rische without a single font file ever entering this public repository.
//
//   GET    → what is stored, which role each file covers, and which roles still
//            run on a stand-in
//   POST   → multipart/form-data with one or more `files`; trial/demo builds,
//            non-brand faces and oversized files are refused by name with the
//            reason, the rest are stored and the compositor's cache is dropped
//   DELETE → ?name=<file> removes one
import { NextRequest, NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { reportError } from '@/lib/report';
import { coverage, validateFontUpload } from '@/lib/brand-font-rules';
import { deleteStoredFont, listStoredFonts, saveStoredFont } from '@/lib/brand-fonts';
import { resetFontCache } from '@/lib/brand-card';

export const runtime = 'nodejs';
export const maxDuration = 30;

async function inventory() {
  const fonts = await listStoredFonts();
  const cov = coverage(fonts.map((f) => f.name));
  return { fonts, headline: cov.headline, body: cov.body, standInFaces: cov.standInFaces };
}

export async function GET() {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json(await inventory());
  } catch (e) {
    reportError('brand-fonts:list', e);
    return NextResponse.json({ error: 'list_failed', message: 'The font store could not be read just now.' }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: 'bad_request', message: 'Send the font files as multipart form data.' }, { status: 400 }); }
  const files = form.getAll('files').filter((f): f is File => typeof f === 'object' && f !== null && typeof (f as File).arrayBuffer === 'function');
  if (!files.length) return NextResponse.json({ error: 'no_files', message: 'Choose at least one .otf, .ttf or .woff file.' }, { status: 400 });

  const saved: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  for (const f of files.slice(0, 12)) {
    const v = validateFontUpload(f.name, f.size);
    if (!v.ok) { refused.push({ name: f.name, reason: v.reason }); continue; }
    try {
      await saveStoredFont(v.safeName, Buffer.from(await f.arrayBuffer()));
      saved.push(v.safeName);
    } catch (e) {
      reportError('brand-fonts:save', e, { name: v.safeName });
      refused.push({ name: f.name, reason: 'could not be stored just now.' });
    }
  }
  if (saved.length) resetFontCache();
  const status = saved.length ? 200 : 422;
  try {
    return NextResponse.json({ ok: saved.length > 0, saved, refused, ...(await inventory()) }, { status });
  } catch {
    return NextResponse.json({ ok: saved.length > 0, saved, refused }, { status });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const name = String(req.nextUrl.searchParams.get('name') || '').split(/[\\/]/).pop() || '';
  if (!name || !/\.(otf|ttf|woff)$/i.test(name)) return NextResponse.json({ error: 'name required' }, { status: 400 });
  try {
    await deleteStoredFont(name);
    resetFontCache();
    return NextResponse.json({ ok: true, ...(await inventory()) });
  } catch (e) {
    reportError('brand-fonts:delete', e, { name });
    return NextResponse.json({ error: 'delete_failed', message: 'The file could not be removed just now.' }, { status: 502 });
  }
}
