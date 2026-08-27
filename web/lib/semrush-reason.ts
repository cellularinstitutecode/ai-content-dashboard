// web/lib/semrush-reason.ts
// Why a Semrush call did not return live data — one pure, dependency-free
// mapping shared by every Semrush client in the app (and unit-tested, which a
// module importing `server-only` + the Supabase admin client cannot be).
//
// The distinction that matters operationally is "chase this" vs "serve cache":
//
//   auth     the credential is wrong or revoked        → a human should fix it
//   v3_key   the credential cannot call the v3 API     → nothing to fix by retry
//   plan     the report/units are not on this plan     → nothing to fix by retry
//   budget   our own unit floor stopped the call       → clears by itself
//   empty    Semrush genuinely has no data yet         → nothing is wrong
//
// `v3_key` exists because Semrush runs two independent key systems. A v4 key —
// the only kind the API Keys page issues today — is accepted ONLY on v4
// endpoints, while every report in this app is on the Standard API (v3), which
// is a Business-plan entitlement. Both cases answer with ERROR 122 or HTTP 403
// and both mean the same thing: this will never succeed on a retry, so show the
// stored data and say so calmly instead of raising an error the user can't act
// on by "verifying the key".
export type SemrushReason =
  | 'ok'
  | 'no_token'
  | 'auth'
  | 'plan'
  | 'v3_key'
  | 'http'
  | 'network'
  | 'empty'
  | 'budget';

// The v3 API reports failures in the BODY as `ERROR <code> :: <text>`, with a
// 200 status — so the code, not the status, is the signal here.
export function reasonForCode(code: number): SemrushReason {
  // 110 INVALID IMPORT KEY / 120 WRONG KEY - ID PAIR: a real credential fault.
  if (code === 110 || code === 120) return 'auth';
  // 121/122 WRONG FORMAT OR EMPTY KEY: what v3 answers for a v4 key, or for an
  // account with no Standard API entitlement at all.
  if (code === 121 || code === 122) return 'v3_key';
  // 130-135: report/plan restrictions (NOT ENOUGH UNITS, API DISABLED, …).
  if (code >= 130 && code <= 135) return 'plan';
  if (code === 50) return 'empty';
  return 'http';
}

// Transport-level failures, used by the JSON Projects API (Site Audit,
// Position Tracking) and as a fallback for the CSV reports.
export function reasonForHttpStatus(status: number): SemrushReason {
  // 401 is "we don't know you"; 403 is "we know you, you're not entitled" —
  // and entitlement is exactly the v3-vs-v4 / Business-plan situation.
  if (status === 401) return 'auth';
  if (status === 403) return 'v3_key';
  if (status === 402 || status === 429) return 'plan';
  return 'http';
}

// Does this state mean "the integration is fine, just serving stored data"?
// The UI uses this to decide between a quiet note and an amber warning: only
// states a human can actually act on deserve the amber.
export function isInformationalReason(reason: SemrushReason | undefined): boolean {
  return reason === 'no_token' || reason === 'v3_key' || reason === 'budget' || reason === 'empty';
}
