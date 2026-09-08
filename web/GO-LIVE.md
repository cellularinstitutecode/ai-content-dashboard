# Go-Live Checklist

The one page that tracks everything the code cannot set for itself. Items are
ordered; a fresh deployment is fully armed when every box is checked.
(Never commit real secret values to this repo — this file names them only.)

## 1. Vercel environment variables

Set at: https://vercel.com/cellularinstitutecodes-projects/ai-content-dashboard/settings/environment-variables

| Variable | Status | Notes |
|---|---|---|
| `CRON_SECRET` | ✅ set | Verified in the Vercel project on 2026-08-28. Without it both daily crons 401. |
| `SEMRUSH_API_KEY` | ✅ set | Verified 2026-08-28. Also `SEMRUSH_PROJECT_ID` is set, so the Site Health tab is live. |
| `ALLOWED_EMAILS` | ☐ MISSING | Still unset. The allowlist falls back to a hardcoded address in `lib/access.ts`, so the app is not open — but adding a teammate needs a code change and a deploy. Set it to the same list as `NEXT_PUBLIC_ALLOWED_EMAILS`. |
| `OPENAI_API_KEY` | ✅ set | Needs API credits at https://platform.openai.com/settings/organization/billing (separate from ChatGPT credits). |
| `ANTHROPIC_API_KEY`, `AI_PROVIDER`, `*_MODEL` | ✅ set | |
| `METRICOOL_USER_TOKEN` / `METRICOOL_BLOG_ID` / `METRICOOL_USER_ID` | ✅ set | |
| `OPUS_API_KEY` | ✅ set | Optional extras: `OPUS_WEBHOOK_URL` + `OPUS_WEBHOOK_SECRET` enable the push webhook; without them the poll fallback still delivers clips. |
| Supabase trio (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) | ✅ set | |
| `GOOGLE_SERVICE_ACCOUNT_JSON` / `DRIVE_FOLDER_ID` | ✅ set | Permanent clip storage. |
| `MANGOOLS_API_TOKEN` | ✅ removed | Was replaced by Semrush (PR #105); no longer present in the project. |
| `ASSISTANT_SESSION_SECRET` | ☐ MISSING | Unset, so the assistant borrows `CRON_SECRET` to sign its session. It works, but rotating one silently invalidates the other. Generate: `openssl rand -hex 32`. |
| `OPUS_WEBHOOK_URL` / `OPUS_WEBHOOK_SECRET` | ☐ MISSING | Unset, so finished clips arrive by polling only. Set both to enable the push webhook. |

After ANY env change: redeploy — env vars only apply to new deployments.
https://vercel.com/cellularinstitutecodes-projects/ai-content-dashboard/deployments → ⋯ → Redeploy.

## 2. Supabase: apply the RLS policies

The per-user data isolation relies on Row-Level Security. Re-run the (now
valid, idempotent) migrations after any schema change:

1. Open https://supabase.com/dashboard/project/_/sql/new
2. Paste and run `web/supabase/schema.sql`
3. Paste and run `web/supabase/semrush.sql` and `web/supabase/autopilot.sql`
   (all use guarded DO blocks — safe to re-run any time)

**Required for this release:** `schema.sql` now adds a `posts: owner delete`
policy. Without it, deleting a scheduled post removes nothing — RLS refuses the
delete by returning zero rows rather than an error. The route detects this and
says so, but the fix is to re-run `schema.sql`.

## 3. Verify after deploy

**Start here: `GET /api/health`** (signed in as an allowlisted user). It reports
every check in section 1 as configuration state — `status: "degraded"` and a 503
when anything required is missing, with the consequence spelled out per item. It
never prints a secret and makes no upstream calls. The manual probes below stay
useful for the auth behaviour it cannot check for itself.


- `GET /api/metricool/sync` **without** auth → must answer `401 {"error":"unauthorized"}` (NOT a redirect to /sign-in). Redirect = middleware regression, crons dead.
- `GET /api/metricool/sync` with a WRONG bearer (`Authorization: Bearer nope`) → must answer `401`. The machine-path exemption is value-based; if a junk bearer gets any further, it has regressed to the header-presence check that let a non-allowlisted account reach this route (see `lib/machine-auth.test.ts`).
- `POST /api/metricool/schedule` with `{"autoPublish": true}` in the body → the parameter must be ignored and the post must still land in Metricool as a **draft**. Publishing is a property of the server, never of the request.
- `POST /api/opus/webhook` unsigned → `401` (signature check reachable) — `503` means the webhook secret is unset.
- `POST /api/templates/apply` for a template with real text → the posts must
  appear **in Metricool** as drafts, and each row in the publishing queue must
  carry a Metricool id. Applying the same template twice must create nothing the
  second time. Applying an AI/pillars template must be refused with a message
  pointing at the Autopilot queue.
- Drag a post to another day on the calendar → open Metricool and confirm it
  moved **there** too. If Metricool refuses, the dashboard must show an error and
  leave the post where it was — the calendar must never disagree with the account.
- Delete a scheduled post from the publishing queue → it must disappear from
  Metricool as well. (If it does not delete at all, the RLS policy above is
  missing.)
- Generate a pack in the dashboard → the process tracker must walk research → draft → save → image → verify, and the Image Studio gallery + stat cards must update without a reload.
- Vercel production deploy: confirm each merge to `main` actually produced a **Production** deployment (on 2026-08-19 Vercel silently skipped one and the preview had to be promoted by hand).

## 4. Known-open items (nice to have)

- Semrush Site Health tab needs `SEMRUSH_PROJECT_ID` (Projects API access).
- `SEMRUSH_UNIT_FLOOR` (default 5000) guards the unit pot — tune if needed.
- **Sources** (`/sources`): the three Google documents are read with the same
  service account as clip storage (`GOOGLE_SERVICE_ACCOUNT_JSON`). Share Meriz's
  calendar sheet, Rodrigo's video sheet and the images folder with the service
  account's email as **Editor** (the email is shown by `/api/sources?kind=status`).
  Ids default to the clinic's documents; `SOURCES_CALENDAR_SHEET_ID`,
  `SOURCES_VIDEOS_SHEET_ID`, `SOURCES_IMAGES_FOLDER_ID` override them. Every
  approval on the dashboard appends a row to the calendar sheet's
  "Dashboard Approvals" tab.
- **Advertising rule**: Instagram/Facebook posts must carry
  `AVISO DE PUBLICIDAD: <permit>` and a `REF:` citation (`lib/compliance.ts`).
  The permit number lives in Brand Brain (`brand_profiles.aviso_publicidad`;
  run the `alter table` in `supabase/schema.sql`), with `AVISO_PUBLICIDAD` as
  the environment fallback. Citations are checked against Crossref
  (`CROSSREF_API_BASE` overrides the host for tests).
- **Video Library → Prepare**: a YouTube link is transcribed from the video's
  own caption track (no key needed; `YOUTUBE_BASE` overrides the host for
  tests), run through the keyword brief, written as a LinkedIn post and a
  TikTok caption (with REF + AVISO), saved as a draft, and only then sent to
  Metricool for review on the date you pick. Videos with no captions ask for a
  pasted transcript. `ANTHROPIC_API_BASE` overrides the writer's host for tests.
- **Calendar / Publishing**: the month grid on the left, the ordered
  "Publishing list" (everything from today on, Approve / +1 day / Delete) on
  the right. **Draft** (`/draft`) holds the generators and the composer; the
  Dashboard keeps the stats, Semrush and the Autopilot queue.
- **Weekly planner** (Templates): one theme per weekday, several slots a day.
  Each slot is a `fixed_topic` Autopilot template — the subject stays, the
  angle/keyword/citation change every occurrence, so nothing is copy-paste.
- A v4 key (`semrtkn-…`, the only kind the API Keys page issues on a Pro plan)
  is routed through Semrush's MCP server automatically (`lib/semrush-transport.ts`);
  any other key shape goes to the Standard API (v3). `SEMRUSH_TRANSPORT=v3|mcp`
  forces one. Over MCP the balance is `SEMRUSH_UNIT_ALLOWANCE` (default 50,000,
  the monthly Standard API pool) minus the spend this app has logged this month;
  `SEMRUSH_MCP_URL` overrides the server (the e2e harness points it at a mock).
