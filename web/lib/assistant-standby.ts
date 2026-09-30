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

// --- where the user is ---------------------------------------------------------

export type PageContext = {
  /** The section's name as the nav prints it. */
  label: string;
  /** What a person does there, for the model. */
  doing: string;
  /** The chips worth offering there: questions and commands, never a fix. */
  chips: string[];
};

/**
 * Which section a path is, and what somebody is doing there.
 *
 * The panel sends the path with every message and the route hands the model
 * this description, so "what needs me?" on the Video Library is answered
 * about videos and on the Calendar about posts — without being told twice.
 */
export function pageContext(pathname: string | null | undefined): PageContext {
  const p = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (p.startsWith('/sources/videos')) return { label: 'Video Library', doing: 'looking at the videos in the sheet: which are prepared, which are stuck, which have a Metricool draft', chips: ['What needs me in the video pipeline?', 'Prepare the next video that is ready', 'Which rows have no Metricool draft yet?'] };
  if (p.startsWith('/sources/images')) return { label: 'Image Library', doing: 'looking at the library photos and generated pictures', chips: ['Which drafts have no picture?', 'Make a picture for the latest draft'] };
  if (p.startsWith('/sources/calendar')) return { label: 'Social Calendar', doing: 'looking at the team\u2019s social calendar sheet', chips: ['What is planned this week?', 'What is on the calendar this week?'] };
  if (p.startsWith('/calendar')) return { label: 'Calendar / Publishing', doing: 'looking at the month of scheduled posts and the ones waiting for approval', chips: ['What is waiting for approval?', 'Which posts publish this week?', 'Is anything on the calendar missing its video?'] };
  if (p.startsWith('/templates')) return { label: 'Templates', doing: 'looking at the planner: the schedule templates and the weekly strategy slots', chips: ['Show me the planner', 'What does the Autopilot write this week?'] };
  if (p.startsWith('/brand')) return { label: 'Brand Brain', doing: 'editing the clinic\u2019s brand profile, voice and rules', chips: ['What has performed best for this brand?', 'Which keywords have worked?'] };
  if (p.startsWith('/draft')) return { label: 'Draft', doing: 'writing a post in the Content Generator', chips: ['Write a post about what performed best', 'Research a topic before I write'] };
  return { label: 'Dashboard', doing: 'on the dashboard: the generator, Recent Drafts, the Autopilot queue and the publishing list', chips: OPENING_CHIPS };
}

/**
 * The rule for being a step ahead: one short "Next:" line at the end of a
 * reply, naming the most likely next step where the user is — a suggestion
 * the panel turns into a chip, never an action.
 */
export const NEXT_STEP_RULE =
  'Be a step ahead, in words only: when there is an obvious next step for where the user is and what they just did, end your reply with ONE line ' +
  'beginning "Next:" that names it as a command they could give you (for example "Next: prepare row 183 now"). Choose it from what has worked ' +
  'for this brand and the situation blocks, not from habit. Never take that step unasked, and leave the line out when there is nothing worth suggesting.';

/** A reply's trailing "Next: …" line, split off so the panel can show it as a chip. */
export function splitNextStep(message: string | null | undefined): { text: string; next: string | null } {
  const raw = String(message || '').replace(/\s+$/, '');
  const m = /(?:^|\n)\s*\**Next:\**\s*(.+?)\s*$/i.exec(raw);
  if (!m) return { text: raw, next: null };
  const next = m[1].replace(/^[\u2014\u2013\-\s]+/, '').replace(/[.\s]+$/, '').trim();
  const text = raw.slice(0, m.index).replace(/\s+$/, '');
  return { text: text || raw, next: next || null };
}

// --- the activity trail --------------------------------------------------------

export const THINKING_LABEL = 'Thinking it through';

/**
 * What the assistant is doing right now, in a few words, for the blue trail
 * under the conversation. One line per tool call, named from the call's own
 * input so "Writing the draft" says which draft.
 */
export function stepLabel(name: string, input: Record<string, unknown> | null | undefined): string {
  const i = input || {};
  const q = (k: string) => { const v = String(i[k] ?? '').replace(/\s+/g, ' ').trim(); return v ? ' \u201c' + (v.length > 48 ? v.slice(0, 47) + '\u2026' : v) + '\u201d' : ''; };
  switch (name) {
    case 'generate_content': return 'Writing the draft' + q('topic');
    case 'save_draft': return 'Saving the draft';
    case 'schedule_post': return 'Staging the post for review';
    case 'clip_video': return 'Sending the video to be clipped';
    case 'research_topic': return 'Researching' + q('topic');
    case 'keyword_lookup': return 'Looking up Semrush data for' + q('topic');
    case 'pipeline_status': return 'Reading the video pipeline';
    case 'retry_video': return 'Re-preparing the video';
    case 'list_schedule': return 'Reading the planner';
    case 'create_schedule': return 'Creating the schedule' + q('name');
    case 'update_schedule': return 'Changing the schedule';
    case 'pause_schedule': return 'Pausing the schedule';
    case 'draft_batch': return 'Proposing the batch';
    case 'generate_image': return 'Making the picture';
    case 'competitor_comparables': return 'Comparing with the top 3 on Google for' + q('topic');
    default: return 'Working on ' + String(name || 'it').replace(/_/g, ' ');
  }
}

/** The tone: a colleague working toward the goal, fast. */
export const CONVERSATION_RULE =
  'Work like a colleague at the next desk, toward the goal: say what you did, what you found and what you suggest, in that order and briefly; ' +
  'keep the momentum (the next step is a chip away); no lectures, no lists of everything you could do, no restating the question.';
