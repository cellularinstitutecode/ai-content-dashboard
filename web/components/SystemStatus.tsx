'use client';

import { useEffect, useState } from 'react';

/**
 * One line that says whether the dashboard is running on everything it has.
 *
 * /api/health already knew, precisely, that (for example) keyword research was
 * dead — but it only said so in developer language on an endpoint nobody
 * opens. On screen, the same situation showed up as an empty Site Audit dial,
 * a blank rank-tracking chart and a note under the generator blaming a missing
 * API key that was not missing. Three symptoms, no cause.
 *
 * So: one banner, in the words of the person reading it, saying what still
 * works and who fixes what does not. Silent when everything is fine — a status
 * light that is always lit teaches people to stop looking at it.
 */

type Check = { name: string; ok: boolean; severity: 'required' | 'optional'; detail?: string; code?: string };

// What a degraded check MEANS for the work, and what still works despite it.
// Deliberately says nothing about environment variables: the person reading
// this cannot set one, and the person who can does not need this banner.
const PLAIN: Record<string, { down: string; stillWorks?: string }> = {
  supabase: { down: 'Saving and sign-in are unavailable.' },
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

export default function SystemStatus() {
  const [checks, setChecks] = useState<Check[] | null>(null);

  useEffect(() => {
    let live = true;
    // Read the body whatever the status. /api/health answers 503 precisely WHEN
    // something required is failing - the case this banner exists for - and it
    // returns the same {checks} payload either way. Gating on `r.ok` threw that
    // payload away, so the component was silent exactly when it had something to
    // say. Leaving the body unread also left the request unfinished, which is
    // enough to stop a page ever reaching network idle.
    fetch('/api/health')
      .then((r) => r.json().catch(() => null))
      .then((j) => { if (live && j && Array.isArray(j.checks)) setChecks(j.checks); })
      .catch(() => { /* a health check that cannot report is not worth an alarm */ });
    return () => { live = false; };
  }, []);

  if (!checks) return null;

  // Housekeeping items are real but not worth a banner — they change nothing
  // a person doing the work would notice.
  const QUIET = new Set(['assistant_session_secret']);
  const failing = checks.filter((c) => !c.ok && !QUIET.has(c.name));
  if (!failing.length) return null;

  const blocking = failing.some((c) => c.severity === 'required');
  const lines = failing.map((c) => {
    // Keyword research can be off for two very different reasons, and the
    // difference is exactly who needs to act: nobody can "connect" their way
    // out of an empty credit balance.
    if (c.name === 'semrush' && c.code === 'budget') {
      return { down: 'Keyword research is paused — the Semrush credit balance is at its protection floor.', stillWorks: 'Drafts are still written, just without live search data.' };
    }
    if (c.name === 'semrush' && c.code === 'balance_unknown') {
      return { down: 'Keyword research is paused — the Semrush key cannot read the account balance, which usually means it is a v4 key and the app needs a Standard API key.', stillWorks: 'Drafts are still written, just without live search data. Adding units will not change this.' };
    }
    if (c.name === 'semrush' && c.code === 'no_token') {
      return { down: 'Keyword research is not connected.', stillWorks: 'Drafts are still written, just without live search data.' };
    }
    // "AI images are not being generated" is true but useless when the cause is
    // an empty wallet, because the same account also runs the check that keeps
    // text off those images and the voice assistant. Naming it stops three
    // separate "is this broken?" conversations.
    if (c.name === 'images' && c.code === 'no_credit') {
      return { down: 'The OpenAI account is out of credit — images, image checks and voice are paused.', stillWorks: 'Text still works.' };
    }
    if (c.name === 'images' && c.code === 'bad_key') {
      return { down: 'AI images are not being generated — OpenAI rejected the key on the last attempt.', stillWorks: 'Posts still write and schedule as text.' };
    }
    return PLAIN[c.name] ?? { down: c.name.replace(/_/g, ' ') + ' is not available.' };
  });

  return (
    <div
      role="status"
      className={
        'mb-6 rounded-2xl px-5 py-4 ring-1 ' +
        (blocking ? 'bg-red-50 text-red-900 ring-red-200' : 'bg-amber-50 text-amber-900 ring-amber-200')
      }
    >
      <p className="text-[13px] font-semibold">
        {blocking ? 'Something the dashboard needs is not working' : 'Running with some things switched off'}
      </p>
      <ul className="mt-1.5 space-y-1 text-[13px]">
        {lines.map((l, i) => (
          <li key={i}>
            {l.down}
            {l.stillWorks ? <span className="opacity-70"> {l.stillWorks}</span> : null}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] opacity-70">Ask whoever set this up to take a look — nothing you do here can break it further.</p>
    </div>
  );
}
