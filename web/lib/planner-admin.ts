// web/lib/planner-admin.ts
// Reading and changing schedule templates from the assistant's tool layer.
//
// Two things this is NOT, both deliberate:
//
//  1. It is not a call to /api/templates. A serverless function fetching its own
//     route needs an absolute URL and carries no cookies, so it 401s in
//     production while working perfectly in development — the lesson already
//     written into retryVideos. It talks to the database directly and scopes
//     every query by user_id itself.
//  2. It is not a second opinion about what a valid template looks like. The
//     field cleaning comes from lib/template-input.ts and the strategy from
//     normalizeStrategy, exactly as the route uses them.
//
// supabase-js RESOLVES a failed query rather than rejecting it, which has bitten
// this codebase more than any other single thing. Every `.error` here is read.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { normalizeStrategy } from '@/lib/autopilot';
import { cleanTime, cleanWeekdays, isUsableTime } from '@/lib/template-input';
import { reportError } from '@/lib/report';


export type PlannerTemplate = {
  id: string;
  name: string;
  providers: string[];
  weekdays: number[];
  time_of_day: string;
  active: boolean;
  strategy: ReturnType<typeof normalizeStrategy>;
};

export type TemplateDraft = {
  id?: string;
  name?: unknown;
  providers?: unknown;
  text?: unknown;
  weekdays?: unknown;
  time_of_day?: unknown;
  active?: unknown;
  strategy?: unknown;
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function shape(row: Record<string, any>): PlannerTemplate {
  return {
    id: String(row.id),
    name: String(row.name || 'Untitled template'),
    providers: Array.isArray(row.providers) ? row.providers.map((p: unknown) => String(p)) : [],
    weekdays: cleanWeekdays(row.weekdays),
    time_of_day: cleanTime(row.time_of_day),
    active: row.active !== false,
    strategy: normalizeStrategy(row.strategy),
  };
}

/** Every template this user owns, newest change first. Throws on a failed read. */
export async function listTemplates(userId: string): Promise<PlannerTemplate[]> {
  // '*', not an explicit column list. Naming `strategy` here made this throw on
  // a database where supabase/autopilot.sql has not been run — so the assistant
  // reported "the planner could not be read" for a workspace whose templates are
  // perfectly readable, while /templates showed them fine (it uses '*' and even
  // special-cases the missing table).
  const { data, error } = await supabaseAdmin()
    .from('schedule_templates')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });
  // Thrown, not swallowed. "You have no templates" and "I could not read your
  // templates" send a person to opposite places, and the second one silently
  // becomes an offer to create the three they already have.
  if (error) throw new Error('Could not read the planner: ' + (error.message || 'unknown error'));
  return (data || []).map(shape);
}

/** The next planned occurrences, so "what is coming up" is an answer, not a guess. */
export async function upcomingRuns(userId: string, limit = 12): Promise<
  { templateId: string; scheduledFor: string; state: string }[]
> {
  const { data, error } = await supabaseAdmin()
    .from('template_runs')
    .select('template_id, scheduled_for, state')
    .eq('user_id', userId)
    .gte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true })
    .limit(Math.min(Math.max(Math.trunc(limit) || 12, 1), 50));
  if (error) {
    // Softer than the list above on purpose: a missing template_runs table is
    // "Autopilot has never been migrated", and the templates themselves are
    // still worth reporting.
    reportError('planner-admin:upcoming', error);
    return [];
  }
  return (data || []).map((r: Record<string, any>) => ({
    templateId: String(r.template_id),
    scheduledFor: String(r.scheduled_for),
    state: String(r.state || 'planned'),
  }));
}

