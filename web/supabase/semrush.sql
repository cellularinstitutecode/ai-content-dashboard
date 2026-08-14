-- Semrush Brain: cache, usage log, and draft-keyword learnings.
-- Run this in your Supabase SQL editor once (safe to re-run).
--
-- semrush_cache   — every Semrush lookup is stored here for
--                   SEMRUSH_CACHE_TTL_DAYS (default 30). Repeat topics cost 0
--                   API units. Server-only access (service role); RLS is
--                   enabled with no public policies on purpose.
-- semrush_usage   — append-only spend log (live/cache/seed) for auditing.
-- draft_keywords  — which keywords each generated draft applied; joined with
--                   post_metrics later to learn what performs.

create table if not exists public.semrush_cache (
  id bigserial primary key,
  cache_key text not null unique,
  report text not null,
  database text not null,
  phrase text not null,
  payload jsonb not null,
  units_spent integer not null default 0,
  fetched_at timestamptz not null default now()
);

create index if not exists semrush_cache_key_idx on public.semrush_cache (cache_key);

create table if not exists public.semrush_usage (
  id bigserial primary key,
  report text not null,
  phrase text,
  units integer not null default 0,
  source text not null default 'live',
  created_at timestamptz not null default now()
);

create table if not exists public.draft_keywords (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  topic text not null,
  keyword text not null,
  volume integer,
  difficulty integer,
  intent text,
  role text not null default 'supporting',
  created_at timestamptz not null default now()
);

create index if not exists draft_keywords_user_time_idx
  on public.draft_keywords (user_id, created_at desc);

-- Server-only tables: RLS on, no public policies (service role bypasses RLS).
alter table public.semrush_cache enable row level security;
alter table public.semrush_usage enable row level security;
alter table public.draft_keywords enable row level security;

-- Users may read their own draft-keyword history (for the learnings view).
create policy if not exists "draft_keywords: owner read" on public.draft_keywords
  for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Seed: real Semrush data pulled 2026-08-13 for the clinic's core topics, so
-- the hub and the drafting brain are warm before the API key is even set.
-- (Fetched via the Semrush MCP; ~2,400 units, already spent.)
-- ---------------------------------------------------------------------------

insert into public.semrush_cache (cache_key, report, database, phrase, payload, units_spent)
values ('phrase_related:us:stem cell therapy', 'phrase_related', 'us', 'stem cell therapy', '[{"keyword":"stem cells","volume":40500,"cpc":1.61,"difficulty":93,"intents":["informational"]},{"keyword":"stem cells and treatment","volume":27100,"cpc":2.7,"difficulty":55,"intents":["informational"]},{"keyword":"bone marrow transplant","volume":22200,"cpc":2.08,"difficulty":46,"intents":["informational","commercial"]},{"keyword":"stem cells cell","volume":22200,"cpc":1.61,"difficulty":67,"intents":["informational"]},{"keyword":"bm transplantation","volume":18100,"cpc":2.08,"difficulty":62,"intents":["informational"]},{"keyword":"bmt transplantation","volume":18100,"cpc":2.08,"difficulty":59,"intents":["informational"]},{"keyword":"stem cells and","volume":18100,"cpc":1.61,"difficulty":85,"intents":["informational"]},{"keyword":"stem cell","volume":14800,"cpc":1.61,"difficulty":88,"intents":["informational"]},{"keyword":"stemcell","volume":14800,"cpc":1.61,"difficulty":75,"intents":["informational"]},{"keyword":"what are stem cells","volume":14800,"cpc":0.83,"difficulty":47,"intents":["informational"]}]'::jsonb, 400)
on conflict (cache_key) do update
  set payload = excluded.payload, units_spent = excluded.units_spent, fetched_at = now();

