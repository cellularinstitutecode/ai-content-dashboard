// web/lib/compliance-gate.ts
// The server-side door for the advertising rule (lib/compliance.ts): what
// every route that can put an Instagram/Facebook post on the road to Metricool
// calls before it does. One function, so "Send for review", "Approve",
// "Publish now" and Autopilot's approve cannot drift apart.
import 'server-only';

import { appliesTo, avisoNumberFor, checkCompliance, complianceMessage, type ComplianceCheck, type RefPolicy } from '@/lib/compliance';
import { claimSupportRefusal } from '@/lib/citation-gate';
import { supabaseAdmin } from '@/lib/supabase-admin';

export type GateResult = {
  /** True when the post may proceed (rule satisfied, or rule not applicable). */
  ok: boolean;
  /** Whether the rule applied to these networks at all. */
  applies: boolean;
  aviso: string;
  check: ComplianceCheck | null;
  message: string;
  /**
   * What the citation checks found when `citationAsRemark` let the post
   * through anyway (lib/approval-remarks.ts). Empty when nothing was found,
   * or when the gate refused.
   */
  remarks: string[];
};

/** The permit number this user's posts must carry. Tolerates a database that predates the column. */
export async function avisoForUser(userId: string): Promise<string> {
  try {
    const { data } = await supabaseAdmin()
      .from('brand_profiles')
      .select('aviso_publicidad')
      .eq('user_id', userId)
      .maybeSingle();
    return avisoNumberFor((data as { aviso_publicidad?: string | null } | null)?.aviso_publicidad);
  } catch {
    return avisoNumberFor(null);
  }
}

/**
 * `refPolicy` is the policy the draft was written under (refPolicyOf its pack);
 * omitted, the REF line is required, exactly as before. Under
 * 'if-health-claim' a missing REF is waived only when the text itself makes no
 * health claim — the stamp alone can never wave a claim through.
 *
 * `claimSupport` is the judge's verdict on the draft's citation
 * (`pack._claimSupport.status`, lib/citation-gate.ts claimSupportOf). An
 * 'unsupported' citation is refused here, at the same door as a missing one:
 * a REF line that exists, resolves, and backs nothing the post says is the
 * case the September audit found published three times.
 */
export async function complianceGate(
  userId: string,
  text: string,
  providers: readonly string[] | string | null | undefined,
  opts: { refPolicy?: RefPolicy; claimSupport?: string | null; citationAsRemark?: boolean } = {},
): Promise<GateResult> {
  const aviso = await avisoForUser(userId);
  if (!appliesTo(providers)) return { ok: true, applies: false, aviso, check: null, message: '', remarks: [] };
  const check = checkCompliance(text, aviso, { refPolicy: opts.refPolicy });
  const remarks: string[] = [];
  if (!check.ok) {
    const message = complianceMessage(check, Array.isArray(providers) ? providers : providers ? [providers] : null);
    // A person approving may send past a missing or DOI-less REF line, with
    // the finding written down (lib/approval-remarks.ts). The AVISO is never
    // waved through: a missing or wrong permit number refuses as before.
    if (!(opts.citationAsRemark && !check.missing.includes('aviso'))) {
      return { ok: false, applies: true, aviso, check, message, remarks: [] };
    }
    remarks.push(check.missing.includes('ref')
      ? 'The REF line citing a scientific study is missing.'
      : 'The REF line has no DOI, so the citation could not be checked.');
  }
  const unsupported = claimSupportRefusal(opts.claimSupport);
  if (unsupported) {
    if (!opts.citationAsRemark) return { ok: false, applies: true, aviso, check, message: unsupported, remarks: [] };
    remarks.push('The study cited in the REF line does not support what the post says.');
  }
  return { ok: true, applies: true, aviso, check, message: '', remarks };
}

/** The JSON body a refused request returns — the same shape everywhere. */
export function gateRefusal(g: GateResult) {
  return {
    error: 'compliance',
    message: g.message,
    missing: g.check?.missing ?? [],
    aviso: g.aviso,
  };
}
