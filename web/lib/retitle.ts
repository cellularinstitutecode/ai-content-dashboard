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
import { renderTitleCover } from '@/lib/title-cover';
import { storeBytes, type PackImage } from '@/lib/images';
import { fetchPhoto } from '@/lib/library-hero';
import { cleanCoverTitle, retitleDecision } from './cover-edit.ts';

/** The picture with `title` set on its clean photograph ('' takes the title off). */
export async function retitleImage(existing: PackImage, title: string, nameHint = 'cover'): Promise<PackImage> {
  const decision = retitleDecision(existing);
  if (!decision.ok) throw new Error(decision.reason);
  const words = cleanCoverTitle(title);
  const photo = await fetchPhoto(decision.photoUrl);
  // The alt text carried the old title in front of the subject; put the new one there.
  const rest = existing.titled?.title ? String(existing.alt || '').replace(existing.titled.title + ' — ', '') : String(existing.alt || '');
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
  const cover = await renderTitleCover({ title: words, photo: { bytes: photo.bytes, contentType: photo.contentType }, headTopPct: decision.headTopPct });
  const url = await storeBytes(cover.png, 'image/png', 'png', nameHint + '-cover');
  return {
    ...existing,
    url,
    titled: { title: words, photoUrl: decision.photoUrl, family: cover.family, custom: true },
    alt: words + ' — ' + rest,
  };
}
