// web/lib/pack-schedule.ts
// One generated pack -> one scheduled post per network, each with its own words.
//
// WHAT THIS REPLACES. The Content Generator wrote a pack — an Instagram
// caption, a Facebook post, a LinkedIn post, each in its own voice and length —
// and then the only way to schedule any of it was to copy one of them into the
// composer by hand. The composer sends THE SAME TEXT to every network it is
// given, so scheduling all three meant three trips, and whichever variant was
// pasted went out on all of them.
//
// "If I approve, it separates the paragraphs, it gives images to the platforms
//  that need them, it gets everything ready and submits it for posting."
//
// So this turns the pack into a plan: which network gets which variant, whether
// that variant fits, whether it carries the two lines a medical advertisement
// needs, and whether it has the image the network will refuse to post without.
// Nothing is sent until every selected row is ready — the same gate the video
// path applies, before anything reaches Metricool rather than after.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { appliesTo, checkCompliance } from './compliance.ts';
import { fitsNetwork } from './video-row.ts';

/**
 * Which key of a pack each network posts.
 *
 * Only what the writer actually produces. `blog` is in every pack and is not a
 * network — it is an article, and putting 400 words of it on Instagram is how a
 * pack becomes spam. X is absent for the same reason: nothing writes a
 * 280-character variant, and trimming one of the others is not writing.
 */
export const PACK_NETWORKS = [
  { network: 'instagram', key: 'instagram' },
  { network: 'facebook', key: 'facebook' },
  { network: 'linkedin', key: 'linkedin' },
] as const;

export type PackPlan = {
  network: string;
  /** The words this network gets — its own variant, never another's. */
  text: string;
  length: number;
  limit: number;
  fits: boolean;
  /** Instagram will not take a post with no picture at all. */
  needsMedia: boolean;
  hasMedia: boolean;
  /** 'ok' | 'missing' when the advertising rule covers this network, else 'n/a'. */
  compliance: 'ok' | 'missing' | 'n/a';
  missing: string[];
  /** Everything above, in one word: can this row be sent? */
  ready: boolean;
  /** Why not, in a sentence, when it cannot. */
  problem: string;
};

/** Networks that cannot take a text-only post. Same set as lib/composer.ts. */
const NEEDS_MEDIA = new Set(['instagram', 'youtube', 'tiktok']);

function label(network: string): string {
  return network.charAt(0).toUpperCase() + network.slice(1);
}

/**
 * The plan for one pack.
 *
 * `mediaUrl` is the hero image the generator already made and saved on the
 * draft — the one that was only ever "attaches when you schedule", with nothing
 * on the screen that scheduled it.
 */
export function planFromPack(
  pack: Record<string, unknown> | null | undefined,
  opts: { mediaUrl?: string | null; avisoNumber?: string | null } = {},
): PackPlan[] {
  const media = String(opts.mediaUrl || '').trim();
  const out: PackPlan[] = [];
  for (const { network, key } of PACK_NETWORKS) {
    const raw = (pack || {})[key];
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) continue;

    const fit = fitsNetwork(network, text);
    const needsMedia = NEEDS_MEDIA.has(network);
    const hasMedia = Boolean(media);
    const covered = appliesTo([network]);
    const check = covered ? checkCompliance(text, opts.avisoNumber ?? undefined) : null;
    const missing = check ? check.missing.slice() : [];
    const compliance: PackPlan['compliance'] = !covered ? 'n/a' : (missing.length ? 'missing' : 'ok');

    // In the order a person would fix them: the post cannot exist without its
    // picture, cannot be sent if it is too long, and must not be published
    // without the two lines.
    const problem = needsMedia && !hasMedia
      ? label(network) + ' will not take a post without an image.'
      : !fit.ok
        ? 'Too long for ' + label(network) + ' by ' + (fit.length - fit.limit).toLocaleString() + ' characters.'
        : compliance === 'missing'
          ? 'Missing ' + missing.join(' and ') + ' — this network carries the advertising notice and a citation.'
          : '';

    out.push({
      network,
      text,
      length: fit.length,
      limit: fit.limit,
      fits: fit.ok,
      needsMedia,
      hasMedia,
      compliance,
      missing,
      ready: !problem,
      problem,
    });
  }
  return out;
}

/** Can this selection be sent, and if not, what is the first thing to fix? */
export function scheduleReady(
  plans: readonly PackPlan[],
  chosen: readonly string[],
  when: string | null | undefined,
): { ok: boolean; reason: string } {
  const picked = plans.filter((p) => chosen.includes(p.network));
  if (!picked.length) return { ok: false, reason: 'Pick at least one channel.' };
  if (!String(when || '').trim()) return { ok: false, reason: 'Pick when it should go out.' };
  const bad = picked.find((p) => !p.ready);
  if (bad) return { ok: false, reason: bad.problem };
  return { ok: true, reason: '' };
}
