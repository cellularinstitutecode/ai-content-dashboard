// web/lib/network-copy.ts
// Which words go to which network, once a video's copy is written.
//
// The writer produces two texts per video: the long, insight-led post and the
// short caption with the hashtags (lib/video-prepare.ts). LinkedIn gets the
// first and TikTok and Instagram the second — they were written for those
// feeds. Facebook, X and YouTube were getting one of the two unchanged, which
// is how a 1,000-character LinkedIn post was handed to X's 280-character box
// and refused every time, and a hashtag-ended TikTok caption became a YouTube
// description.
//
// Now a network ticked on the row that has no copy of its own gets one WRITTEN
// for it, from the copy already checked for claims and citations: the brief
// for each is below, the model call is lib/ai.ts tailorCopy, and the
// assembly — one AVISO line, the verified REF, hashtags last — is here.
//
// Pure, so the selection rule and the X assembly are unit-tested; the server
// half (lib/video-tailor.ts) supplies the model and the permit number.
import { NETWORK_LIMITS } from './composer.ts';
import { composeCaption, withCitation } from './video-copy.ts';

/** The two texts every prepared video has, plus any written for one network. */
export type CopyVariants = {
  linkedin: string;
  tiktok: string;
  /** Copy written for one network, keyed by Metricool's id ('twitter' for X). */
  tailored?: Partial<Record<string, string>> | null;
};

/** Networks that get copy of their own rather than another feed's. */
export const TAILORED_NETWORKS: readonly string[] = ['facebook', 'twitter', 'youtube'];

/**
 * The text a network is sent.
 *
 * Its own, when one was written; otherwise the mapping the hand-off has always
 * used — the long post for LinkedIn and X, the short caption for the rest — so
 * a tailoring that could not be made (no time, no model, the answer rejected)
 * costs nothing that was not already the case.
 */
export function copyForNetwork(network: string, v: CopyVariants): string {
  const n = String(network || '').toLowerCase();
  const own = v.tailored?.[n];
  if (typeof own === 'string' && own.trim()) return own;
  return n === 'linkedin' || n === 'twitter' ? v.linkedin : v.tiktok;
}

