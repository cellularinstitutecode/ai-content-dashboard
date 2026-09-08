// web/lib/brand-fonts.ts
// Where the licensed brand typefaces live in production: a PRIVATE Supabase
// Storage bucket, written to by Brand Brain's upload and read by the card
// compositor. Never the repository — it is public, and font files are
// licensed software. A local checkout can still drop files in
// public/fonts/brand/ (gitignored) for development.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';
import { validateFontUpload, type FontFile } from '@/lib/brand-font-rules';

export const FONT_BUCKET = process.env.BRAND_ASSET_BUCKET || 'brand-assets';
const PREFIX = 'fonts';

export type StoredFont = { name: string; size: number | null; updatedAt: string | null; file: FontFile | null };

/** The font files currently in the bucket (names only — cheap to call). */
export async function listStoredFonts(): Promise<StoredFont[]> {
  const db = supabaseAdmin();
  const { data, error } = await db.storage.from(FONT_BUCKET).list(PREFIX, { limit: 100 });
  if (error) {
    // A bucket that does not exist yet is simply empty.
    if (/not found|does not exist|bucket/i.test(error.message || '')) return [];
    throw new Error('font list failed: ' + error.message);
  }
  const rows = Array.isArray(data) ? data : [];
  return rows
    .filter((r) => r && typeof r.name === 'string' && /\.(otf|ttf|woff)$/i.test(r.name))
    .map((r) => {
      const v = validateFontUpload(r.name, Number((r.metadata as { size?: number } | null)?.size ?? 1));
      return { name: r.name, size: (r.metadata as { size?: number } | null)?.size ?? null, updatedAt: (r as { updated_at?: string }).updated_at ?? null, file: v.ok ? v.file : null };
    });
}

/** Download every stored font's bytes — for the compositor. */
export async function readStoredFonts(): Promise<{ name: string; data: ArrayBuffer }[]> {
  const db = supabaseAdmin();
  const list = await listStoredFonts();
  const out: { name: string; data: ArrayBuffer }[] = [];
  for (const f of list) {
    if (!f.file) continue;
    const { data, error } = await db.storage.from(FONT_BUCKET).download(PREFIX + '/' + f.name);
    if (error || !data) { reportError('brand-fonts:download', error || new Error('no data'), { name: f.name }); continue; }
    out.push({ name: f.name, data: await data.arrayBuffer() });
  }
  return out;
}

/** Store one validated font file; creates the private bucket on first use. */
export async function saveStoredFont(safeName: string, bytes: Buffer): Promise<void> {
  const db = supabaseAdmin();
  const contentType = /\.woff$/i.test(safeName) ? 'font/woff' : /\.ttf$/i.test(safeName) ? 'font/ttf' : 'font/otf';
  const doUpload = () => db.storage.from(FONT_BUCKET).upload(PREFIX + '/' + safeName, bytes, { contentType, upsert: true });
  let { error } = await doUpload();
  if (error && /bucket/i.test(error.message || '')) {
    try { await db.storage.createBucket(FONT_BUCKET, { public: false }); } catch (e) { reportError('brand-fonts:bucket-create', e); }
    ({ error } = await doUpload());
  }
  if (error) throw new Error('font upload failed: ' + error.message);
}

export async function deleteStoredFont(name: string): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db.storage.from(FONT_BUCKET).remove([PREFIX + '/' + name]);
  if (error) throw new Error('font delete failed: ' + error.message);
}
