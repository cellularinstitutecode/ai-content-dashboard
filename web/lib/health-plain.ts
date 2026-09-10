// web/lib/health-plain.ts
// What a failing health check MEANS for the work, in the words of the person
// reading it.
//
// This lived inside components/SystemStatus.tsx, a 'use client' React file the
// server cannot import. So when the assistant needed to say the same thing —
// "keyword research is paused, drafts still write" — the only options were to
// import a React component into an API route or to write the sentence a second
// time. A second wording drifts from the first, and then the banner and the
// chat window disagree about the same condition in front of the same person.
//
// One map, two readers. Deliberately says nothing about environment variables:
// the person reading this cannot set one, and the person who can does not need
// to be told in these words.
//
// No imports: the test runner strips types and runs this file directly.

export type PlainSaid = {
  /** What has stopped working. */
  down: string;
  /** What carries on regardless — the half that stops a banner reading as an outage. */
  stillWorks?: string;
};

export const PLAIN: Record<string, PlainSaid> = {
  supabase: { down: 'Saving and sign-in are unavailable.' },
  // The automatic path's single point of failure. Named by what it COSTS: the
  // phrase "sweep owner" means nothing to the person reading this, and the
  // thing they will notice is that pasting a link into the sheet stops doing
  // anything. Both automatic triggers — the sheet's own and the nightly pass —
  // check this before they do a thing, and answer 503 when it fails.
  sweep_owner: { down: 'Videos are not being prepared automatically — pasting a link into the sheet no longer starts anything, and the nightly pass does nothing either.', stillWorks: 'Preparing a video by hand from the Video Library still works.' },
  // Google can be reached but will not accept a write, which looks exactly
  // like everything working until the moment copy is written back.
  sheet_write: { down: 'The copy cannot be written back into the Google Sheet.', stillWorks: 'Videos are still transcribed and the copy is still saved as a draft here.' },
  supabase_service_role: { down: 'The database key is not the one the app needs, so anything it saves in the background may silently go nowhere.' },
  audio_extractor: { down: 'Speech-to-text is unavailable — a video with no YouTube captions cannot be read.', stillWorks: 'A video with captions, or a transcript you paste, still works.' },
  database_schema: { down: 'The database is missing an update — ask whoever set this up to run the migration.', stillWorks: 'Writing and scheduling still work; Autopilot does not.' },
  ai_provider: { down: 'Writing is unavailable — no AI is connected.' },
  metricool: { down: 'Scheduling is unavailable.', stillWorks: 'You can still write and save drafts.' },
  allowed_emails: { down: 'Sign-in access is not configured.' },
  cron_secret: { down: 'Autopilot and performance tracking are not running.', stillWorks: 'Writing and scheduling by hand are unaffected.' },
  rate_limiting: { down: 'Usage limits are not being applied.' },
  semrush: { down: 'Keyword research is paused.', stillWorks: 'Drafts are still written — just without live search data.' },
  images: { down: 'AI images are not being generated.', stillWorks: 'Posts still write and schedule as text.' },
  opus_webhook: { down: 'Video clips arrive more slowly than usual.', stillWorks: 'They still arrive.' },
  drive: { down: 'Video clips are not being saved permanently and stop playing after a few days.' },
  assistant_session_secret: { down: 'The assistant is using a shared key instead of its own.', stillWorks: 'Everything works; this is a housekeeping item.' },
};

/**
 * The same thing, but narrowed by the check's own reason code where that
 * changes who has to act.
 *
 * "Keyword research is paused" is true whether the token is missing or the
 * credit balance is at its floor, and the difference is exactly who can fix
 * it: nobody can connect their way out of an empty wallet.
 */
export function plainFor(name: string, code?: string | null): PlainSaid {
  if (name === 'semrush' && code === 'budget') {
    return { down: 'Keyword research is paused — the Semrush credit balance is at its protection floor.', stillWorks: 'Drafts are still written, just without live search data.' };
  }
  if (name === 'semrush' && code === 'balance_unknown') {
    return { down: 'Keyword research is paused — the app cannot confirm the Semrush unit balance right now.', stillWorks: 'Drafts are still written, just without live search data. Ask whoever set this up to check the Semrush connection.' };
  }
  if (name === 'semrush' && code === 'no_token') {
    return { down: 'Keyword research is not connected.', stillWorks: 'Drafts are still written, just without live search data.' };
  }
  // "AI images are not being generated" is true but useless when the cause is
  // an empty wallet, because the same account also runs the check that keeps
  // text off those images and the voice assistant. Naming it stops three
  // separate "is this broken?" conversations.
  if (name === 'images' && code === 'no_credit') {
    return { down: 'The OpenAI account is out of credit — images, image checks and voice are paused.', stillWorks: 'Text still works.' };
  }
  if (name === 'images' && code === 'bad_key') {
    return { down: 'AI images are not being generated — OpenAI rejected the key on the last attempt.', stillWorks: 'Posts still write and schedule as text.' };
  }
  return PLAIN[name] ?? { down: name.replace(/_/g, ' ') + ' is not available.' };
}
