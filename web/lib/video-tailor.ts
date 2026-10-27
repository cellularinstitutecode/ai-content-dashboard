// web/lib/video-tailor.ts
// Copy of its own for each network a row asks for that has none.
//
// The hand-off (lib/video-autopilot.ts handOffToMetricool) knows which
// networks a row is going to only once the ticks, the format and the
// already-published columns have been read — so this runs there, for exactly
// those networks and no others, rather than in prepareVideo for every network
// a row might conceivably want. The rule for what each network gets is in
// lib/network-copy.ts; this is the server half that supplies the model, the
// permit number and the clock.
//
// Fail-open by construction: every refusal, timeout and empty answer leaves
// that network with the text it has always been sent. Nothing here can stop a
// draft that would have been made before.
import 'server-only';

import { tailorCopy } from '@/lib/ai';
import { checkCompliance } from '@/lib/compliance';
import { makesHealthClaim } from '@/lib/health-claim';
import { assembleGatedPost, assembleXPost, tailorSource } from '@/lib/network-copy';
import { fitsNetwork } from '@/lib/video-row';
import { reportError } from '@/lib/report';

/** Below this much clock, writing anything more is how a request dies answering. */
const MIN_BUDGET_MS = 15_000;
/** The most one adaptation may take; three run side by side, so this is the cost of the step. */
const MAX_CALL_MS = 20_000;

export async function tailorForNetworks(args: {
  networks: readonly string[];
  linkedin: string;
  tiktok: string;
  title?: string | null;
  /** The permit number this user's posts carry (lib/compliance-gate.ts avisoForUser). */
  aviso: string;
  /** What is left of the caller's clock, when it is keeping one. */
  budgetMs?: number;
}): Promise<Partial<Record<string, string>>> {
  const out: Partial<Record<string, string>> = {};
  const wanted = Array.from(new Set(args.networks.map((n) => String(n || '').toLowerCase()).filter(Boolean)));
  if (!wanted.length) return out;
  if (typeof args.budgetMs === 'number' && args.budgetMs < MIN_BUDGET_MS) return out;
  const timeoutMs = typeof args.budgetMs === 'number' ? Math.min(MAX_CALL_MS, Math.max(8_000, args.budgetMs - 5_000)) : MAX_CALL_MS;

  // The citation the pipeline verified, from whichever text carries it. It is
  // put back by the assembly below rather than trusted where the model left it.
  const ref = checkCompliance(args.tiktok).ref || checkCompliance(args.linkedin).ref || '';

  await Promise.all(wanted.map(async (network) => {
    const source = tailorSource(network, args);
    if (!String(source || '').trim()) return;
    const raw = await tailorCopy({ network, source, title: args.title, timeoutMs });
    if (!raw) return;
    // The source passed the claim ladder; an adaptation that reads as a claim
    // where the source did not has said something new, and is not sent.
    if (makesHealthClaim(raw) && !makesHealthClaim(source)) {
      reportError('video-tailor:new-claim', new Error('the ' + network + ' adaptation added a health claim the source did not make'), { network });
      return;
    }
    const text = network === 'twitter' ? assembleXPost(raw, ref, args.aviso) : assembleGatedPost(raw, ref, args.aviso);
    if (!text) return;
    if (!fitsNetwork(network, text).ok) return;
    out[network] = text;
  }));
  return out;
}
