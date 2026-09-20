// web/app/api/templates/strategy/route.ts
// "Load the weekly strategy" — the written calendar, written into the database.
//
// WHY THIS IS A ROUTE AND NOT FIFTEEN CLICKS. POST /api/templates is rate
// limited per user (it makes the org-wide Autopilot spend AI and Semrush
// credit), so a client loop writing fifteen templates would be refused
// somewhere around the fourth and leave a half-built calendar behind. One
// request, one rate-limit bucket, all fifteen or none of them.
//
// WHAT IT CANNOT DO. It cannot make anything publish. A seeded template
// produces drafts that wait in the review queue exactly like every other
// template; whether the engine may approve its own work is a separate setting
// that this route does not read, set or care about.
//
// The rules about WHICH rows to write, and what to do about ones that already
// exist, are in lib/strategy-seed.ts, where they are unit-tested without a
// database.
import { NextResponse } from 'next/server';
import { requireAllowlistedUser } from '@/lib/auth';
import { checkRateLimit } from '@/lib/rate-limit';
import { normalizeStrategy } from '@/lib/autopilot';
import { planSeed, seedSummary, type ExistingTemplate, type SeedRow } from '@/lib/strategy-seed';
import { supabaseServer } from '@/lib/supabase';
import { reportError } from '@/lib/report';

export const runtime = 'nodejs';

type Row = Record<string, unknown>;

function dbRow(userId: string, row: SeedRow, now: string): Row {
  const out: Row = {
    user_id: userId,
    name: row.name,
    providers: row.providers,
    // `text` is NOT NULL on this table and is the static Apply flow's copy.
    // A pillars template writes its own text every week, so this stays empty.
    text: '',
    weekdays: row.weekdays,
    time_of_day: row.time_of_day,
    active: row.active,
    // Through the engine's own normaliser, so this route cannot write a
    // strategy shape the engine would refuse to read.
    strategy: normalizeStrategy(row.strategy),
    updated_at: now,
  };
  if (row.id) out.id = row.id;
  return out;
}

export async function POST() {
  const auth = await requireAllowlistedUser();
  if (!auth.ok) return auth.response;
  const rl = await checkRateLimit(auth.userId, 'templates');
  if (!rl.ok) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });

  const sb = await supabaseServer();
  const userId = auth.userId;

  // What is already here. Read, not assumed: pressing this twice must leave
  // fifteen templates, not thirty, and this table has no unique key to fall
  // back on.
  //
  // `strategy` as well as the name: the mark inside it is what says a row
  // belongs to this seed and may be overwritten. Without it the seed would be
  // matching on name alone, which is how somebody's own "Nutrition" template
  // got absorbed.
  const { data: existing, error: readError } = await sb
    .from('schedule_templates')
    .select('id, name, strategy')
    .eq('user_id', userId);
  if (readError) {
    // Fail closed. Writing without knowing what is there is exactly how the
    // calendar doubles.
    reportError('templates:strategy-read', readError);
    return NextResponse.json(
      {
        error: 'unverified',
        message: 'Your existing templates could not be read just now, and loading the strategy without them could duplicate your week. Nothing was changed — try again in a moment.',
      },
      { status: 503 },
    );
  }

  const plan = planSeed((existing || []) as ExistingTemplate[]);
  const now = new Date().toISOString();
  const fresh = plan.create.map((r) => dbRow(userId, r, now));
  const existingRows = plan.update.map((r) => dbRow(userId, r, now));

  /**
   * INSERT and UPSERT are two calls, deliberately.
   *
   * PostgREST takes the union of the keys in a batch and sends the missing
   * ones as NULL rather than letting the column default fill them — so one
   * mixed batch would try to insert the new templates with `id: null` and be
   * refused by the primary key. Splitting them is what makes a first press and
   * a second press both work.
   *
   * WHICH LEGS HAVE ALREADY RUN. A retry used to re-enter this function and
   * re-run the INSERT leg with it — so an insert that succeeded followed by an
   * upsert that failed with any message containing "strategy" wrote fifteen
   * brand-new templates on top of the fifteen just written, and answered
   * `ok: true`. Thirty templates, thirty posts a week, at full model and
   * Semrush cost, from the one route whose whole purpose is to make a second
   * press safe.
   *
   * Nothing re-enters `write` today (the degrade path is gone), but the flags
   * stay: the next person to add a retry gets the safe behaviour for free.
   */
  let inserted = false;
  let updated = false;

  async function write(withStrategy: boolean): Promise<{ message: string } | null> {
    const strip = (rows: Row[]) =>
      withStrategy
        ? rows
        : rows.map((r) => {
            const copy = { ...r };
            delete copy.strategy;
            return copy;
          });
    if (fresh.length && !inserted) {
      const { error } = await sb.from('schedule_templates').insert(strip(fresh)).select('id');
      if (error) return { message: error.message };
      inserted = true;
    }
    if (existingRows.length && !updated) {
      const { error } = await sb.from('schedule_templates').upsert(strip(existingRows)).select('id');
      if (error) return { message: error.message };
      updated = true;
    }
    return null;
  }

  const failure = await write(true);
  if (failure) {
    reportError('templates:strategy-write', new Error(failure.message));
    // NO DEGRADE PATH HERE, deliberately, and this used to have one.
    //
    // Writing the rows without their `strategy` — which is what a database
    // missing the autopilot migration forces — produces fifteen templates that
    // are inert (`mode` defaults to 'off', so they write nothing) AND unmarked,
    // so the next press cannot recognise them and creates fifteen more. A
    // calendar that does nothing and doubles on retry is worse than a refusal
    // that names the migration.
    const migrationMissing = /strategy/i.test(failure.message);
    return NextResponse.json(
      {
        error: migrationMissing ? 'migration_missing' : 'write_failed',
        message: migrationMissing
          ? 'This database has not had the Autopilot migration run yet, so the rotation has nowhere to be stored — and slots written without it would do nothing. Run web/supabase/autopilot.sql (GO-LIVE.md, step 2), then press this again. Nothing was changed.'
          : failure.message,
      },
      { status: migrationMissing ? 409 : 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    created: plan.create.length,
    updated: plan.update.length,
    duplicates: plan.duplicates,
    collisions: plan.collisions,
    message: seedSummary(plan),
  });
}
