// web/app/api/templates/strategy/route.ts
// "Load the weekly strategy" — the written calendar, written into the database.
//
// WHY THIS IS A ROUTE AND NOT FOURTEEN CLICKS. POST /api/templates is rate
// limited per user (it makes the org-wide Autopilot spend AI and Semrush
// credit), so a client loop writing fourteen templates would be refused
// somewhere around the fourth and leave a half-built calendar behind. One
// request, one rate-limit bucket, all fourteen or none of them.
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
import { planSeed, seedSummary, type SeedRow } from '@/lib/strategy-seed';
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
  // fourteen templates, not twenty-eight, and this table has no unique key to
  // fall back on.
  const { data: existing, error: readError } = await sb
    .from('schedule_templates')
    .select('id, name')
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

  const plan = planSeed((existing || []) as { id?: unknown; name?: unknown }[]);
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
   */
  async function write(withStrategy: boolean): Promise<{ message: string } | null> {
    const strip = (rows: Row[]) =>
      withStrategy
        ? rows
        : rows.map((r) => {
            const copy = { ...r };
            delete copy.strategy;
            return copy;
          });
    if (fresh.length) {
      const { error } = await sb.from('schedule_templates').insert(strip(fresh)).select('id');
      if (error) return { message: error.message };
    }
    if (existingRows.length) {
      const { error } = await sb.from('schedule_templates').upsert(strip(existingRows)).select('id');
      if (error) return { message: error.message };
    }
    return null;
  }

  let failure = await write(true);
  // The same graceful degrade POST /api/templates carries: a database without
  // the autopilot migration has no strategy column. The calendar is still
  // worth having; the rotation is what waits for the migration.
  let withoutStrategy = false;
  if (failure && /strategy/i.test(failure.message)) {
    failure = await write(false);
    withoutStrategy = !failure;
  }
  if (failure) {
    reportError('templates:strategy-write', new Error(failure.message));
    return NextResponse.json({ error: 'write_failed', message: failure.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    created: plan.create.length,
    updated: plan.update.length,
    duplicates: plan.duplicates,
    message:
      seedSummary(plan) +
      (withoutStrategy
        ? ' The rotation could not be saved because this database has not had the autopilot migration run yet — the slots are there, but they will not write anything until it has.'
        : ''),
  });
}
