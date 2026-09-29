// web/lib/clip-relevance.ts
// May a finished clip ride on this post, or does the post keep its picture?
//
// The clip matcher accepts any clip sharing one word longer than three letters
// with the angle, so an "Infusion Administration Guide" clip could go out on a
// sleep or nutrition post. For a run whose angle comes from the weekly
// strategy or a pillar rotation, a clip is attached only when its words share
// real ground with the post's pillar and angle; otherwise the hero image goes.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { isStrategySlot, pillarForStrategy } from './strategy-voice.ts';

export type ClipText = { title?: unknown; text?: unknown; description?: unknown; hashtags?: unknown };
export type PostTopic = { pillar?: string | null; seedTopic?: string | null; query?: string | null };
export type StoredClip = { url: string; title: string; relevant?: boolean };

/** Words that say nothing about a topic (English and Spanish). */
const GENERIC = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'your', 'you', 'our', 'this', 'that', 'what', 'when', 'why', 'how', 'who',
  'are', 'was', 'can', 'does', 'more', 'most', 'about', 'after', 'before', 'during', 'than', 'time', 'times', 'day', 'days',
  'week', 'guide', 'tips', 'tip', 'best', 'way', 'ways', 'things', 'thing', 'really', 'every', 'need', 'know', 'should',
  'para', 'con', 'por', 'los', 'las', 'del', 'una', 'que', 'como', 'tus', 'sus', 'mas', 'sobre', 'antes', 'despues',
  'clinic', 'cellular', 'institute', 'patient', 'patients', 'health', 'healthy', 'body', 'video', 'clip', 'reel', 'shorts',
]);

/** A text as topic words: lower case, no accents or punctuation, generic words dropped. */
export function topicWords(...texts: unknown[]): string[] {
  const plain = texts.map((t) => String(t ?? '')).join(' ')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  return [...new Set(plain.split(' ').filter((w) => w.length >= 4 && !GENERIC.has(w)))];
}

/** Same word, allowing for an ending ("supplement" / "supplementation"). */
function sameWord(a: string, b: string): boolean {
  return a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
}

function shared(a: readonly string[], b: readonly string[]): string[] {
  return a.filter((w) => b.some((v) => sameWord(w, v)));
}

/**
 * Does the clip share meaningful ground with the post?
 *
 * At least one word with the pillar, and at least two topic words in all
 * with the pillar and the angle together.
 */
export function clipRelevant(clip: ClipText, post: PostTopic): boolean {
  const clipWords = topicWords(clip.title, clip.text, clip.description, clip.hashtags);
  if (!clipWords.length) return false;
  const pillarWords = topicWords(post.pillar, post.seedTopic);
  const postWords = topicWords(post.pillar, post.seedTopic, post.query);
  return shared(pillarWords, clipWords).length >= 1 && shared(postWords, clipWords).length >= 2;
}

type StrategyLike = { seeded?: unknown; mode?: unknown; pillars?: unknown; pillarId?: unknown; slot?: unknown; [key: string]: unknown } | null | undefined;

/** Does this template's angle come from the weekly strategy or a pillar rotation? */
export function usesPillarRotation(strategy: StrategyLike): boolean {
  if (isStrategySlot(strategy)) return true;
  return String(strategy?.mode || '') === 'pillars' && Array.isArray(strategy?.pillars) && strategy.pillars.length > 0;
}

/** The pillar the post is written for: the strategy's own, else the rotation's seed topic. */
export function pillarOf(strategy: StrategyLike, templateName: unknown, seedTopic: unknown): string {
  const named = isStrategySlot(strategy) ? pillarForStrategy(strategy, templateName)?.name : null;
  return String(named || seedTopic || '');
}

/**
 * The clip approve may attach, or null for the hero image.
 *
 * Unchanged for templates outside the rotation. Inside it, a clip matched
 * under the relevance rule (`relevant`) goes; a clip stored before the rule
 * existed goes only if its title alone passes it.
 */
export function attachableClip(
  angle: { media?: StoredClip | null; query?: unknown; seedTopic?: unknown } | null | undefined,
  strategy: StrategyLike,
  templateName: unknown,
): StoredClip | null {
  const media = angle?.media;
  if (!media?.url) return null;
  // The weekly strategy is text with a single image — the clinic's chosen
  // format — so its posts never carry a clip, however relevant. A stored clip
  // on an older run is ignored rather than shipped over the post's picture.
  if (isStrategySlot(strategy)) return null;
  if (!usesPillarRotation(strategy)) return media;
  if (media.relevant === true) return media;
  const post = { pillar: pillarOf(strategy, templateName, angle?.seedTopic), seedTopic: String(angle?.seedTopic || ''), query: String(angle?.query || '') };
  return clipRelevant({ title: media.title }, post) ? media : null;
}
