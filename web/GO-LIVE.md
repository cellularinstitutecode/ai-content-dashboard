# Go-Live Checklist

The one page that tracks everything the code cannot set for itself. Items are
ordered; a fresh deployment is fully armed when every box is checked.
(Never commit real secret values to this repo — this file names them only.)

## 1. Vercel environment variables

Set at: https://vercel.com/cellularinstitutecodes-projects/ai-content-dashboard/settings/environment-variables

| Variable | Status | Notes |
|---|---|---|
| `CRON_SECRET` | ☐ MISSING | Required — without it the daily Autopilot tick and Metricool metrics sync (vercel.json crons) get 401s. Generate: `openssl rand -hex 32`. |
| `SEMRUSH_API_KEY` | ☐ MISSING | Required for live keyword data in every draft. Create the key at https://www.semrush.com/api-use/ (account already holds API units). Until set, drafts fall back to cache/link-out. |
| `ALLOWED_EMAILS` | ☐ MISSING | Server-side sign-in allowlist. Set to the same list as `NEXT_PUBLIC_ALLOWED_EMAILS` (which only powers the client-side hint). |
| `OPENAI_API_KEY` | ✅ set | Needs API credits at https://platform.openai.com/settings/organization/billing (separate from ChatGPT credits). |
| `ANTHROPIC_API_KEY`, `AI_PROVIDER`, `*_MODEL` | ✅ set | |
| `METRICOOL_USER_TOKEN` / `METRICOOL_BLOG_ID` / `METRICOOL_USER_ID` | ✅ set | |
| `OPUS_API_KEY` | ✅ set | Optional extras: `OPUS_WEBHOOK_URL` + `OPUS_WEBHOOK_SECRET` enable the push webhook; without them the poll fallback still delivers clips. |
| Supabase trio (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) | ✅ set | |
| `GOOGLE_SERVICE_ACCOUNT_JSON` / `DRIVE_FOLDER_ID` | ✅ set | Permanent clip storage. |
| `MANGOOLS_API_TOKEN` | 🗑 delete | Dead — Mangools was replaced by Semrush (PR #105). |

After ANY env change: redeploy — env vars only apply to new deployments.
https://vercel.com/cellularinstitutecodes-projects/ai-content-dashboard/deployments → ⋯ → Redeploy.

## 2. Supabase: apply the RLS policies

The per-user data isolation relies on Row-Level Security. Re-run the (now
valid, idempotent) migrations after any schema change:

1. Open https://supabase.com/dashboard/project/_/sql/new
2. Paste and run `web/supabase/schema.sql`
3. Paste and run `web/supabase/semrush.sql` and `web/supabase/autopilot.sql`
   (all use guarded DO blocks — safe to re-run any time)

## 3. Verify after deploy

- `GET /api/metricool/sync` **without** auth → must answer `401 {"error":"unauthorized"}` (NOT a redirect to /sign-in). Redirect = middleware regression, crons dead.
- `POST /api/opus/webhook` unsigned → `401` (signature check reachable) — `503` means the webhook secret is unset.
- Generate a pack in the dashboard → the process tracker must walk research → draft → save → image → verify, and the Image Studio gallery + stat cards must update without a reload.
- Vercel production deploy: confirm each merge to `main` actually produced a **Production** deployment (on 2026-08-19 Vercel silently skipped one and the preview had to be promoted by hand).

## 4. Known-open items (nice to have)

- Semrush Site Health tab needs `SEMRUSH_PROJECT_ID` (Projects API access).
- `SEMRUSH_UNIT_FLOOR` (default 5000) guards the unit pot — tune if needed.
