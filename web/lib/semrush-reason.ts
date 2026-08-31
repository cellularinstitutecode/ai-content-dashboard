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

// ---------------------------------------------------------------------------
// What a person should be told.
//
// Every panel used to write its own sentence for this, and every one of them
// guessed "the API key is not set" — which was wrong in the most common case.
// A budget floor, an unentitled key and an exhausted plan all read as "no live
// data", but only one of them is a missing key, and only some of them are
// anyone's job to fix. One mapping, so the app never blames the wrong thing.
//
// House rules: no environment-variable names (a coordinator cannot act on
// SEMRUSH_API_KEY), no machine codes, and a clear "who fixes this" for the
// states a human can act on.
const MESSAGES: Record<SemrushReason, string> = {
  ok: '',
  empty: 'Semrush has no data for this topic yet.',
  no_token: 'Keyword research is not connected yet — ask whoever set this up to add the Semrush key.',
  auth: 'Semrush rejected its credentials — ask whoever set this up to refresh the key.',
  v3_key: 'This Semrush plan does not include the keyword reports, so stored data is being shown.',
  plan: 'Semrush has no report credit left on this plan right now.',
  budget: 'Keyword research is paused to protect the Semrush credit balance — it resumes when the balance recovers.',
  http: 'Semrush did not answer just now — showing stored data instead.',
  network: 'Semrush could not be reached just now — showing stored data instead.',
};

/** One plain sentence for why a Semrush lookup produced no live data. */
export function semrushMessage(reason: SemrushReason | undefined): string {
  if (!reason || reason === 'ok') return '';
  return MESSAGES[reason] ?? MESSAGES.http;
}

/**
 * The sentence to show beside a draft that was written without live keyword
 * data. Always says what still happened (the draft is fine) before why the
 * data is missing, so the note reads as information and not as a failure.
 */
export function semrushDraftNote(reason: SemrushReason | undefined): string {
  const why = semrushMessage(reason);
  return why
    ? 'Written without live keyword data. ' + why
    : 'Written without live keyword data.';
}
