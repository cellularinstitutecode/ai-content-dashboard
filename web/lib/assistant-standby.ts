// web/lib/assistant-standby.ts
// The assistant waits for a command. This is the vocabulary of waiting.
//
// It used to open the panel with a status report and an offer to retry
// whatever was stuck, and its standing orders said it MAY retry, re-prepare
// and rewrite videos without asking. The clinic's instruction is the opposite:
// it should know everything that is going on, and do nothing about any of it
// until told. So it opens with one line and waits; it never offers a fix it
// was not asked for; and "standby" puts it in a mode where it will talk but
// not act, until "resume".
//
// Pure — no imports — so the client panel, the route and the tests all read
// the same words.

/** What the panel says when it opens. No request is made to say it. */
export const OPENING_LINE =
  'Standing by. I can see the video pipeline, the calendar, the drafts and the Autopilot queue — tell me what you want done.';

/** The chips under the opening line: questions and commands, never an offer to fix something. */
export const OPENING_CHIPS = ['What needs me?', 'What is on the calendar this week?', 'Write a post'];

export type StandbyCommand = 'standby' | 'resume';

/**
 * Is this message about standby itself?
 *
 * Short, whole-message forms only: "standby", "go on standby", "stand by",
 * "resume", "wake up". A sentence that merely contains the word ("put the
 * standby post on Friday") is a command about content, not about the mode.
 */
export function standbyCommand(text: string | null | undefined): StandbyCommand | null {
  const t = String(text || '').trim().toLowerCase().replace(/[.!]+$/, '');
  if (!t) return null;
  if (/^(?:(?:go|go on|please go|be|stay|remain) (?:on |to )?)?stand ?by(?: mode)?(?: now| please)?$/.test(t)) return 'standby';
  if (/^(?:resume|wake(?: up)?|stand down|back to work|come back|you can (?:continue|resume)|carry on|continue)(?: now| please)?$/.test(t)) return 'resume';
  return null;
}

export const STANDBY_ACK =
  'On standby. I am still watching everything, and I will not act on any of it — no retries, no drafts, no queueing — until you say "resume". Ask me anything meanwhile.';

export const RESUME_ACK = 'Back. What would you like done?';

/**
 * Appended to the live situation on every turn while on standby.
 *
 * The tools are also withheld on those turns (lib/ai.ts chatWithTools), so
 * this is the model being told why, and what to say when asked to act.
 */
export const STANDBY_RULES =
  'STANDBY: the user has put you on standby. You may answer questions and describe the situation, but you must not act, ' +
  'and you must not offer to act. If asked to do something, say you are on standby and that "resume" puts you back to work. ' +
  'Do not suggest fixes, retries or drafts on your own.';

/**
 * The standing orders that replaced "you MAY retry without asking".
 *
 * Exported so the test can pin the prompt to the words that matter, and so
 * the sentence lives in one place.
 */
export const COMMAND_ONLY_RULES =
  'You act ONLY on a command. Do not retry, re-prepare, rewrite, fix, queue or schedule anything on your own initiative, ' +
  'and do not offer to. When the user asks what is going on, report it — the situation blocks tell you — and then wait. ' +
  'When the user tells you to do something, do all of it, and say what happened.';
