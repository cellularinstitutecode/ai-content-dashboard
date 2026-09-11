// web/lib/drive-copy-error.ts
// Why the shareable copy could not be made, and what to do about it.
//
// The first version of this said "We could not make a shareable copy of that
// video just now. Try again, or press Prepare on the row." for every possible
// cause — a missing environment variable, a file the service account cannot
// see, a Workspace policy that forbids link-sharing, a full Drive, and a file
// whose owner has switched copying off. Those need five different actions and
// "try again" is the right one for none of them.
//
// Google says which it is. This reads the answer and repeats it in a sentence
// a person can act on. Pure, so every branch is unit-tested.

export type CopyFailure =
  | 'no_folder'        // DRIVE_FOLDER_ID is not configured on the deployment
  | 'copy_forbidden'   // the source file's owner has disabled copying
  | 'no_access'        // the service account cannot see the source file
  | 'sharing_blocked'  // Workspace policy forbids anyone-with-the-link sharing
  | 'out_of_space'     // the Drive holding the copy is full
  | 'rate_limited'
  | 'unknown';

export type CopyAdvice = { reason: CopyFailure; message: string };

/** The text Google put in the error, whatever shape the client wrapped it in. */
function textOf(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  const e = err as {
    message?: string;
    errors?: { reason?: string; message?: string }[];
    response?: { data?: unknown };
  };
  const parts = [String(e.message || '')];
  for (const sub of e.errors || []) parts.push(String(sub.reason || ''), String(sub.message || ''));
  if (e.response?.data) {
    try { parts.push(typeof e.response.data === 'string' ? e.response.data : JSON.stringify(e.response.data)); } catch { /* not serialisable */ }
  }
  return parts.filter(Boolean).join(' ');
}

function statusOf(err: unknown): number {
  const e = (err || {}) as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const v of [e.code, e.status, e.response?.status]) {
    const n = typeof v === 'string' ? parseInt(v, 10) : typeof v === 'number' ? v : NaN;
    if (Number.isFinite(n) && n >= 100 && n < 600) return n;
  }
  return 0;
}

/**
 * Name the cause and say what fixes it.
 *
 * Ordered most-specific first: several of these arrive as a bare 403, and the
 * generic "the service account cannot see it" advice sends people to re-share a
 * file that was already shared — the exact wrong-advice failure that
 * lib/google-error.ts exists to prevent on the Sheets side.
 */
export function copyFailureAdvice(err: unknown): CopyAdvice {
  const hay = textOf(err).toLowerCase();
  const status = statusOf(err);

  if (/drive_folder_id/.test(hay)) {
    return {
      reason: 'no_folder',
      message: 'This deployment has no DRIVE_FOLDER_ID set, so there is nowhere to put the shareable copy. Set it in the environment variables and redeploy.',
    };
  }
  if (/cannotcopyfile|cannot copy|copyrequireswriterpermission/.test(hay)) {
    return {
      reason: 'copy_forbidden',
      message: 'The video’s owner has switched off copying for that file in Drive. Open it in Drive → Share → Settings, untick “Viewers and commenters can see the option to download, print, and copy”, then try again. (Or post the YouTube link instead.)',
    };
  }
  if (/sharingratelimitexceeded|cannot share|sharing is not allowed|domain policy|abusiveconten/.test(hay)) {
    return {
      reason: 'sharing_blocked',
      message: 'Google Workspace is blocking “anyone with the link” sharing for this account, so the copy cannot be made public. An admin can allow link-sharing outside the organisation, or the video can be uploaded to YouTube and posted from there.',
    };
  }
  if (/storagequotaexceeded|out of (storage|space)|quota.*storage/.test(hay)) {
    return {
      reason: 'out_of_space',
      message: 'The Drive holding the shareable copies is full. Clear space in that folder, then try again.',
    };
  }
  if (/ratelimitexceeded|userratelimitexceeded|too many requests/.test(hay) || status === 429) {
    return {
      reason: 'rate_limited',
      message: 'Google is rate-limiting this account right now. Wait a minute and try again.',
    };
  }
  if (status === 404 || /file not found|notfound/.test(hay)) {
    return {
      reason: 'no_access',
      message: 'The dashboard cannot see that video in Drive. Share the file (or the folder it lives in) with the service account as at least Viewer, then try again.',
    };
  }
  if (status === 403 || status === 401 || /permission|forbidden|insufficient/.test(hay)) {
    return {
      reason: 'no_access',
      message: 'Drive refused: the dashboard does not have permission on that video. Share the file, or the folder it lives in, with the service account, then try again.',
    };
  }
  return {
    reason: 'unknown',
    message: 'Drive refused to copy that video' + (textOf(err) ? ': ' + textOf(err).slice(0, 200) : '.') + ' Try again, or press Prepare on the row.',
  };
}