/**
 * Create a template, or change one this user owns.
 *
 * MERGES onto the existing row when given an id. It used to build a complete row
 * from the draft alone and upsert that, which is safe for the /templates page —
 * it posts the whole template every time — and destructive for the assistant,
 * which sends only the fields it was asked to change. "Move the Monday post to
 * 6pm" arrived as { id, time_of_day } and therefore also blanked the template's
 * text (permanently: the Apply flow then refuses it with template_has_no_text,
 * and the model cannot put it back because `text` is in neither tool schema),
 * un-paused it back into daily paid spend, and reset its lead time.
 *
 * The read costs nothing extra: the ownership check was already fetching the row
 * and throwing away everything but the id.
 *
 * Returns the saved row and any notes worth repeating to the person — a time
 * that was not understood becomes 09:00, and silently moving somebody's 6pm blog
 * to the morning is exactly the kind of thing an assistant should say out loud.
 */
export async function saveTemplate(
  userId: string,
  draft: TemplateDraft,
): Promise<{ ok: true; template: PlannerTemplate; notes: string[] } | { ok: false; message: string }> {
  const notes: string[] = [];

  // --- what is already there -------------------------------------------------
  let existing: Record<string, any> | null = null;
  if (draft.id) {
    // Scoped by user_id, and this doubles as the ownership check: an id from the
    // caller, upserted on the id, is an INSERT … ON CONFLICT DO UPDATE against
    // whatever row holds it — somebody else's included. Selecting '*' rather
    // than the explicit column list so a database that predates a column still
    // answers (see listTemplates for the same reason).
    const { data: owned, error: ownerError } = await supabaseAdmin()
      .from('schedule_templates')
      .select('*')
      .eq('id', draft.id)
      .eq('user_id', userId)
      .maybeSingle();
    // Checked, not ignored: supabase-js resolves a failed read, and treating
    // "I could not tell" as "not yours" is the safe direction.
    if (ownerError) {
      reportError('planner-admin:owner-check', ownerError);
      return { ok: false, message: 'Could not confirm that template belongs to this workspace, so nothing was changed. Try again in a moment.' };
    }
    if (!owned) return { ok: false, message: 'There is no template with that id in this workspace.' };
    existing = owned as Record<string, any>;
  }

  // --- the fields, each falling back to what is already stored ---------------
  const keep = <T,>(sent: unknown, current: T, fallback: T): T =>
    sent !== undefined ? (sent as T) : existing ? (current as T) : fallback;

  const weekdays = draft.weekdays !== undefined
    ? cleanWeekdays(draft.weekdays)
    : cleanWeekdays(existing?.weekdays);
  const time = draft.time_of_day !== undefined
    ? cleanTime(draft.time_of_day)
    : existing
      ? cleanTime(existing.time_of_day)
      : cleanTime(undefined);
  if (draft.time_of_day !== undefined && !isUsableTime(draft.time_of_day)) {
    notes.push('"' + String(draft.time_of_day) + '" is not a 24-hour HH:MM time, so this is set to 09:00 — say so and offer to correct it.');
  }

  const row: Record<string, any> = {
    user_id: userId,
    name: String(keep(draft.name, existing?.name, '') ?? '').slice(0, 200) || 'Untitled template',
    providers: Array.isArray(draft.providers)
      ? draft.providers.map((p) => String(p))
      : Array.isArray(existing?.providers) ? existing!.providers : [],
    text: String(keep(draft.text, existing?.text, '') ?? ''),
    weekdays,
    time_of_day: time,
    active: draft.active !== undefined
      ? draft.active !== false
      : existing ? existing.active !== false : true,
    updated_at: new Date().toISOString(),
  };
  if (draft.strategy !== undefined) row.strategy = normalizeStrategy(draft.strategy);
  if (draft.id) row.id = draft.id;

  if (!weekdays.length) {
    // A template with no weekdays never produces a slot. It saves, it looks
    // active, and it does nothing at all — the failure mode this whole feature
    // is least able to notice.
    notes.push('No weekdays are set, so this template will never fire until some are chosen.');
  }
  // The other silent dead end: mode 'off' means the Apply flow posts the stored
  // text verbatim, and there is none.
  if (!row.text && normalizeStrategy(row.strategy ?? existing?.strategy).mode === 'off') {
    notes.push('This template is set to static mode but has no text, so Apply will refuse it. Give it text, or give it a strategy.');
  }

  // .select('*'), not the explicit column list. The retry below drops `strategy`
  // from the PAYLOAD, and asking for it back in the SELECT made the retry fail
  // for the identical reason — so the graceful path was unreachable and the
  // reassuring note could never be shown.
  let { data, error } = await supabaseAdmin().from('schedule_templates').upsert(row).select('*').maybeSingle();
  // The autopilot migration may not have been run: save without the strategy
  // rather than failing the whole write, exactly as the route does.
  if (error && row.strategy !== undefined && /strategy/i.test(String(error.message || ''))) {
    delete row.strategy;
    ({ data, error } = await supabaseAdmin().from('schedule_templates').upsert(row).select('*').maybeSingle());
    if (!error) notes.push('Saved, but WITHOUT its strategy: the database is missing schedule_templates.strategy, so Autopilot cannot pick topics for it. Run supabase/autopilot.sql.');
  }
  if (error) {
    reportError('planner-admin:save', error);
    return { ok: false, message: 'The planner would not accept that template: ' + (error.message || 'unknown error') };
  }
  if (!data) return { ok: false, message: 'The planner saved nothing and reported no error, so I cannot confirm the template exists.' };

  return { ok: true, template: shape(data), notes };
}

