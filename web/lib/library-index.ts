// web/lib/library-index.ts
// THE LIBRARY, READ ONCE AND REMEMBERED.
//
// The team's Drive folder holds the clinic's own photographs. Each is read
// once with the vision model (what it shows, what the cover rules would refuse
// it for — lib/library-caption.ts), measured against the house palette
// (lib/palette-measure.ts), and kept in library_photos so that a post can be
// given a real photograph in milliseconds instead of a generated one in two
// minutes and a quarter of a dollar. The same table records when each photo
// was last used, which is how lib/library-topic.ts keeps the feed from
// showing the same waiting room every day.
//
// Fail-soft throughout: a missing table, a Drive refusal or a model that will
// not answer all read as "nothing indexed", and the caller generates as
// before.
import 'server-only';

import { readFile } from 'node:fs/promises';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { LIBRARY_IMAGE_MAX_BYTES, downloadDriveFileToDisk, listFolderImages, sourcesConfigured } from '@/lib/google-sources';
import { captionSystemPrompt, parseCaption, type Caption } from '@/lib/library-caption';
import { fitImage } from '@/lib/image-downscale';
import { smallJpeg } from '@/lib/image-small';
import { storeBytes } from '@/lib/images';
import { measureImage } from '@/lib/palette-measure';
import type { PaletteStats } from '@/lib/palette';
import { reportError } from '@/lib/report';
import type { LibraryCandidate } from './library-topic.ts';

const VISION_MODEL = process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini';

export type LibraryRow = {
  file_id: string;
  name: string;
  caption: string;
  subjects: string[];
  blockers: string[];
  stats: PaletteStats | null;
  url: string | null;
  consent_cleared: boolean;
  used_count: number;
  last_used_at: string | null;
  captioned_at: string;
};

/** One photograph, read by the vision model. Null when it would not answer. */
export async function captionOne(bytes: Buffer, contentType: string): Promise<Caption | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
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

/** Has supabase/library-photos.sql been run? A read that fails on the table itself says no; nothing is captioned into a table that cannot hold it. */
export async function libraryTableReady(): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin().from('library_photos').select('file_id').limit(1);
    return !error;
  } catch {
    return false;
  }
}

/** Every indexed photograph. Empty (never a throw) when the table is missing. */
export async function loadLibraryRows(): Promise<LibraryRow[]> {
  try {
    const { data, error } = await supabaseAdmin().from('library_photos').select('*').limit(1000);
    if (error) throw error;
    return (data || []) as LibraryRow[];
  } catch (e) {
    reportError('library-index:load', e);
    return [];
  }
}

/** The rows as the picker reads them. */
export function candidatesFrom(rows: readonly LibraryRow[]): LibraryCandidate[] {
  return rows.map((r) => ({
    id: r.file_id,
    name: r.name,
    caption: { caption: r.caption, subjects: (r.subjects || []) as Caption['subjects'], blockers: (r.blockers || []) as Caption['blockers'] },
    stats: r.stats || null,
    consentCleared: Boolean(r.consent_cleared),
    lastUsedAt: r.last_used_at ? Date.parse(r.last_used_at) : null,
    usedCount: r.used_count || 0,
  }));
}

export type IndexReport = {
  /** Photographs in the folder. */
  total: number;
  /** Indexed before this run. */
  already: number;
  /** Indexed by this run. */
  added: number;
  /** Could not be read, this run. */
  skipped: number;
  /** Stopped for time, with photographs still unread. */
  outOfTime: boolean;
  configured: boolean;
};

/**
 * Read up to `max` photographs the index does not have yet, inside `budgetMs`.
 *
 * Called from the Image Library's "Index for automatic pictures" button, and
 * opportunistically (a few at a time) by the picker, so a folder gets indexed
 * over the first week of posts even if nobody presses anything.
 */
