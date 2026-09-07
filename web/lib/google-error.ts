// web/lib/google-error.ts
// Reading Google's refusal and naming the cause. Pure — no fetching, no
// credentials — so it can be unit-tested; lib/google-sources.ts does the
// talking to Google, the same split lib/sheet-table.ts already has.

/** Why Google refused, in its words rather than ours. */
export type GoogleFailure =
  | 'api_disabled'      // the Sheets/Drive API is not enabled on the Cloud project
  | 'bad_scopes'        // the token does not carry the scope this call needs
  | 'not_shared'        // the document really is not visible to the service account
  | 'not_found'         // no document with that id
  | 'bad_credentials'   // the service account key is wrong, expired or malformed
  | 'rate_limited'
  | 'unknown';

/**
 * Read Google's error body and name the cause.
 *
 * This exists because the previous version threw away the body and kept only
 * the status, then the route told everyone to "share it with the service
 * account" for ANY 403 or 404. On documents that were already shared with
 * anyone-with-the-link, that sentence sent people to fix the one thing that
 * was not broken. A 403 from Google is at least four different problems and
 * they need four different actions.
 */
export function classifyGoogleError(status: number, body: string): { reason: GoogleFailure; detail: string } {
  let detail = '';
  let status_text = '';
  try {
    const j = JSON.parse(body);
    detail = String(j?.error?.message || j?.error_description || '').trim();
    status_text = String(j?.error?.status || j?.error?.errors?.[0]?.reason || '').trim();
  } catch {
    detail = String(body || '').slice(0, 300).trim();
  }
  const hay = (status_text + ' ' + detail).toLowerCase();
  if (/accessnotconfigured|has not been used in project|is disabled/.test(hay)) return { reason: 'api_disabled', detail };
  if (/insufficient authentication scopes|insufficientpermissions|forbidden_scope/.test(hay)) return { reason: 'bad_scopes', detail };
  if (/invalid_grant|invalid jwt|unauthorized_client|invalid authentication credentials/.test(hay)) return { reason: 'bad_credentials', detail };
  if (/rate limit|quota exceeded|ratelimitexceeded|too many requests/.test(hay) || status === 429) return { reason: 'rate_limited', detail };
  if (status === 404 || /not found|notfound/.test(hay)) return { reason: 'not_found', detail };
  if (status === 401) return { reason: 'bad_credentials', detail };
  if (status === 403) return { reason: 'not_shared', detail };
  return { reason: 'unknown', detail };
}
