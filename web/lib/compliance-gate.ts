// web/lib/compliance-gate.ts
// The server-side door for the advertising rule (lib/compliance.ts): what
// every route that can put an Instagram/Facebook post on the road to Metricool
// calls before it does. One function, so "Send for review", "Approve",
// "Publish now" and Autopilot's approve cannot drift apart.
import 'server-only';

import { appliesTo, avisoNumberFor, checkCompliance, complianceMessage, type ComplianceCheck } from '@/lib/compliance';
import { supabaseAdmin } from '@/lib/supabase-admin';

export type GateResult = {
  /** True when the post may proceed (rule satisfied, or rule not applicable). */
  ok: boolean;
  /** Whether the rule applied to these networks at all. */
  applies: boolean;
  aviso: string;
  check: ComplianceCheck | null;
  message: string;
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

export async function complianceGate(userId: string, text: string, providers: readonly string[] | string | null | undefined): Promise<GateResult> {
  const aviso = await avisoForUser(userId);
  if (!appliesTo(providers)) return { ok: true, applies: false, aviso, check: null, message: '' };
  const check = checkCompliance(text, aviso);
  return { ok: check.ok, applies: true, aviso, check, message: check.ok ? '' : complianceMessage(check) };
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
