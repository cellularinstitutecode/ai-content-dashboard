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

export const MEDICAL_SAFETY_GUARDRAILS =
  ' Safety rules (health/medical context): Do not diagnose, prescribe, or give' +
  ' specific dosing or treatment instructions. Do not promise cures, guaranteed' +
  ' outcomes, or claim a product/therapy is FDA-approved or clinically proven unless' +
  ' that is explicitly provided in the brief. Avoid fear-based or exploitative appeals' +
  ' toward patients or vulnerable groups. Encourage readers to consult a qualified' +
  ' healthcare professional for personal medical decisions. Keep claims general,' +
  ' evidence-aware, and non-alarmist.';

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
