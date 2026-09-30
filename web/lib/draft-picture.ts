// web/lib/draft-picture.ts
// THE PICTURE FOR A DRAFT: the clinic's own photograph first, a generated one
// only when the library has nothing that fits.
//
// One door for the paths that make a post's picture automatically — the
// Autopilot's draft step, the strategy preview — so they cannot disagree
// about the order. "New image", FIX and the Image Studio keep calling
// ensureDraftImage directly: a person pressing for a fresh AI take wants one.
import 'server-only';

import type { BrandContext } from '@/lib/ai';
import { ensureDraftImage, imagesEnabled, type PackImage } from '@/lib/images';
import { imageUnshippable as unshippable } from '@/lib/image-verdict';
import { libraryPhotoFor } from '@/lib/library-pick';
import { removeSuperseded } from '@/lib/images';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

export type DraftPicture = { image: PackImage | null; source: 'library' | 'generated' | 'existing' | 'none'; notes: string[] };

export async function pictureForDraft(draftId: string, ownerId: string, opts: { budgetMs?: number | null; quality?: 'high' | 'medium'; maxAttempts?: number; preferLibrary?: boolean } = {}): Promise<DraftPicture> {
  const db = supabaseAdmin();
  const { data: d } = await db.from('drafts').select('id, topic, pack').eq('id', draftId).eq('user_id', ownerId).maybeSingle();
  if (!d) return { image: null, source: 'none', notes: ['draft not found'] };
  const row = d as { topic: string | null; pack: Record<string, unknown> | null };
  const pack = row.pack && typeof row.pack === 'object' ? row.pack : {};
  const existing = (pack as { _image?: PackImage })._image;
  if (existing?.url && !unshippable(existing.verification)) return { image: existing, source: 'existing', notes: [] };

  if (opts.preferLibrary !== false) {
    let brand: BrandContext | null = null;
    try {
      const { data: bp } = await db.from('brand_profiles').select('*').eq('user_id', ownerId).maybeSingle();
      if (bp) brand = bp as BrandContext;
    } catch (e) { reportError('draft-picture:brand', e); }
    const pick = await libraryPhotoFor({ pack, topic: String(row.topic || ''), brand, budgetMs: opts.budgetMs ?? undefined });
    if (pick) {
      // Merged over a fresh read, like every other picture writer.
      const { data: fresh } = await db.from('drafts').select('pack').eq('id', draftId).eq('user_id', ownerId).maybeSingle();
      const current = ((fresh as { pack?: Record<string, unknown> } | null)?.pack ?? pack) as Record<string, unknown>;
      const next = { ...current, _image: pick.image };
      const { error } = await db.from('drafts').update({ pack: next }).eq('id', draftId).eq('user_id', ownerId);
      if (error) reportError('draft-picture:save', error, { draftId });
      else await removeSuperseded(current, next).catch(() => 0);
      return { image: pick.image, source: 'library', notes: pick.notes };
    }
  }
  if (!imagesEnabled()) return { image: null, source: 'none', notes: ['no library photograph fits, and pictures are switched off'] };
  const made = await ensureDraftImage(draftId, ownerId, { budgetMs: opts.budgetMs, quality: opts.quality, maxAttempts: opts.maxAttempts });
  return { image: made, source: made ? 'generated' : 'none', notes: [] };
}
