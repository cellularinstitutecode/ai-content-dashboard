# End-to-end test harness

Runs the REAL app (built `next start`) against a mock Supabase backend, signs
in with a forged session cookie, and drives a real Chromium through every
panel. No external services, no secrets, fully deterministic.

## What it covers

- Middleware: pages 307 → `/sign-in`, APIs answer machine-readable 401s.
- Cron guards: `/api/autopilot/tick` and `/api/metricool/sync` reject a wrong
  bearer and run with `CRON_SECRET`; the Opus webhook fails closed unsigned.
- The Autopilot planner writes slots at 14:00 UTC = **09:00 America/Cancun**
  (the timezone rule, proven live through the real route).
- Template Apply materializes posts on the same clinic clock.
- All authenticated routes: stats, drafts (list/patch/delete), posts
  (list/reschedule), autopilot runs, templates, brand, semrush (degraded),
  drafts/image (cached image served even without an OpenAI key; a
  text-flagged image is never served as done).
- Browser: every panel renders from live data, boot shows only the hairline
  top bar (never an overlay), drafting raises the **panel-scoped** percentage
  loader inside the Content Generator, panels sit in workflow order
  on /draft (Create → Images → Repurpose → Schedule → Library; Autopilot and
  SEO live on the overview),
  ✓/✗ verification badges appear, an
  `announce()` from one panel makes the others refetch with no reload, the
  calendar/templates/brand pages render, and there are zero unexpected
  console errors or page crashes.

## The API suite (`e2e/api-e2e.cjs`)

A second, faster suite that drives the routes directly and checks the things
that reach a real social account. It runs against a **mock Metricool scheduler**
(`e2e/mock-metricool.cjs`) so the whole path can be proven without touching the
clinic's account:

- Applying a template really does send each slot to Metricool, as a **draft**,
  on the clinic clock (09:00 template → `09:00:00` + `America/Cancun` upstream,
  `14:00Z` stored), with the returned post id kept on the local row.
- Applying the same template twice creates nothing new and sends nothing new.
- An AI/pillars template (no fixed text) is refused instead of materialising a
  run of blank posts.
- Rescheduling moves the post **in Metricool**, and when Metricool refuses the
  move the local row is left exactly where it was — the two can never disagree.
- Deleting removes it from Metricool and from here; a refused upstream delete
  leaves the local row alone.
- A run that failed weeks ago is still listed, so "Needs attention" cannot be
  falsely empty.
- The cron guards still hold, and the tick reports what it expired.
- The advertising rule (lib/compliance.ts): an Instagram/Facebook post without
  "AVISO DE PUBLICIDAD: <permit>" and a "REF:" citation is refused at Send for
  review (422, naming the missing lines) and at Approve; the wrong permit
  number is refused; LinkedIn is untouched; with both lines it goes through.
- Sources (e2e/mock-google.cjs): Meriz's calendar is read across its monthly
  tabs (the planning grid skipped), Rodrigo's sheet with its Spanish headers
  and unnamed creator column, the image folder with thumbnails; "Use as hero
  image" copies a Drive photo into the app's storage; an approval writes a row
  to the calendar sheet's own "Dashboard Approvals" tab; a document not shared
  with the service account says so.
- Video Library → Prepare: a YouTube link is transcribed from the mock's
  caption track (an uploaded English track, an auto-generated Spanish one, and a
  video with none that asks for a pasted transcript), written up through the
  mock writer with REF + AVISO, saved as a video draft, and sent to Metricool
  as a LinkedIn draft. A network cell holding the published YouTube URL still
  reads as "on YouTube".
- Brand Brain stores a visual identity (palette normalized, roles inferred) and
  the brand-card route paints real 1080×1350 / 1080×1080 PNGs from a draft's
  caption (cover on the strong colour, body slides on paper; REF/AVISO/hashtag
  lines never become slides), refuses a text-flagged hero as a photo cover, and
  can set the cover as the post image marked `source: 'brand-card'`.
  Licensed typefaces round-trip through the mock's storage: a trial Nexa upload
  is refused (422) with the reason, a Rische upload is stored, listed and used by
  the next card (only the headline stays a stand-in), and removing it puts the
  body back on the stand-in.
- Keyword research over Semrush's MCP server (`e2e/mock-semrush-mcp.cjs`): a
  v4 key is routed through MCP with the app's v3 vocabulary translated to MCP
  parameter names (the mock rejects v3 codes like the real server), one
  session is reused, the CSV parses into a real brief, repeats hit the cache,
  spend is logged and the balance is allowance-minus-spend, the domain panel
  loads live, and "nothing found" / an MCP outage degrade without a crash.

The mock can be told to reject a call (`/__fail?method=PUT`) so the fail-closed
behaviour is exercised rather than assumed, and both mocks reset to their seed
(`/__reseed`, `/__reset`) so the suite is repeatable.

## How to run locally

```bash
cd web
# 1. env for the mock backend (do NOT deploy these values)
cat > .env.local <<'ENV'
# METRICOOL_API_BASE points the scheduler client at the local mock; production
# never sets it, and without it these tests would reach the real account.
METRICOOL_API_BASE=http://127.0.0.1:54322
METRICOOL_USER_TOKEN=e2e-metricool-token
METRICOOL_BLOG_ID=4308292
METRICOOL_USER_ID=3377431
ALLOWED_EMAILS=cellularhopeinstitute@gmail.com
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImV4cCI6MjAwMDAwMDAwMH0.mock
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiZXhwIjoyMDAwMDAwMDAwfQ.mock
CRON_SECRET=e2e-cron-secret
RATE_LIMIT_FAIL_OPEN=true
# A v4-shaped Semrush key is routed through the MCP transport; point it at the mock.
SEMRUSH_API_KEY=semrtkn-e2e-0000
SEMRUSH_MCP_URL=http://127.0.0.1:54323
# Google Sheets/Drive + Crossref stand-in (e2e/mock-google.cjs)
GOOGLE_API_BASE=http://127.0.0.1:54325
GOOGLE_STATIC_TOKEN=e2e-google-token
CROSSREF_API_BASE=http://127.0.0.1:54325/crossref
# YouTube captions + the Anthropic writer are also served by mock-google.cjs, so
# Video Library → Prepare runs offline end to end.
YOUTUBE_BASE=http://127.0.0.1:54325/yt
ANTHROPIC_API_BASE=http://127.0.0.1:54325/anthropic
ANTHROPIC_API_KEY=e2e-anthropic-key
ENV
# 2. backend + app
node e2e/mock-supabase.cjs &        # :54321
node e2e/mock-metricool.cjs &      # :54322
node e2e/mock-semrush-mcp.cjs &    # :54323
node e2e/mock-google.cjs &         # :54325 (Sheets, Drive, Crossref, YouTube, Anthropic)
npm run build && npx next start -p 3100 &
# 3. session cookie (writes /tmp/cookie.txt) — see browser-e2e.cjs header
# 4. the suites
npm run e2e:api
npm run e2e:browser
```

The mock's seed data includes one of everything the dashboard renders,
including an image whose verification carries `textDetected: true`, so the
red "✗ text — reroll" badge path is always exercised.
