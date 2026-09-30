// web/lib/library-pick.ts
// A REAL PHOTOGRAPH FOR THIS POST, when the library has one that fits.
//
// Before a post pays for a generated picture, the indexed library
// (lib/library-index.ts) is asked for a photograph that serves what the post
// is about (lib/library-topic.ts), has not been used in the last few weeks,
// passes the cover rules and sits in the house palette. When there is one it
// becomes the post's picture exactly as "Use library photo with brand filter"
// would have made it (lib/library-hero.ts): graded, titled for a planner post,
// checked for a head under the title band. No image model is paid for.
//
// When there is none — the folder has nothing for sleep, or everything that
// fits was used this month and a repeat is not wanted — the answer is null
// and the caller generates, as before. A near-miss is never offered.
import 'server-only';

import type { BrandContext } from '@/lib/ai';
import { libraryHero } from '@/lib/library-hero';
import { candidatesFrom, indexLibrary, libraryPhotoUrl, loadLibraryRows, touchLibraryUse, type LibraryRow } from '@/lib/library-index';
import { GENERAL_PILLARS, pickFresh, pillarsForText, type FreshMatch } from '@/lib/library-topic';
import type { PackImage } from '@/lib/images';
import { plannerImageFor } from '@/lib/planner-image';
import { reportError } from '@/lib/report';

/** How many unread photographs one picture step may index on the way, so the folder gets read over the first posts. */
const TOP_UP = 6;

export type LibraryPick = { image: PackImage; match: FreshMatch; notes: string[] };

/** The text the pillar is read from: the post's copy, then its topic. */
function textOf(pack: Record<string, unknown>, topic: string): string {
  return [topic, pack.instagram, pack.facebook, pack.linkedin, pack.blog, pack.title].map((v) => String(v || '')).join('\n').slice(0, 6000);
}

export async function libraryPhotoFor(opts: {
  pack: Record<string, unknown>;
  topic: string;
  brand?: BrandContext | null;
  /** A repeat of the current photograph is never handed back. */
  excludeFileId?: string | null;
  /** Never offer a photograph used in the window — not even as the last resort (the default allows the least recent one). */
  freshOnly?: boolean;
  budgetMs?: number;
  /** Told, in one line, why no photograph was offered — shown under a generated picture so the choice is explained. */
  explain?: (reason: string) => void;
}): Promise<LibraryPick | null> {
  const why = (reason: string) => { try { opts.explain?.(reason); } catch { /* a note, never a failure */ } };
  const started = Date.now();
  let rows: LibraryRow[];
  try {
    rows = await loadLibraryRows();
    // A folder nobody has indexed yet is read a few photographs at a time, on
    // the way to this post's picture, inside a small slice of the budget.
    const top = await indexLibrary({ max: TOP_UP, budgetMs: Math.min(60_000, (opts.budgetMs ?? 120_000) / 3) }).catch(() => null);
    if (top && top.added) rows = await loadLibraryRows();
  } catch (e) {
    reportError('library-pick:load', e);
    why('the library index could not be read');
    return null;
  }
  if (!rows.length) { why('no photographs of the library have been read yet (it reads itself, thirty every twenty minutes)'); return null; }

  // The post's own pillar first (the planner's, or its words), then the
  // pillars the clinic's own rooms serve: a photograph of the clinic before a
  // generated picture, whatever the post is about.
  const planner = plannerImageFor(opts.pack);
  const own = [...(planner ? [planner.pillarId] : []), ...pillarsForText(textOf(opts.pack, opts.topic))];
  const pillars = [...own, ...GENERAL_PILLARS].filter((p, i, a) => a.indexOf(p) === i);

  const candidates = candidatesFrom(rows);
  const match = pickFresh(candidates, pillars, Date.now(), { exclude: opts.excludeFileId ? [opts.excludeFileId] : [] });
  if (!match || (opts.freshOnly && match.repeated)) {
    why(rows.length + ' photograph' + (rows.length === 1 ? '' : 's') + ' read, none the cover rules allow for this post (text, a procedure, a device on a person, or a patient without a release)');
    return null;
  }
  const row = rows.find((r) => r.file_id === match.id);
  if (!row) { why('the chosen photograph is no longer in the index'); return null; }
  if (Date.now() - started > (opts.budgetMs ?? 120_000) - 40_000) return null;

  try {
    const url = await libraryPhotoUrl(row);
    const made = await libraryHero({ url, title: Boolean(planner), pack: opts.pack, topic: opts.topic, brand: opts.brand, libraryFileId: row.file_id, libraryName: row.name });
    await touchLibraryUse(row.file_id);
    const notes = [...made.notes];
    if (match.repeated) notes.push('every photograph that fits this post was used in the last weeks, so the least recent one was taken');
    return { image: { ...made.image, alt: made.image.alt || row.caption || row.name }, match, notes };
  } catch (e) {
    reportError('library-pick:hero', e, { fileId: row.file_id });
    why('the photograph "' + row.name + '" could not be prepared (' + (e instanceof Error ? e.message : 'unknown error') + ')');
    return null;
  }
}
