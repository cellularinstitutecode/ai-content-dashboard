// web/lib/metricool-refusal.ts
// What Metricool's rejection MEANT, in one sentence a person can act on.
//
// THE PROBLEM. The composer told somebody "Saved on tiktok, youtube; failed on
// linkedin." and that was the entire account anybody ever got. The reason
// Metricool gave was logged to the server and discarded from the response, so
// the difference between "LinkedIn is not connected to this brand", "the video
// is not one LinkedIn accepts" and "that text is too long" — three problems
// with three completely different fixes — reached the screen as the same word.
//
// THE RULE THIS KEEPS. lib/friendly-error.ts: an upstream provider's raw error
// body is never shown to a person. So the body is not forwarded; it is READ,
// here, on the server where it already is, and answered with our own sentence.
// Nothing this function returns contains any of its input.
//
// Pure: no imports, so the test runner reads this file directly — including the
// test that asserts no input can ever escape into the output.

/** Capitalised for a sentence: linkedin → LinkedIn. */
function networkName(network: string | null | undefined): string {
  const n = String(network || '').trim().toLowerCase();
  const proper: Record<string, string> = {
    linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram',
    facebook: 'Facebook', twitter: 'X', threads: 'Threads', pinterest: 'Pinterest',
  };
  return proper[n] || (n ? n[0].toUpperCase() + n.slice(1) : 'that network');
}

/** The character limit the composer enforces, for the one message that needs it. */
const LIMITS: Record<string, number> = {
  twitter: 280, instagram: 2200, facebook: 63206, linkedin: 3000, youtube: 5000, tiktok: 2200,
};

/**
 * One sentence for a Metricool rejection.
 *
 * `status` and `body` are what the provider answered; `network` is the one
 * being sent. The body is matched against, never quoted — see the file note.
 */
export function metricoolRefusal(status: number, body: string | null | undefined, network?: string | null): string {
  const raw = String(body || '');
  const who = networkName(network);
  const code = Number.isFinite(status) ? Math.trunc(status) : 0;

  // An account problem, not a post problem. This is the one where the fix is in
  // Metricool's own settings and no amount of editing the post will help.
  if (
    /not\s*connected|disconnect|unlink|reconnect|token[^.]{0,30}(expired|invalid|revoked)|invalid[^.]{0,20}token|unauthor|forbidden/i.test(raw)
    // "No linkedin profile connected for this brand" — the network’s own
    // name sits between "no" and the noun, so the two cannot be adjacent in
    // the pattern. This is the exact shape that slipped through first.
    || /\bno\b[\w\s'"-]{0,30}\b(profile|account|provider|integration|connection)\b/i.test(raw)
    || code === 401 || code === 403
  ) {
    return who + ' is not connected to this brand in Metricool, or its connection has expired. '
      + 'Open Metricool → Brand → Connections and reconnect ' + who + '; nothing about the post needs changing.';
  }

  // THE TEXT IS JUDGED BEFORE THE MEDIA, and each names its own noun.
  //
  // "caption too long" was reported as a video problem, because the media
  // pattern matched a bare "too long" and ran first. Telling somebody to check
  // the aspect ratio of a file that is perfectly fine sends them to the wrong
  // place entirely — worse than saying nothing. So each branch now requires a
  // word about the thing it claims is wrong, and the more specific goes first.
  if (/(text|caption|content|description|title|body)[^.]{0,40}(long|length|limit|exceed|max)|exceed[^.]{0,20}(character|length)|too\s*many\s*characters/i.test(raw)) {
    const limit = LIMITS[String(network || '').trim().toLowerCase()];
    return 'The text is too long for ' + who + (limit ? ', which allows ' + limit.toLocaleString() + ' characters' : '') + '. Shorten it and send again.';
  }

  // The media. Worth its own sentence because the video is the thing this
  // pipeline exists to deliver, and "the post was rejected" reads as the copy.
  if (/\b(media|video|image|attachment|mime|codec|resolution|duration|thumbnail)\b|aspect\s*ratio|file\s*size|unsupported\s*format/i.test(raw)) {
    return 'Metricool would not accept the video for ' + who + '. '
      + 'That is usually the length, the aspect ratio or the file size against '
      + who + '’s own limits — the copy is fine, the file is not.';
  }

  // Scheduling.
  if (/(date|time|schedule|publicationdate).*(past|invalid|future|required)|invalid.*date/i.test(raw)) {
    return 'Metricool refused the publishing time for ' + who + '. Pick a slot in the future and send again.';
  }

  if (code === 429) {
    return 'Metricool is rate-limiting this account, so ' + who + ' was not sent. Wait a few minutes and try again.';
  }
  if (code >= 500) {
    return 'Metricool had a problem of its own (HTTP ' + code + ') and did not save the ' + who + ' draft. This usually clears by itself — try again shortly.';
  }

  // The honest fallback. It names the status, so two different failures never
  // read identically and the server log can be found by it.
  return 'Metricool refused the ' + who + ' draft (HTTP ' + (code || 'no status') + '). '
    + 'The full reason is in the server log for this request.';
}