/** The networks among `chosen` still owed their own copy. */
export function networksToTailor(chosen: readonly string[], tailored?: Partial<Record<string, string>> | null): string[] {
  const out: string[] = [];
  for (const raw of chosen) {
    const n = String(raw || '').toLowerCase();
    if (!TAILORED_NETWORKS.includes(n)) continue;
    const have = tailored?.[n];
    if (typeof have === 'string' && have.trim()) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** Which of the two source texts a network's copy is written from. */
export function tailorSource(network: string, v: { linkedin: string; tiktok: string }): string {
  return String(network || '').toLowerCase() === 'youtube' ? v.linkedin : v.tiktok;
}

/** Proper names, for the brief. */
const NETWORK_NAME: Record<string, string> = { facebook: 'Facebook', twitter: 'X (formerly Twitter)', youtube: 'YouTube' };

/**
 * What each network wants, told to the model as an editor's brief.
 *
 * Every brief says the same three things first: nothing new may be claimed,
 * nobody may be named, and the REF and AVISO lines come back exactly as they
 * were. The assembly below re-stamps both lines anyway, so a model that drops
 * one costs nothing — but a model told to keep them is far less likely to
 * rewrite the sentence next to them.
 */
const BRIEF: Record<string, string> = {
  facebook: [
    'Rewrite it as a Facebook post: conversational and warm, 60-120 words, written to a person rather than an audience.',
    'Open with the one thing a reader would stop for, keep two or three short paragraphs, and end with a question or a gentle invitation to ask the clinic.',
    'At most two hashtags, on the last line, or none at all.',
  ].join(' '),
  twitter: [
    'Rewrite it as ONE post for X: at most 200 characters in total, counting spaces, before the REF and AVISO lines.',
    'One or two plain sentences that say the single most useful point in the source. No thread, no numbering, no emojis, no hashtags.',
    'Then put the REF line and the AVISO DE PUBLICIDAD line back exactly as they were in the source, each on its own line.',
  ].join(' '),
  youtube: [
    'Rewrite it as a YouTube video description: a first line of at most 100 characters that says what the video shows (it is what search results display), a blank line, then two to four short paragraphs that tell a viewer what they will learn and why it matters, in plain language.',
    'Up to about 1,200 characters in total. Work in the subject’s own words naturally; do not stuff keywords.',
    'Keep any "Watch:" line. At most three hashtags, on the last line.',
  ].join(' '),
};

export const TAILOR_SYSTEM = [
  'You adapt an approved social post for a regenerative-medicine clinic to another network. The post has already been checked: every statement in it is backed by the study in its REF line.',
  'Say only what the source says. Do not add a benefit, an outcome, a number, a mechanism, a therapy, a comparison or a promise that is not in the source, and do not make what it says stronger.',
  'Do not name any person. Do not address a patient by name. Do not invent a quote.',
  'Keep the REF / REFERENCIA line and the AVISO DE PUBLICIDAD line exactly as they appear in the source, each on its own line. Do not add a second one of either.',
  'Write in the language of the source.',
  'Answer with the adapted post and nothing else — no title, no preamble, no explanation, no code fence.',
].join('\n');

export function tailorPrompt(network: string, source: string, title?: string | null): string {
  const n = String(network || '').toLowerCase();
  const brief = BRIEF[n] || ('Rewrite it for ' + (NETWORK_NAME[n] || n) + ', keeping every fact and both compliance lines.');
  return 'TARGET NETWORK: ' + (NETWORK_NAME[n] || n) + '\n' +
    (title ? 'VIDEO TITLE: ' + String(title).trim() + '\n' : '') +
    'BRIEF: ' + brief + '\n\n' +
    'THE SOURCE POST\n' + String(source || '').trim();
}

/**
 * The model's answer, or null when it is not one to send.
 *
 * Code fences are stripped; an empty answer, one that is the source back
 * unchanged, or one that has grown past any brief above is refused and the
 * caller falls back to the mapping copyForNetwork has always used.
 */
export function acceptTailored(network: string, source: string, answer: unknown): string | null {
  let out = String(answer ?? '').trim();
  out = out.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '').trim();
  const before = String(source || '').trim();
  if (!out || !before) return null;
  if (out === before) return null;
  // A refusal or an explanation is a short paragraph of prose about the post;
  // the signs are the ones the other editors in this codebase watch for.
  if (/^(i\s+(cannot|can't|am unable)|sorry|as an ai)/i.test(out)) return null;
  const n = String(network || '').toLowerCase();
  const ceiling = n === 'twitter' ? 600 : n === 'youtube' ? 2400 : 1600;
  if (out.length > ceiling) return null;
  return out;
}

/**
 * The X post, assembled inside the 280-character box.
 *
 * The AVISO line is always kept — a clinic's advertisement carries its permit
 * wherever it runs. The REF line is kept when the whole post still fits and
 * dropped when it does not: X is outside the compliance gate (lib/compliance.ts
 * SOCIAL_NETWORKS), and 280 characters cannot hold a sentence, a permit and a
 * DOI every time. Null when even the permit line does not fit, and the caller
 * then leaves X exactly as it was.
 */
export function assembleXPost(body: string, ref: string | null | undefined, aviso: string | null | undefined): string | null {
  const limit = NETWORK_LIMITS.twitter ?? 280;
  const text = String(body || '').trim();
  if (!text) return null;
  const cited = withCitation(text, ref, aviso);
  if (cited.length <= limit) return cited;
  // withCitation with no reference strips the REF line and re-stamps the notice.
  const bare = withCitation(text, '', aviso);
  return bare.length <= limit ? bare : null;
}

/**
 * The Facebook or YouTube copy, carrying the verified citation and one notice.
 *
 * withCitation REPLACES the REF line rather than trusting the model to have
 * kept it, for the reason lib/video-prepare.ts gives: the same post, the same
 * claims, the same citation on every network.
 */
export function assembleGatedPost(body: string, ref: string | null | undefined, aviso: string | null | undefined): string | null {
  const text = String(body || '').trim();
  if (!text) return null;
  return ref ? withCitation(text, ref, aviso) : composeCaption(text, aviso);
}
