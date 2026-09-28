// web/lib/recent-openers.ts
// The opening lines the clinic has already published, so the next post can
// avoid repeating them.
//
// No migration for this. `drafts.pack` is jsonb holding the full generated pack
// and `drafts.created_at` orders it, so every caption this pipeline has ever
// written is already stored, per user — which matters, because the last thing
// this deployment needs is another .sql file waiting to be pasted into the
// Supabase editor before a feature starts working.
//
// Fail-open, always. A caption that repeats last week's opening is a small
// problem; a video that will not prepare because a style lookup failed is a
// bigger one. Every error path here returns an empty list, which switches the
// check off rather than blocking the row.
import 'server-only';

import { openingLookBack } from '@/lib/cadence';
import { openingsFrom } from '@/lib/opening-line';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

/**
 * How many recent posts to look back over.
 *
 * Derived rather than typed in. It was 12, which was a comfortable fortnight
 * when a pair of reels was all that published — and about four hours once the
 * weekly strategy added fourteen posts a week on top. The guard that measures
 * the finished copy (`repeatsOpening`, lib/video-prepare.ts) reads this whole
 * list, so a window narrower than the cadence means last week's opening is
 * already out of sight when this week's slot comes round.
 *
 * lib/cadence.ts holds the arithmetic, so adding a slot widens the window
 * instead of silently shrinking it.
 */
const LOOK_BACK = openingLookBack();

/**
 * The last few opening lines this account has published, newest first.
 *
 * Deduplicated: if three posts already open the same way, showing the writer
 * that sentence three times spends tokens to say one thing, and makes the
 * repeated shape look like the house style rather than the thing to avoid.
 *
 * `excludeDraftId`: the draft being scored, which is among the recent ones by
 * then. It is dropped before de-duplicating (lib/opening-line.ts openingsFrom).
 */
export async function recentOpenings(
  userId: string,
  limit = LOOK_BACK,
  opts: { excludeDraftId?: string | null } = {},
): Promise<string[]> {
  if (!userId) return [];
  try {
    const { data, error } = await supabaseAdmin()
      .from('drafts')
      .select('id, pack')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    // supabase-js RESOLVES a failed query rather than throwing, so an unchecked
    // `error` here would read as "this account has never published" — and the
    // writer would be told nothing is off limits.
    if (error) { reportError('recent-openings', error); return []; }

    return openingsFrom((data || []) as { id?: unknown; pack?: unknown }[], opts.excludeDraftId);
  } catch (e) {
    reportError('recent-openings', e);
    return [];
  }
}
