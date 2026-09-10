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
    table: 'video_runs',
    column: 'id',
    kind: 'table',
    file: 'supabase/video-autopilot.sql',
    breaks: 'the video sweep — every row would be re-transcribed and re-paid for on every run',
  },
  {
    // An ALTER TABLE at the foot of the same file, added after the first
    // version shipped: a database can have video_runs and still be missing
    // this, so the table probe above would pass while every Metricool hand-off
    // failed to record what it had done.
    table: 'video_runs',
    column: 'metricool',
    kind: 'column',
    file: 'supabase/video-autopilot.sql',
    breaks: 'the record of which posts reached Metricool',
  },
  {
    // Also an ALTER TABLE at the foot of that file. Without it the sweep
    // cannot tell a row that ran out of time from one that needs a person, so
    // it falls back to retrying everything the same number of times — which is
    // the behaviour this column was added to end.
    table: 'video_runs',
    column: 'last_error_code',
    kind: 'column',
    file: 'supabase/video-autopilot.sql',
    breaks: 'knowing which failures are worth retrying — every row gets the same three tries and then stops for good',
  },
  {
    // The ceiling on automatic retries. Without it the revive pass cannot
    // count how many times it has already brought a row back, so it either
    // never retries or retries forever — and each retry is a full download
    // and transcription.
    table: 'video_runs',
    column: 'revivals',
    kind: 'column',
    file: 'supabase/video-autopilot.sql',
    breaks: 'the automatic retry of stalled videos — they stay stopped until somebody notices',
  },
  {
    // The TABLE, checked before any of its columns.
    //
    // Without this entry a missing table was reported as
    // "video_transcripts.public_copy_id is missing" — sending a reader hunting for a
    // column inside a table that is not there, which is the precise confusion the `kind`
    // field exists to prevent, and I introduced it. Worse, the consequence named was the
    // Drive-copy dedupe, so nothing anywhere said the thing that actually mattered: with
    // no transcript store, every Prepare re-downloads and re-transcribes the video, and
    // the app tells the person to press the button again, for ever.
    table: 'video_transcripts',
    column: 'video_id',
    kind: 'table',
    file: 'supabase/video-autopilot.sql',
    breaks: 'the transcript store — every video is downloaded and transcribed again on every attempt, and a long one can never finish',
  },
  {
    // The two halves of not leaving world-readable copies of the clinic's footage lying
    // about: one to find the copy a previous run already made, one to know when nothing
    // needs it any more. Without them the delete path is silently a no-op.
    table: 'video_transcripts',
    column: 'public_copy_id',
    kind: 'column',
    file: 'supabase/video-autopilot.sql',
    breaks: 'reusing a video\u2019s public copy — every run would make another one, and none could be removed',
  },
  {
    table: 'posts',
    column: 'media_drive_file_id',
    kind: 'column',
    file: 'supabase/schema.sql',
    breaks: 'removing a public video copy once the last post using it is deleted',
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
  {
    table: 'brand_profiles',
    column: 'aviso_publicidad',
    kind: 'column',
    file: 'supabase/schema.sql',
    breaks: 'the advertising-notice setting in Brand Brain',
  },
  {
    // Declared inside the CREATE TABLE, which is why it can be absent: that
    // statement is a no-op on a database where the table already exists, so a
    // column added to it later never arrives. lib/sweep-owner.ts ordered by
    // this one, and its absence took down every automatic run with a message
    // about the Brand Brain rather than about a missing column.
    table: 'brand_profiles',
    column: 'created_at',
    kind: 'column',
    file: 'supabase/schema.sql',
    breaks: 'the automatic video runs — the nightly pass and the sheet\u2019s own trigger both stop, and every video has to be prepared by hand',
  },
  {
    table: 'brand_profiles',
    column: 'visual',
    kind: 'column',
    file: 'supabase/schema.sql',
    breaks: 'the visual identity (palette, photography direction) in Brand Brain — images fall back to the brand-guide defaults',
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
