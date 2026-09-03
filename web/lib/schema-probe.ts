// Which database objects the app needs, and how to say so when they are gone.
//
// The blind spot this closes: every migration in this repo is a .sql file a
// human is asked to paste into the Supabase SQL editor, and nothing ever
// checked that they did. Autopilot's engine writes template_runs and reads
// schedule_templates.strategy; when autopilot.sql had not been run, the engine
// failed on every tick with a PostgREST error nobody saw, the queue stayed
// empty, and /api/health — which only ever looked at environment variables —
// reported a healthy deployment. "It just never runs" is the hardest kind of
// broken to notice.
//
// Pure on purpose: the probing itself needs the service-role client and is in
// lib/schema-check.ts, but which objects matter and what to tell a person is
// worth testing without a database.

/** Postgres says a relation does not exist. */
export const MISSING_TABLE = '42P01';
/** Postgres says a column does not exist. */
export const MISSING_COLUMN = '42703';

export type SchemaProbe = {
  /** Table to read from. */
  table: string;
  /** Column to select — the probe reads no rows, only asks whether it resolves. */
  column: string;
  /**
   * Whether the COLUMN is the thing being checked. A missing table reported as
   * "provider_status.provider is missing" sends a reader looking for a column
   * in a table that is not there; a missing column reported as
   * "schedule_templates is missing" sends them looking for a table that is.
   */
  kind: 'table' | 'column';
  /** The migration file that creates it, so the detail can name a file to run. */
  file: string;
  /** What stops working without it — a short subject, deduplicated in the detail. */
  breaks: string;
};

export const REQUIRED_SCHEMA: SchemaProbe[] = [
  {
    table: 'template_runs',
    column: 'id',
    kind: 'table',
    file: 'supabase/autopilot.sql',
    breaks: 'Autopilot',
  },
  {
    // An ALTER TABLE, not a CREATE: a database can have template_runs and still
    // be missing this, so the table probe above would pass while the engine
    // still could not read a template's plan.
    table: 'schedule_templates',
    column: 'strategy',
    kind: 'column',
    file: 'supabase/autopilot.sql',
    breaks: 'Autopilot',
  },
  {
    table: 'provider_status',
    column: 'provider',
    kind: 'table',
    file: 'supabase/schema.sql',
    breaks: 'the images health check',
  },
];

/** Does this PostgREST error code mean the schema is behind the code? */
export function isMissingSchema(code: string | undefined | null): boolean {
  return code === MISSING_TABLE || code === MISSING_COLUMN;
}

/** One sentence naming exactly which files to run and what is broken until then. */
export function schemaDetail(missing: SchemaProbe[]): string {
  if (!missing.length) return 'Every table and column the app reads is present.';
  const files = [...new Set(missing.map((m) => m.file))];
  const what = [...new Set(missing.map((m) => (m.kind === 'table' ? m.table : m.table + '.' + m.column)))];
  const breaks = [...new Set(missing.map((m) => m.breaks))];
  return (
    'The database is behind the code: ' + what.join(', ') + ' ' +
    (what.length === 1 ? 'is' : 'are') + ' missing. Run ' + files.join(' and ') +
    ' in the Supabase SQL editor (' + (files.length === 1 ? 'it is' : 'both are') +
    ' safe to re-run). Until then this breaks ' + breaks.join(' and ') + '.'
  );
}
