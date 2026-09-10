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

import { openingLineOf } from '@/lib/opening-line';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

/** How many recent posts to look back over. */
const LOOK_BACK = 12;

type DraftRow = { pack?: unknown };

/**
 * Pull the opening line out of whichever variant a pack carries.
 *
 * `tiktok` first: prepareVideo stores the COMPOSED caption there — the one
 * composeCaption assembled and the one writeRowBack puts in column E — whereas
 * `instagram` is the writer's raw output before the REF, the AVISO and the
 * hashtags were sorted out. Their first sentences agree today, and reading the
 * field that is actually published is the one that stays right if they ever
 * stop agreeing. The rest are fallbacks so an older pack shape still yields
 * something.
 */
function openingFrom(pack: unknown): string {
  if (!pack || typeof pack !== 'object') return '';
  const p = pack as Record<string, unknown>;
  for (const key of ['tiktok', 'instagram', 'facebook', 'linkedin']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) {
      const line = openingLineOf(v);
      if (line) return line;
    }
  }
  return '';
}

/**
 * The last few opening lines this account has published, newest first.
 *
 * Deduplicated: if three posts already open the same way, showing the writer
 * that sentence three times spends tokens to say one thing, and makes the
 * repeated shape look like the house style rather than the thing to avoid.
 */
export async function recentOpenings(userId: string, limit = LOOK_BACK): Promise<string[]> {
  if (!userId) return [];
  try {
    const { data, error } = await supabaseAdmin()
      .from('drafts')
      .select('pack')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    // supabase-js RESOLVES a failed query rather than throwing, so an unchecked
    // `error` here would read as "this account has never published" — and the
    // writer would be told nothing is off limits.
    if (error) { reportError('recent-openings', error); return []; }

    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of (data || []) as DraftRow[]) {
      const line = openingFrom(row.pack);
      if (!line) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
  } catch (e) {
    reportError('recent-openings', e);
    return [];
  }
}