/** Turn one template on or off. Pausing is preferred to deleting: it keeps the history. */
export async function setTemplateActive(
  userId: string,
  id: string,
  active: boolean,
): Promise<{ ok: true; template: PlannerTemplate } | { ok: false; message: string }> {
  const { data, error } = await supabaseAdmin()
    .from('schedule_templates')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select('*')
    .maybeSingle();
  if (error) {
    reportError('planner-admin:set-active', error);
    return { ok: false, message: 'Could not change that template just now.' };
  }
  if (!data) return { ok: false, message: 'There is no template with that id in this workspace.' };
  return { ok: true, template: shape(data) };
}

/**
 * The planner in words, for a tool result.
 *
 * Written as a person would read it — "Mon, Wed, Fri at 08:00" rather than
 * `[1,3,5]` — because the model repeats this back nearly verbatim, and a model
 * that has been handed day numbers talks to people in day numbers.
 */
export function describeTemplates(
  templates: readonly PlannerTemplate[],
  runs: readonly { templateId: string; scheduledFor: string; state: string }[] = [],
): string {
  if (!templates.length) {
    return 'No schedule templates exist yet. Nothing is planned, and Autopilot has nothing to run. ' +
      'One template produces at most one post per weekday, at its own time_of_day — so several posts a day means several templates.';
  }
  const byTemplate = new Map<string, number>();
  for (const r of runs) byTemplate.set(r.templateId, (byTemplate.get(r.templateId) || 0) + 1);

  const lines = templates.map((t) => {
    const days = t.weekdays.length ? t.weekdays.map((d) => DAY_NAMES[d]).join(', ') : 'NO DAYS SET — this never fires';
    const s = t.strategy;
    const subject =
      s.mode === 'off'
        ? 'static text (Autopilot does not pick topics for it)'
        : s.mode === 'fixed_topic'
          ? 'always "' + (s.topic || 'no topic set') + '"'
          : s.mode === 'pillars'
            ? 'rotating: ' + (s.pillars && s.pillars.length ? s.pillars.join(' / ') : 'NO PILLARS SET')
            : 'auto (the engine chooses)';
    const planned = byTemplate.get(t.id) || 0;
    return (
      '- [' + t.id + '] "' + t.name + '" — ' + (t.active ? 'active' : 'PAUSED') +
      ', ' + days + ' at ' + t.time_of_day + ' (Cancún)' +
      ', format ' + s.format + ', goal ' + s.goal +
      ', ' + subject +
      (t.providers.length ? ', to ' + t.providers.join(', ') : '') +
      ', ' + planned + ' slot(s) planned ahead.'
    );
  });

  // The times, said explicitly, because this is the fact that answers "how do I
  // post more than one blog a day" without any further reasoning.
  const times = [...new Set(templates.filter((t) => t.active).map((t) => t.time_of_day))].sort();
  return lines.join('\n') + '\n\nActive times of day: ' + (times.length ? times.join(', ') : 'none') + '.';
}