insert into public.semrush_cache (cache_key, report, database, phrase, payload, units_spent)
values ('phrase_related:us:stem cell therapy for knee pain', 'phrase_related', 'us', 'stem cell therapy for knee pain', '[{"keyword":"stem cell procedures for knees","volume":2400,"cpc":1.95,"difficulty":17,"intents":["informational"]},{"keyword":"stem cell therapy for knees","volume":2400,"cpc":null,"difficulty":40,"intents":["informational","commercial"]},{"keyword":"knee joint stem cell injections","volume":1900,"cpc":1.95,"difficulty":26,"intents":["informational"]},{"keyword":"stem cell shots in the knee","volume":1900,"cpc":1.95,"difficulty":23,"intents":["informational"]},{"keyword":"stem cell exosome joint pain","volume":1000,"cpc":null,"difficulty":0,"intents":["informational"]},{"keyword":"do stem cell injections work","volume":720,"cpc":0.59,"difficulty":19,"intents":["informational"]},{"keyword":"stem cell knee injections","volume":720,"cpc":null,"difficulty":22,"intents":["informational"]},{"keyword":"stem cell procedure for arthritis","volume":720,"cpc":null,"difficulty":38,"intents":["informational"]},{"keyword":"stem cell shots for arthritis","volume":720,"cpc":null,"difficulty":30,"intents":["informational"]},{"keyword":"stem cells cure arthritis","volume":720,"cpc":null,"difficulty":34,"intents":["informational"]}]'::jsonb, 400)
on conflict (cache_key) do update
  set payload = excluded.payload, units_spent = excluded.units_spent, fetched_at = now();

insert into public.semrush_cache (cache_key, report, database, phrase, payload, units_spent)
values ('phrase_related:us:stem cell therapy mexico', 'phrase_related', 'us', 'stem cell therapy mexico', '[{"keyword":"cpi tijuana","volume":1000,"cpc":1.08,"difficulty":26,"intents":["navigational"]},{"keyword":"r3 stem cell","volume":1000,"cpc":2.5,"difficulty":38,"intents":["navigational"]},{"keyword":"stem cell therapy tijuana","volume":1000,"cpc":null,"difficulty":16,"intents":["commercial"]},{"keyword":"cpi stem cells tijuana","volume":880,"cpc":1.32,"difficulty":16,"intents":["navigational"]},{"keyword":"mexico stem cell therapy","volume":880,"cpc":null,"difficulty":39,"intents":["commercial"]},{"keyword":"stem cell institute","volume":880,"cpc":2.9,"difficulty":53,"intents":["navigational"]},{"keyword":"stem cell mexico","volume":880,"cpc":1.65,"difficulty":50,"intents":["commercial"]},{"keyword":"cpi stem cells cost","volume":720,"cpc":1.35,"difficulty":6,"intents":["informational"]},{"keyword":"stem cell therapy in mexico","volume":720,"cpc":null,"difficulty":38,"intents":["commercial"]},{"keyword":"stem cells mexico","volume":720,"cpc":1.65,"difficulty":35,"intents":["commercial"]}]'::jsonb, 400)
on conflict (cache_key) do update
  set payload = excluded.payload, units_spent = excluded.units_spent, fetched_at = now();

insert into public.semrush_cache (cache_key, report, database, phrase, payload, units_spent)
values ('phrase_related:us:anti aging treatment', 'phrase_related', 'us', 'anti aging treatment', '[{"keyword":"wrinkle cream","volume":550000,"cpc":1.36,"difficulty":59,"intents":["informational","commercial"]},{"keyword":"anti aging products","volume":368000,"cpc":1.88,"difficulty":62,"intents":["informational","commercial"]},{"keyword":"facial","volume":60500,"cpc":1.89,"difficulty":59,"intents":["commercial"]},{"keyword":"how to stay young","volume":40500,"cpc":0.5,"difficulty":37,"intents":["informational"]},{"keyword":"skincare anti aging products","volume":27100,"cpc":2.78,"difficulty":58,"intents":["informational"]},{"keyword":"skincare for anti ageing","volume":27100,"cpc":2.78,"difficulty":58,"intents":["informational","commercial"]},{"keyword":"anti wrinkle cream age","volume":14800,"cpc":1.82,"difficulty":62,"intents":["informational","commercial"]},{"keyword":"best skincare for aging skin","volume":14800,"cpc":2.63,"difficulty":43,"intents":["commercial"]},{"keyword":"spf wrinkles","volume":12100,"cpc":0.74,"difficulty":12,"intents":["informational"]},{"keyword":"wrinkles","volume":12100,"cpc":2.23,"difficulty":75,"intents":["informational"]}]'::jsonb, 400)
on conflict (cache_key) do update
  set payload = excluded.payload, units_spent = excluded.units_spent, fetched_at = now();

