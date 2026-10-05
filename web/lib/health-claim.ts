// web/lib/health-claim.ts
// Does this post say something about health that a study would have to back?
//
// WHY. The advertising rule makes every Instagram, Facebook and LinkedIn post
// carry a REF line citing a peer-reviewed study. For the weekly strategy's
// destination posts — "Air connectivity from the United States and Canada",
// "Hotel, dining, and low-impact activity options", "What a companion can do
// during the trip" — no study supports what the post says, so the writer cited
// a loosely related paper, or reached for a health claim so it could cite one.
// The clinic decided: those posts cite a study only when they make a health
// claim (lib/content-strategy.ts citation policy). This decides whether one did.
//
// A CLAIM IS AN ASSERTION, NOT A TOPIC. The first version counted any body
// word, condition, therapy or evidence word — "cells", "protocol",
// "diagnostics", "stem cell therapy" — so a reel asking what questions to put
// to a clinic ("Is it simply an injection? What type of cells are being
// used? Is there a personalized protocol built around your condition?") was
// held for a citation it had nothing to cite. The clinic's rule is about what
// a post ASSERTS: that something heals, improves, reduces, prevents, is safe,
// works, or that studies show it. Naming a therapy, a condition or a part of
// the body is not a claim; saying what it does to the body is.
//
// Still conservative where it matters: every effect verb counts whether it is
// said flat or hedged ("can help the body recover", "may reduce"), a number
// with a percent sign counts, "safe" counts, and any appeal to studies,
// research, evidence or proof counts. When unsure on THOSE, yes.
//
// Pure: imports only ./compliance.ts, which imports this file back. The cycle is
// safe: each uses the other only inside function bodies, never at load time.
import { stripComplianceLines } from './compliance.ts';

const HEALTH_CLAIM = new RegExp(
  '(' + [
    // EFFECTS AND OUTCOMES, asserted of the body or a condition.
    '\\bheal(s|ing|ed)?\\b', '\\bimprov\\w*', '\\breduc\\w*', '\\blower(s|ing|ed)?\\b', '\\bboost\\w*', '\\bprevent\\w*', '\\bprotect\\w*',
    '\\brelie\\w*', '\\brestor\\w*', '\\bstrengthen\\w*', '\\benhanc\\w*', '\\bspeed(s)? up\\b', '\\bfaster\\b', '\\bbenefit\\w*', '\\beffective\\w*',
    '\\bpromot\\w*', '\\bstimulat\\w*', '\\boptimi[sz]\\w*', '\\balleviat\\w*', '\\brevers\\w*', '\\beliminat\\w*', '\\bcure[sd]?\\b', '\\bcuring\\b',
    '\\bregenerat(e|es|ed|ing)\\b', '\\brepair(s|ed|ing)?\\b', '\\brecover(s|ed|ing)?\\b', '\\brejuvenat\\w*', '\\brebuild\\w*', '\\bslow(s|ed|ing)? (down )?(aging|ageing)\\b',
    // "treats arthritis", never "treatment"; "works for", "helps with".
    '\\btreat(s|ed|ing)?\\b', '\\bworks? (for|on|against)\\b', '\\bhelps? (with|against)\\b', '\\bhelp(s|ed|ing)? (the body|your body|you|patients?|people)\\b',
    // "supports circulation", not "our support team".
    '\\bsupport(s|ing|ed)? (?!team|desk|staff|line|services?|you with the trip)',
    // SAFETY AND RESULTS.
    '\\bsafe(ly|r|st|ty)?\\b', '\\bside[- ]effects?\\b', '\\brisk[- ]free\\b', '\\bsuccess rate\\b', '\\bguarantee\\w*', '\\d+\\s?%', '\\bpercent\\b',
    // EVIDENCE TALK.
    '\\bstud(y|ies)\\b', '\\bresearch\\w*', '\\bevidence\\b', '\\bscien(ce|tific|tists?)\\b', '\\bproven\\b', '\\bclinical(ly)? (trial|data|evidence|results?)\\b',
    '\\bpeer[- ]reviewed\\b', '\\bpublished\\b', '\\baccording to\\b', '\\bdoctors? (say|recommend|agree)\\b',
  ].join('|') + ')',
  'i',
);

/** The post as a reader reads it: no REF, no AVISO, no hashtags. */
function bodyOf(text: string): string {
  return stripComplianceLines(text)
    .split('\n')
    .filter((l) => !/^\s*(#\S+\s*)+$/.test(l))
    .join('\n')
    // The clinic's own name is not a claim. "Cellular" in it read as one, so a
    // logistics post that named the team — as the writer is told to, once —
    // lost its citation waiver and was refused at approval.
    .replace(/\bcellular\s+(hope\s+)?institute\b/gi, ' ');
}

/**
 * The words that made a post read as a health claim, each once, as written —
 * so a rewrite that has to claim nothing can be told exactly what to replace.
 */
export function healthClaimWords(text: string): string[] {
  const body = bodyOf(String(text || ''));
  const all = new RegExp(HEALTH_CLAIM.source, 'gi');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(all)) {
    const w = m[0];
    if (!seen.has(w.toLowerCase())) { seen.add(w.toLowerCase()); out.push(w); }
  }
  return out;
}

/** True when the post says anything a study would have to back. When unsure: true. */
export function makesHealthClaim(text: string): boolean {
  const body = bodyOf(String(text || ''));
  if (!body.trim()) return false;
  return HEALTH_CLAIM.test(body);
}
