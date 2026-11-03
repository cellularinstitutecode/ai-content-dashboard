// web/lib/retitle.ts
// Change the words on a draft's cover — or take them off — without an image
// model. The clean photograph a cover was rendered from is kept beside it
// (`_image.titled.photoUrl`, lib/images.ts); this fetches it back, paints the
// new title with lib/title-cover.ts, stores the result and hands back the
// picture's record with everything else (verification, provenance, notes)
// untouched. No credits are spent: the only calls are storage.
//
// lib/cover-edit.ts decides whether a picture CAN be retitled; this assumes
// it can and throws when it cannot.
import 'server-only';
import { plainTitle, renderTitleCover } from '@/lib/title-cover';
import { measureBands } from '@/lib/palette-measure';
import { quietBand, quietSideFor } from '@/lib/cover-bands';
import { storeBytes, type PackImage } from '@/lib/images';
import { fetchPhoto } from '@/lib/library-hero';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { ownBucketUrl } from './library-cover.ts';
import { IMAGE_BUCKET } from '@/lib/images';
import { cleanCoverTitle, retitleDecision } from './cover-edit.ts';

/** The picture with `title` set on its clean photograph ('' takes the title off). */
export async function retitleImage(existing: PackImage, title: string, nameHint = 'cover'): Promise<PackImage> {
  const decision = retitleDecision(existing);
  if (!decision.ok) throw new Error(decision.reason);
  const words = cleanCoverTitle(title);
  const photo = await fetchPhoto(await cleanPhotoUrl(existing, decision.photoUrl));
  // The alt text carried the old title in front of the subject; put the new one there.
  const rest = existing.titled?.title ? String(existing.alt || '').replace(plainTitle(existing.titled.title) + ' — ', '') : String(existing.alt || '');
  if (!words) {
    // The clean photograph itself is the hero; the record says the title is off
    // on purpose, so nothing gives it a cover later.
    return {
      ...existing,
      url: decision.photoUrl,
      titled: { title: '', photoUrl: decision.photoUrl, family: existing.titled?.family || 'none', custom: true },
      alt: rest,
    };
  }
  // The head measurement from the take's own check keeps the title clear of a face.
  const bands = await measureBands(photo.bytes);
  const quiet = quietBand(bands);
  const quietSide = quietSideFor(bands, { headTopPct: decision.headTopPct, quiet });
  const cover = await renderTitleCover({ title: words, photo: { bytes: photo.bytes, contentType: photo.contentType }, headTopPct: decision.headTopPct, clearSide: decision.clearSide, quiet, quietSide });
  const url = await storeBytes(cover.png, 'image/png', 'png', nameHint + '-cover');
  return {
    ...existing,
    url,
    titled: { title: words, photoUrl: decision.photoUrl, family: cover.family, custom: true },
    alt: plainTitle(words) + ' — ' + rest,
  };
}

/**
 * The photograph to paint on: the draft's kept copy, unless that copy carries
 * the sky the earlier pipeline padded onto it. Covers made before the title
 * learned to go to the bottom had a blurred mirror of the top edge added so
 * the title could sit above the people; that copy is what those drafts keep,
 * and a title set on it again keeps the blur. For such a draft the library's
 * own copy of the original is used instead, when the library still has it in
 * the app's bucket. The grade the copy carried is not re-applied: the
 * original goes as the clinic shot it.
 */
async function cleanPhotoUrl(existing: PackImage, kept: string): Promise<string> {
  const padded = Number((existing as { padded?: unknown }).padded || 0);
  const fileId = String((existing as { libraryFileId?: unknown }).libraryFileId || '').trim();
  if (!(padded > 0) || !fileId) return kept;
  const { data } = await supabaseAdmin()
    .from('library_photos')
    .select('url')
    .eq('file_id', fileId)
    .maybeSingle()
    .then((x) => x, () => ({ data: null }));
  const url = String((data as { url?: string | null } | null)?.url || '').trim();
  return url && ownBucketUrl(url, process.env.NEXT_PUBLIC_SUPABASE_URL, IMAGE_BUCKET) ? url : kept;
}