insert into public.semrush_cache (cache_key, report, database, phrase, payload, units_spent)
values ('phrase_related:us:stem cell therapy for copd', 'phrase_related', 'us', 'stem cell therapy for copd', '[{"keyword":"stem cell gas to heal copd","volume":1600,"cpc":null,"difficulty":0,"intents":["informational"]},{"keyword":"possible simple cure for emphysema","volume":1000,"cpc":1.37,"difficulty":46,"intents":["informational"]},{"keyword":"cell treatment for copd","volume":210,"cpc":null,"difficulty":17,"intents":["informational"]},{"keyword":"copd cure stem cell","volume":210,"cpc":null,"difficulty":11,"intents":["informational"]},{"keyword":"stem cell research for copd","volume":210,"cpc":null,"difficulty":22,"intents":["informational"]},{"keyword":"copd stem cell therapy","volume":170,"cpc":null,"difficulty":13,"intents":["informational"]},{"keyword":"is there a cure for emphysema","volume":170,"cpc":null,"difficulty":38,"intents":["informational"]},{"keyword":"stem cell for copd","volume":170,"cpc":null,"difficulty":23,"intents":["informational"]},{"keyword":"copd and stem cell","volume":140,"cpc":null,"difficulty":25,"intents":["informational"]},{"keyword":"stem cells and copd","volume":140,"cpc":null,"difficulty":17,"intents":["informational"]}]'::jsonb, 400)
on conflict (cache_key) do update
  set payload = excluded.payload, units_spent = excluded.units_spent, fetched_at = now();

insert into public.semrush_cache (cache_key, report, database, phrase, payload, units_spent)
values ('phrase_questions:us:stem cell therapy', 'phrase_questions', 'us', 'stem cell therapy', '[{"keyword":"what is stem cell therapy","volume":4400,"cpc":1.08,"difficulty":34,"intents":["informational"]},{"keyword":"how much does stem cell therapy cost","volume":1300,"cpc":1.79,"difficulty":22,"intents":["informational"]},{"keyword":"how much is stem cell therapy","volume":1300,"cpc":null,"difficulty":16,"intents":["informational"]},{"keyword":"is stem cell therapy legal in the us","volume":880,"cpc":null,"difficulty":21,"intents":["informational"]},{"keyword":"does stem cell therapy work","volume":720,"cpc":null,"difficulty":41,"intents":["informational"]}]'::jsonb, 200)
on conflict (cache_key) do update
  set payload = excluded.payload, units_spent = excluded.units_spent, fetched_at = now();

insert into public.semrush_cache (cache_key, report, database, phrase, payload, units_spent)
values ('phrase_questions:us:stem cell therapy for knee pain', 'phrase_questions', 'us', 'stem cell therapy for knee pain', '[{"keyword":"does stem cell therapy work for knee pain in charlotte","volume":20,"cpc":null,"difficulty":0,"intents":[]},{"keyword":"is stem cell therapy for knees painful","volume":20,"cpc":null,"difficulty":0,"intents":[]},{"keyword":"what is stem cell therapy for knee pain","volume":10,"cpc":null,"difficulty":0,"intents":[]},{"keyword":"does medicare cover stem cell therapy for knee pain","volume":0,"cpc":null,"difficulty":0,"intents":[]},{"keyword":"does stem cell therapy work for knee pain","volume":0,"cpc":null,"difficulty":0,"intents":[]}]'::jsonb, 200)
on conflict (cache_key) do update
  set payload = excluded.payload, units_spent = excluded.units_spent, fetched_at = now();

insert into public.semrush_usage (report, phrase, units, source)
values ('seed', 'initial cache seed (7 reports)', 2400, 'seed');