export async function indexLibrary(opts: { max?: number; budgetMs?: number; refresh?: boolean } = {}): Promise<IndexReport> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 240_000;
  const max = Math.max(0, opts.max ?? 25);
  const report: IndexReport = { total: 0, already: 0, added: 0, skipped: 0, outOfTime: false, configured: sourcesConfigured() };
  if (!report.configured || !process.env.OPENAI_API_KEY) return report;
  if (!(await libraryTableReady())) return report;
  let files: Awaited<ReturnType<typeof listFolderImages>>;
  try { files = await listFolderImages(); } catch (e) { reportError('library-index:list', e); return report; }
  report.total = files.length;
  const have = new Set((await loadLibraryRows()).map((r) => r.file_id));
  report.already = files.filter((f) => have.has(f.id)).length;
  const todo = files.filter((f) => opts.refresh || !have.has(f.id)).slice(0, max);
  const db = supabaseAdmin();
  for (const f of todo) {
    // A read takes 5-20s; a second one is not started with less than that left.
    if (Date.now() - started > budget - 25_000) { report.outOfTime = true; break; }
    try {
      const file = await downloadDriveFileToDisk(f.id, LIBRARY_IMAGE_MAX_BYTES);
      try {
        const small = file.size > 2 * 1024 * 1024 ? await smallJpeg(file.path) : null;
        if (!small && file.size > 12 * 1024 * 1024) { report.skipped += 1; continue; }
        const [caption, stats] = await Promise.all([
          captionOne(small ?? (await readFile(file.path)), small ? 'image/jpeg' : file.contentType),
          measureImage(file.path).catch(() => null),
        ]);
        if (!caption) { report.skipped += 1; continue; }
        const { error } = await db.from('library_photos').upsert({
          file_id: f.id, name: f.name, caption: caption.caption, subjects: caption.subjects, blockers: caption.blockers,
          stats: stats || null, captioned_at: new Date().toISOString(),
        }, { onConflict: 'file_id' });
        if (error) throw error;
        report.added += 1;
      } finally {
        await file.cleanup();
      }
    } catch (e) {
      reportError('library-index:one', e, { fileId: f.id });
      report.skipped += 1;
    }
  }
  return report;
}

/** How much of the folder is indexed, for the Image Library page. */
export async function libraryIndexStatus(): Promise<{ total: number; indexed: number; usable: number; configured: boolean }> {
  const configured = sourcesConfigured();
  if (!configured) return { total: 0, indexed: 0, usable: 0, configured };
  let total = 0;
  try { total = (await listFolderImages()).length; } catch (e) { reportError('library-index:status', e); }
  const rows = await loadLibraryRows();
  const usable = rows.filter((r) => r.stats && !(r.blockers || []).some((b) => b !== 'identifiable-patient') && (!(r.blockers || []).includes('identifiable-patient') || r.consent_cleared)).length;
  return { total, indexed: rows.length, usable, configured };
}

/**
 * The photograph's copy in the app's own bucket, made on first use (a network
 * cannot fetch a Drive link) and remembered on the row after that.
 */
export async function libraryPhotoUrl(row: LibraryRow): Promise<string> {
  if (row.url) return row.url;
  const file = await downloadDriveFileToDisk(row.file_id, LIBRARY_IMAGE_MAX_BYTES);
  try {
    const fit = await fitImage(file.path, file.size, file.contentType, file.ext);
    if (!fit.bytes) throw new Error('the photo could not be scaled down here');
    const url = await storeBytes(fit.bytes, fit.contentType, fit.ext, file.name.replace(/\.[a-z0-9]+$/i, ''));
    const { error } = await supabaseAdmin().from('library_photos').update({ url }).eq('file_id', row.file_id);
    if (error) reportError('library-index:url-save', error, { fileId: row.file_id });
    return url;
  } finally {
    await file.cleanup();
  }
}

/** A post used this photograph: remembered, so the next post gets a different one. Never throws. */
export async function touchLibraryUse(fileId: string): Promise<void> {
  if (!fileId) return;
  try {
    const db = supabaseAdmin();
    const { data } = await db.from('library_photos').select('used_count').eq('file_id', fileId).maybeSingle();
    const used = Number((data as { used_count?: number } | null)?.used_count || 0) + 1;
    const { error } = await db.from('library_photos').update({ used_count: used, last_used_at: new Date().toISOString() }).eq('file_id', fileId);
    if (error) throw error;
  } catch (e) {
    reportError('library-index:touch', e, { fileId });
  }
}
