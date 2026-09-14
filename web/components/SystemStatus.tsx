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
type TestStep = { step: string; ok: boolean; detail: string };


export default function SystemStatus() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  // Distinguishes "the status could not be read" from "nothing is wrong" — two
  // states this component used to render identically, as nothing at all.
  const [unreadable, setUnreadable] = useState(false);
  // The Drive round-trip, run on demand. Create → share → fetch as a stranger →
  // delete: four separate permissions that fail at four different moments, and
  // only the last is visible to the read-only checks above. A Shared Drive can
  // look correctly set up and still refuse the sharing step.
  const [testing, setTesting] = useState(false);
  const [steps, setSteps] = useState<TestStep[] | null>(null);

  async function runDriveTest() {
    setTesting(true);
    setSteps(null);
    try {
      const r = await fetch('/api/media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selfTest: true }),
      });
      const j = await r.json().catch(() => null);
      setSteps(Array.isArray(j?.steps) ? j.steps : [{ step: 'create', ok: false, detail: 'The test could not be run.' }]);
    } catch {
      setSteps([{ step: 'create', ok: false, detail: 'We could not reach the server to run the test.' }]);
    } finally {
      setTesting(false);
    }
  }

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
      .then((j) => {
        if (!live) return;
        if (j && Array.isArray(j.checks)) setChecks(j.checks);
        // A status that cannot be READ is not a status with nothing in it, and
        // the two must not look the same. Rendering null here meant one blip
        // reaching Google or the database silently removed this entire banner —
        // the Shared Drive setup panel and its test button included — leaving a
        // screen that looks exactly like "everything passed".
        else setUnreadable(true);
      })
      .catch(() => { if (live) setUnreadable(true); });
    return () => { live = false; };
  }, []);

  // Could not read the status at all. Say so, and still offer the Drive test:
  // it is the one thing on this banner a person can act on, it re-verifies in
  // seconds, and it does not depend on the health endpoint working.
  if (!checks && unreadable) {
    return (
      <div role="status" className="mb-6 rounded-2xl bg-amber-50 px-5 py-4 text-amber-900 ring-1 ring-amber-200">
        <p className="text-[13px] font-semibold">The dashboard could not check its own status</p>
        <p className="mt-1 text-[13px]">
          Nothing here is known to be broken — the status check itself did not answer, so nothing could be verified. Reload in a moment.
        </p>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void runDriveTest()}
            disabled={testing}
            className="rounded-full bg-white/80 px-3 py-1.5 text-[12px] font-semibold ring-1 ring-current/20 transition hover:bg-white disabled:opacity-50"
          >
            {testing ? 'Testing Drive…' : 'Test the Drive setup'}
          </button>
          {steps && (
            <ul className="mt-2 space-y-0.5 text-[12px]">
              {steps.map((s, i) => (
                <li key={i}>
                  <span aria-hidden>{s.ok ? '\u2705' : '\u274C'}</span> <strong>{s.step}</strong> — {s.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  if (!checks) return null;

  // Housekeeping items are real but not worth a banner — they change nothing
  // a person doing the work would notice.
  const QUIET = new Set(['assistant_session_secret']);
  const failing = checks.filter((c) => !c.ok && !QUIET.has(c.name));
  if (!failing.length) return null;

  const blocking = failing.some((c) => c.severity === 'required');
  // The wording lives in lib/health-plain.ts so this banner and the
  // assistant say the same sentence about the same condition.
  // Keep the check beside its wording. The `detail` is where the server says
  // WHICH of several causes this is — sweep_owner alone distinguishes three,
  // each with a different fix — and this component declared the field and then
  // never rendered it, so the one sentence worth reading never arrived.
  const lines = failing.map((c) => ({ ...plainFor(c.name, c.code), detail: c.detail }));

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
            {/* The technical half, for whoever set this up. Second and quieter
                so the plain words still lead, but present — it is the only
                part that says which cause this is and what fixes it. */}
            {l.detail ? <span className="mt-0.5 block text-[12px] opacity-60">{l.detail}</span> : null}
          </li>
        ))}
      </ul>
      {/* Offered only when Drive is the thing that is failing: it is the one
          check a person can act on and then re-verify in seconds, which is
          exactly what a fresh Shared Drive needs. */}
      {failing.some((c) => c.name === 'drive_storage' || c.name === 'drive') && (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => void runDriveTest()}
            disabled={testing}
            className="rounded-full bg-white/80 px-3 py-1.5 text-[12px] font-semibold ring-1 ring-current/20 transition hover:bg-white disabled:opacity-50"
          >
            {testing ? 'Testing Drive…' : 'Test the Drive setup'}
          </button>
          {steps && (
            <ul className="mt-2 space-y-0.5 text-[12px]">
              {steps.map((s, i) => (
                <li key={i}>
                  <span aria-hidden>{s.ok ? '\u2705' : '\u274C'}</span> <strong>{s.step}</strong> — {s.detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="mt-2 text-[12px] opacity-70">Ask whoever set this up to take a look — nothing you do here can break it further.</p>
    </div>
  );
}
