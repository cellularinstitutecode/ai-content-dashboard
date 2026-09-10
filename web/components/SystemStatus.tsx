'use client';

import { useEffect, useState } from 'react';

import { plainFor } from '@/lib/health-plain';

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
  // The wording lives in lib/health-plain.ts so this banner and the
  // assistant say the same sentence about the same condition.
  const lines = failing.map((c) => plainFor(c.name, c.code));

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
