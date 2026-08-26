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
  (Create → Images → Repurpose → Schedule → Autopilot → Library),
  ✓/✗ verification badges appear, an
  `announce()` from one panel makes the others refetch with no reload, the
  calendar/templates/brand pages render, and there are zero unexpected
  console errors or page crashes.

## How to run locally

```bash
cd web
# 1. env for the mock backend (do NOT deploy these values)
cat > .env.local <<'ENV'
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImV4cCI6MjAwMDAwMDAwMH0.mock
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiZXhwIjoyMDAwMDAwMDAwfQ.mock
CRON_SECRET=e2e-cron-secret
RATE_LIMIT_FAIL_OPEN=true
ENV
# 2. backend + app
node e2e/mock-supabase.cjs &        # :54321
npm run build && npx next start -p 3100 &
# 3. session cookie (writes /tmp/cookie.txt) — see browser-e2e.cjs header
# 4. the suite
node e2e/browser-e2e.cjs
```

The mock's seed data includes one of everything the dashboard renders,
including an image whose verification carries `textDetected: true`, so the
red "✗ text — reroll" badge path is always exercised.
