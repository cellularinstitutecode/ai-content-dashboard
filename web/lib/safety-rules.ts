// web/lib/safety-rules.ts
// The advisory safety scan, as a pure module the test runner can read.
//
// These flags colour a card, cost a draft points, feed the rewrite critique —
// and under AUTOPILOT_AUTOSCHEDULE any one of them holds the post for a person.
// So a false positive is not free. The first version matched words, not
// meaning, and the weekly strategy's own vocabulary tripped it on most posts:
//
//   "How age, diagnosis, medications, and lifestyle influence planning"  → diagnosis
//   "If you have knee pain…"                                            → diagnosis
//   "about 20 g of protein at breakfast"                                → dosing
//   "Take a 20-minute walk daily"                                       → dosing
//   "Results are not guaranteed"                                        → cure claim
//
// The last is the one that mattered most: it is the exact disclaimer the
// strategy's editorial direction asks the writer for, and it was being scored
// down and critiqued away. And the REF line — a paper title with "diagnosed" in
// it, a protein study's "1.6 g/kg" — was scanned as if it were the post.
//
// So: the compliance lines are removed before scanning; a cure or guarantee
// word after a negation passes; "diagnosis" as a noun passes and only advice
// phrasing flags; and dosing means a dose — mg, mcg, IU, or "take N capsules" —
// not a food quantity.
//
// Pure: imports only ./compliance.ts (and, through it, ./health-claim.ts) —
// no package imports, so the test runner reads this file directly.
import { stripComplianceLines } from './compliance.ts';

export type SafetyFlag = {
  code: string;
  message: string;
};

/** Words that turn "a cure" into "not a cure". */
const NEGATORS = new Set([
  'not', 'no', 'never', 'without', 'cannot', "can't", 'cant', "isn't", 'isnt', "aren't", "won't", "don't",
  "doesn't", 'nor', 'neither', 'nothing', 'none',
]);

/** True when one of the three words before `index` in `text` negates what follows. */
export function negatedAt(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 48), index).toLowerCase().replace(/[’]/g, "'");
  const words = before.split(/[^a-z']+/).filter(Boolean).slice(-3);
  return words.some((w) => NEGATORS.has(w));
}

type Rule = { code: string; message: string; res: RegExp[]; negatable?: boolean };

const CONDITIONS =
  '(?:disease|disorder|syndrome|condition|deficiency|diabetes|cancer|arthritis|infection|inflammation|' +
  'autoimmune\\w*|hypothyroid\\w*|depression|anxiety|insomnia|sleep apnea|osteoporosis|neuropathy)';

// Each rule is advisory. Keep patterns conservative to limit false positives.
const RULES: Rule[] = [
  {
    code: 'cure_claim',
    message: 'Possible cure/guarantee claim - verify this is supportable.',
    res: [/\b(cure[sd]?|guarantee[sd]?|miracle|100%\s+effective|completely\s+heals?)\b/gi],
    negatable: true,
  },
  {
    code: 'dosing',
    message: 'Specific dosing/frequency detected - medical dosing should not be advised in marketing copy.',
    res: [
      /\b\d+(?:[.,]\d+)?\s?(mg|mcg|µg|iu)\b/gi,
      /\b(take|taking|dose|dosage|inject)\b[^.\n]{0,40}\b\d+(?:[.,]\d+)?\s?(g|ml)\b/gi,
      /\b(take|dose)\s+(\d+|one|two|three|four)\s+(capsules?|tablets?|pills?|drops?|scoops?|softgels?)\b/gi,
    ],
  },
  {
    code: 'regulatory_claim',
    message: 'Regulatory/clinical claim (e.g. FDA-approved, clinically proven) - confirm before publishing.',
    res: [/\b(fda[- ]approved|clinically proven|doctor[- ]recommended|scientifically proven)\b/gi],
    negatable: true,
  },
  {
    code: 'diagnosis',
    message: 'Diagnostic/treatment-advice phrasing - keep copy general and defer to professionals.',
    res: [
      /\b(we|our (team|doctors?|physicians?)) (can |will )?diagnose\b/gi,
      /\bdiagnose (yourself|your)\b/gi,
      /\bself[- ](diagnos|medicat)/gi,
      /\btreat your\b/gi,
      new RegExp('\\byou (have|may have|probably have|likely have|are suffering from) (an? )?(\\w+ )?' + CONDITIONS + '\\b', 'gi'),
    ],
    // "Never self-medicate" and "don't diagnose yourself" are the advice this
    // rule exists to protect, not a breach of it.
    negatable: true,
  },
];

function ruleHits(rule: Rule, text: string): boolean {
  for (const re of rule.res) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!rule.negatable || !negatedAt(text, m.index)) return true;
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return false;
}

// Scan a single string; returns any advisory flags that matched.
export function scanContent(text: string): SafetyFlag[] {
  if (!text) return [];
  const body = stripComplianceLines(text);
  const out: SafetyFlag[] = [];
  for (const rule of RULES) {
    if (ruleHits(rule, body)) out.push({ code: rule.code, message: rule.message });
  }
  return out;
}

// Review every field of a generated pack; returns a deduped list of advisories.
export function reviewPack(pack: Record<string, unknown>): SafetyFlag[] {
  const seen = new Set<string>();
  const out: SafetyFlag[] = [];
  for (const value of Object.values(pack || {})) {
    if (typeof value !== 'string') continue;
    for (const f of scanContent(value)) {
      if (!seen.has(f.code)) {
        seen.add(f.code);
        out.push(f);
      }
    }
  }
  return out;
}
