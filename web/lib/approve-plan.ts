// web/lib/approve-plan.ts
// What an approved Autopilot run sends, network by network.
//
// WHY. approveRun picked ONE text — the Instagram caption — and sent it to
// every network in a single Metricool post. The writer had produced a
// Facebook post and a LinkedIn post in their own voice and length; the scorer
// graded them and the review card showed them in their own tabs; then they
// were thrown away, and LinkedIn received an Instagram caption with its
// hashtags. The Content Generator's own scheduler (components/SchedulePack.tsx)
// has sent one post per network with that network's own words for a long time;
// this brings the engine's Approve to the same rule.
//
// Everything that can refuse is decided here, for every network, BEFORE the
// first one is sent: a refusal is a refusal, never a half-send.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { appliesTo, checkCompliance, complianceMessage, ensureAviso, type RefPolicy } from './compliance.ts';
import { fitsNetwork } from './video-row.ts';

export type NetworkSend = { network: string; text: string };

export type NetworkPlan =
  | { ok: true; sends: NetworkSend[] }
  | { ok: false; network: string; reason: string };

function label(network: string): string {
  const n = String(network || '');
  return n === 'linkedin' ? 'LinkedIn' : n === 'tiktok' ? 'TikTok' : n === 'youtube' ? 'YouTube' : n.charAt(0).toUpperCase() + n.slice(1);
}

/**
 * The copy written for `network`. A network the writer does not write for
 * (TikTok, YouTube, X) takes the Instagram caption, the closest fit — which
 * is what every network used to get.
 */
export function channelCopy(pack: Record<string, unknown> | null | undefined, network: string): string {
  const p = (pack || {}) as Record<string, unknown>;
  const key = network === 'twitter' ? 'instagram' : network;
  const pick = (k: string) => (typeof p[k] === 'string' ? String(p[k]) : '');
  return pick(key) || pick('instagram') || pick('blog');
}

/**
 * One send per network, each with its own copy, AVISO stamped where the
 * advertising rule applies. Refuses — naming the network — when any one of
 * them has no copy, is too long for its network, or fails the rule.
 */
export function perNetworkPlan(
  pack: Record<string, unknown> | null | undefined,
  networks: readonly string[],
  opts: { aviso?: string | null; transform?: (network: string, text: string) => string; refPolicy?: RefPolicy } = {},
): NetworkPlan {
  const sends: NetworkSend[] = [];
  for (const network of networks) {
    let text = channelCopy(pack, network).trim();
    if (!text) return { ok: false, network, reason: 'The draft has no copy for ' + label(network) + '.' };
    // e.g. the weekly article's link, written in before the checks so the
    // length and the advertising rule are measured on what is actually sent.
    if (opts.transform) text = opts.transform(network, text).trim();
    if (appliesTo([network])) {
      text = ensureAviso(text, opts.aviso);
      const check = checkCompliance(text, opts.aviso, { refPolicy: opts.refPolicy });
      if (!check.ok) return { ok: false, network, reason: complianceMessage(check, [network]) };
    }
    const fit = fitsNetwork(network, text);
    if (!fit.ok) {
      return { ok: false, network, reason: 'The ' + label(network) + ' copy is ' + (fit.length - fit.limit).toLocaleString('en-US') + ' characters over its limit of ' + fit.limit.toLocaleString('en-US') + '.' };
    }
    sends.push({ network, text });
  }
  return { ok: true, sends };
}

/** The DOIs the sends actually carry, lower-cased and de-duplicated. */
export function doisIn(sends: readonly NetworkSend[]): string[] {
  const out = new Set<string>();
  for (const s of sends) {
    const doi = checkCompliance(s.text).doi;
    if (doi) out.add(doi.toLowerCase());
  }
  return [...out];
}

/**
 * A citation Crossref already said does not exist must not go out on a
 * person's Approve with nobody told. The stamp is the generator's verdict on
 * the DOI it saw; a reviewer who has since edited the REF to a different DOI
 * gets that one checked by the caller instead.
 */
export function knownBadCitation(
  stamp: { citation?: { status?: string | null; doi?: string | null } | null } | null | undefined,
  sends: readonly NetworkSend[],
): string | null {
  const c = stamp?.citation;
  if (!c || c.status !== 'not_found' || !c.doi) return null;
  const bad = String(c.doi).toLowerCase();
  return doisIn(sends).includes(bad) ? String(c.doi) : null;
}
