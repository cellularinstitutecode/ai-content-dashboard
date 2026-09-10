// Ask the database whether it has what the code expects.
//
// Every migration here is a .sql file somebody is asked to paste into the
// Supabase SQL editor by hand, and until now nothing checked that they had.
// See lib/schema-probe.ts for what is checked and why.
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { REQUIRED_SCHEMA, isMissingSchema, type SchemaProbe } from './schema-probe.ts';

/**
 * Probe every required table and column. Reads no rows: `limit(0)` is enough
 * for Postgres to resolve the names and answer 42P01/42703 if it cannot.
 *
 * Only a MISSING-SCHEMA error counts. A network failure or a permissions
 * problem is not evidence that a migration was skipped, and reporting one as
 * such would send a person to run SQL that was never the problem.
 */
export async function missingSchema(): Promise<SchemaProbe[]> {
  const results = await Promise.all(
    REQUIRED_SCHEMA.map(async (probe) => {
      try {
        const { error } = await supabaseAdmin().from(probe.table).select(probe.column).limit(0);
        return isMissingSchema(error?.code) ? probe : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((p): p is SchemaProbe => p !== null);
}

/**
 * The same answer, but not re-probed on every keystroke.
 *
 * `missingSchema` costs one query per required table and column — fourteen of
 * them — and the assistant now asks on every single message so it can say
 * "the database is missing an update" before offering to do something that
 * depends on it. Fourteen queries per chat turn to answer a question whose
 * answer only changes when a person pastes SQL into a browser is a poor trade.
 *
 * Deliberately NOT used by /api/health: that page is what somebody reloads
 * immediately after running the migration, and a cached "still missing" there
 * would have them running it a second time.
 */
let schemaCache: { at: number; value: SchemaProbe[] } | null = null;

export async function missingSchemaCached(ttlMs = 60_000): Promise<SchemaProbe[]> {
  if (schemaCache && Date.now() - schemaCache.at < ttlMs) return schemaCache.value;
  const value = await missingSchema();
  schemaCache = { at: Date.now(), value };
  return value;
}
