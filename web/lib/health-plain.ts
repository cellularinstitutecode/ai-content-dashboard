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
  // Narrowed by the reason the provider actually gave, the same way the image
  // entries below are. "No AI is connected" is wrong and actively misleading
  // for a key that IS connected and is being refused — the difference between
  // someone plugging a key in and someone paying a bill.
  'ai_provider:not_configured': { down: 'Writing is unavailable — no AI is connected.' },
  'ai_provider:no_credit': {
    down: 'The AI account is out of credit, so nothing can be written.',
    stillWorks: 'Drafts already written are unaffected, and scheduling still works.',
  },
  'ai_provider:bad_key': {
    down: 'The AI provider rejected its key on the last attempt, so nothing can be written.',
    stillWorks: 'Drafts already written are unaffected, and scheduling still works.',
  },
  'ai_provider:rate_limited': {
    down: 'The AI provider is refusing calls for going too fast; writing may be intermittent.',
    stillWorks: 'It usually clears on its own — try again in a few minutes.',
  },
  'ai_provider:other': {
    down: 'The last attempt to write anything was refused by the AI provider.',
    stillWorks: 'Drafts already written are unaffected, and scheduling still works.',
  },
  metricool: { down: 'Scheduling is unavailable.', stillWorks: 'You can still write and save drafts.' },
  'metricool:not_configured': { down: 'Scheduling is not connected.', stillWorks: 'You can still write and save drafts.' },
  'metricool:bad_key': {
    down: 'Metricool rejected its token on the last attempt, so nothing can be scheduled.',
    stillWorks: 'You can still write and save drafts here.',
  },
  'metricool:rate_limited': {
    down: 'Metricool is refusing posts for going too fast; scheduling may be intermittent.',
    stillWorks: 'It usually clears on its own — try again in a few minutes.',
  },
  'metricool:other': {
    down: 'Metricool refused the last post, so scheduling may not be working.',
    stillWorks: 'You can still write and save drafts here.',
  },
  allowed_emails: { down: 'Sign-in access is not configured.' },
  cron_secret: { down: 'Autopilot and performance tracking are not running.', stillWorks: 'Writing and scheduling by hand are unaffected.' },
  rate_limiting: { down: 'Usage limits are not being applied.' },
  semrush: { down: 'Keyword research is paused.', stillWorks: 'Drafts are still written — just without live search data.' },
  images: { down: 'AI images are not being generated.', stillWorks: 'Posts still write and schedule as text.' },
  opus_webhook: { down: 'Video clips arrive more slowly than usual.', stillWorks: 'They still arrive.' },
  drive: { down: 'Video clips are not being saved permanently and stop playing after a few days.' },
  // The check that decides whether ANY video can be attached to ANY post.
  drive_storage: {
    down: 'Videos cannot be attached to posts — the shareable copy cannot be made.',
    stillWorks: 'Captions are still written into the sheet, and text-only posts still go out.',
  },
  'drive_storage:not_shared_drive': {
    down: 'Videos cannot be attached to posts: the copies folder is not in a Shared Drive.',
    stillWorks: 'Captions are still written into the sheet, and text-only posts still go out.',
  },
  'drive_storage:unreachable': {
    down: 'Videos cannot be attached to posts: the copies folder cannot be opened.',
    stillWorks: 'Captions are still written into the sheet, and text-only posts still go out.',
  },
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
  // The general form of the two cases above: a "name:code" entry in the map wins
  // over the bare name.
  //
  // This was missing, and the two drive_storage:* entries below had therefore
  // never once been read — the banner showed the generic "the shareable copy
  // cannot be made" for a folder that is simply not in a Shared Drive, which is
  // the one failure where the specific wording is the whole fix.
  if (code) {
    const narrowed = PLAIN[name + ':' + code];
    if (narrowed) return narrowed;
  }
  return PLAIN[name] ?? { down: name.replace(/_/g, ' ') + ' is not available.' };
}
