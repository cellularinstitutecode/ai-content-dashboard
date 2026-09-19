// web/lib/autopilot-mode.ts
// May the engine approve its own work?
//
// Until now the answer was no, always, by construction: runs stopped at
// ready_for_review and only a person could move them on. That is a good
// default and it stays the default. But a calendar of fourteen posts a week
// that needs fourteen clicks a week is a calendar that stops the first busy
// week, so there has to be a way to say "you may, when everything passes".
//
// TWO THINGS, NOT ONE. This setting says the engine MAY; lib/autoschedule.ts
// says whether it may THIS TIME. Both have to agree. Turning this on does not
// lower any bar — it only removes the person from the path of posts that
// already clear every bar there is.
//
// OFF BY DEFAULT, AND THE DEFAULT IS THE SAFE ONE. An unset, misspelt or
// unreadable value means off. There is no value that turns this on by
// accident.
//
// Pure: no imports, so the test runner reads this file directly.

export type AutopilotMode = 'review' | 'autoschedule';

/**
 * Read AUTOPILOT_AUTOSCHEDULE.
 *
 * `on`, `true`, `yes`, `1` and `scheduled` turn it on. Everything else —
 * including an empty string, a typo and an unset variable — leaves the
 * approval step exactly where it has always been.
 */
export function autopilotMode(env: Record<string, string | undefined> = process.env): AutopilotMode {
  const raw = String(env.AUTOPILOT_AUTOSCHEDULE || '').trim().toLowerCase();
  if (raw === 'on' || raw === 'true' || raw === 'yes' || raw === '1' || raw === 'scheduled') return 'autoschedule';
  return 'review';
}

/** True when the engine may send a run that passes the floor without a person. */
export function autoSchedules(env: Record<string, string | undefined> = process.env): boolean {
  return autopilotMode(env) === 'autoschedule';
}
