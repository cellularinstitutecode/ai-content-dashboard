// web/lib/safety.ts
// Content-safety layer for the medical / health domain (Cellular Hope Institute).
//
// Two responsibilities:
//   1. Prompt-side steering: MEDICAL_SAFETY_GUARDRAILS is appended to the system
//      prompt so generated copy avoids diagnosis, dosing, cure/guarantee claims,
//      and always defers to qualified professionals.
//   2. Output-side advisory: scanContent / reviewPack flag risky phrasing AFTER
//      generation. This is ADVISORY ONLY - it never blocks or edits content, so a
//      false positive can't break the product. Reviewers decide what to do.
import 'server-only';

/**
 * Nobody is named. Ever.
 *
 * This is here because a post went out reading "As our patient Rodrigo shares:" over a
 * quote from a video. Rodrigo uploads the videos. He is not a patient, he did not say it
 * as one, and no instruction anywhere told the writer not to do that — the prompt handed
 * over the raw file name, "Reel_FloatingBedRyall_Rodrigo", and the model bridged a human
 * name in the title to an unattributed line in the speech.
 *
 * A clinic inventing a patient testimonial is not a style defect. The words themselves
 * were usually fine; the attribution was fabricated. So quoting stays and naming goes:
 * "As one patient put it" is what the clinic's own writer has always done.
 */
export const NAMING_RULE =
  ' Never name or identify any individual. Do not state or imply that any named person is' +
  ' a patient, doctor, staff member or customer, and do not describe anyone in a way that' +
  ' would identify them. A line spoken in the source may be quoted, but only' +
  ' unattributed — "As one patient put it: …". Names in a file name, a title or a' +
  ' transcript are production metadata or third parties, never subjects to write about,' +
  ' and no name from any of them may appear in the copy.';

export const MEDICAL_SAFETY_GUARDRAILS =
  ' Safety rules (health/medical context): Do not diagnose, prescribe, or give' +
  ' specific dosing or treatment instructions. Do not promise cures, guaranteed' +
  ' outcomes, or claim a product/therapy is FDA-approved or clinically proven — not' +
  ' even if a source says so; a speaker on a video making that claim is not a licence to' +
  ' print it. Avoid fear-based or exploitative appeals' +
  ' toward patients or vulnerable groups. Encourage readers to consult a qualified' +
  ' healthcare professional for personal medical decisions. Keep claims general,' +
  ' evidence-aware, and non-alarmist.' +
  NAMING_RULE;


export type SafetyFlag = {
  code: string;
  message: string;
};

// Each rule is advisory. Keep patterns conservative to limit false positives.
const RULES: { code: string; message: string; re: RegExp }[] = [
  {
    code: 'cure_claim',
    message: 'Possible cure/guarantee claim - verify this is supportable.',
    re: /\b(cure[sd]?|guaranteed?|miracle|100%\s+effective|completely\s+heals?)\b/i,
  },
  {
    code: 'dosing',
    message: 'Specific dosing/frequency detected - medical dosing should not be advised in marketing copy.',
    re: /\b\d+\s?(mg|mcg|ml|g|iu)\b|\b(take|dose)\b[^.]{0,40}\b(daily|twice|per day|every\s+\d+)\b/i,
  },
  {
    code: 'regulatory_claim',
    message: 'Regulatory/clinical claim (e.g. FDA-approved, clinically proven) - confirm before publishing.',
    re: /\b(fda[- ]approved|clinically proven|doctor[- ]recommended|scientifically proven)\b/i,
  },
  {
    code: 'diagnosis',
    message: 'Diagnostic/treatment-advice phrasing - keep copy general and defer to professionals.',
    re: /\b(diagnos(e|is|ed)|you (have|are suffering from)|treat your\b|self[- ]medicat)/i,
  },
];

// Scan a single string; returns any advisory flags that matched.
export function scanContent(text: string): SafetyFlag[] {
  if (!text) return [];
  const out: SafetyFlag[] = [];
  for (const rule of RULES) {
    if (rule.re.test(text)) out.push({ code: rule.code, message: rule.message });
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
