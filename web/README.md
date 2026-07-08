# AI Content Dashboard — Next.js app

Full-stack rebuild of the dashboard at \`/index.html\`. Lives in this \`web/\` subfolder. Deploys as a **new** Vercel project pointed at this folder.

## Stack
- **Frontend + API routes:** Next.js 14 (App Router) + Tailwind
- **AI generation:** Anthropic Claude **and** OpenAI (\`/api/generate\` — toggle in UI)
- **Scheduling proxy:** Metricool (\`/api/metricool/schedule\`) — token never leaves the server
- **Video clips proxy:** OpusClip (\`/api/opus/clip\`) — key never leaves the server
- **Drafts + Auth:** Supabase (Postgres + RLS + email auth)
- **Dashboard data:** stat counters (`/api/stats`), scheduled posts (`/api/posts`), Content Calendar (`/calendar`) and Brand Brain (`/api/brand`, `/brand`), and Schedule Templates (`/templates`, `/api/templates`)

## One-time setup (do these yourself — I cannot create accounts on your behalf)

### 1. Supabase
1. Go to https://supabase.com and create a new project (free tier is fine to start).
2. In the project's **SQL editor**, paste the contents of \`web/supabase/schema.sql\` and run it.
3. Project Settings → API: copy the **Project URL**, the **anon public** key, and the **service_role** key.
4. Authentication → Providers: enable **Email** (and optionally Google).

### 2. Anthropic (Claude — default)
1. Go to https://console.anthropic.com/settings/keys and create an API key.
2. Default model is \`claude-sonnet-4-5\` — override via \`ANTHROPIC_MODEL\` if needed.

### 3. OpenAI (alternate / fallback)
1. Go to https://platform.openai.com/api-keys and create a key for this project.
2. Default model is \`gpt-4o-mini\` — override via \`OPENAI_MODEL\` if needed.

### 4. OpusClip
1. Open https://clip.opus.pro/dashboard. In the lower-left corner you'll find your **API access key** (requires Pro Beta or Business plan).
2. Copy the key.

### 5. Metricool (fresh token — old one was rotated)
1. Open https://app.metricool.com/user-settings/api?blogId=4308292&userId=3377431.
2. Generate / copy the **User Token**.

### 6. Vercel — create a **NEW** project (do not edit existing ones)
1. Import https://github.com/cellularinstitutecode/ai-content-dashboard.
2. **Root directory:** \`web\` (important — not the repo root).
3. Framework preset: Next.js.
4. Add environment variables (see table below).
5. Deploy.

## Environment variables (paste into Vercel → Settings → Environment Variables)

| Key | Where to get it | Notes |
|---|---|---|
| \`AI_PROVIDER\` | (literal) | \`anthropic\` (default) or \`openai\` — UI can override per request |
| \`ANTHROPIC_API_KEY\` | console.anthropic.com | sk-ant-... |
| \`ANTHROPIC_MODEL\` | (literal) | e.g. \`claude-sonnet-4-5\` |
| \`OPENAI_API_KEY\` | platform.openai.com/api-keys | sk-... |
| \`OPENAI_MODEL\` | (literal) | e.g. \`gpt-4o-mini\` |
| \`METRICOOL_USER_TOKEN\` | Metricool Settings → API | rotated value |
| \`METRICOOL_BLOG_ID\` | (literal) | \`4308292\` |
| \`METRICOOL_USER_ID\` | (literal) | \`3377431\` |
| \`OPUS_API_KEY\` | OpusClip dashboard (lower-left) | requires Pro Beta+ |
| \`NEXT_PUBLIC_SUPABASE_URL\` | Supabase Settings → API | https://xxx.supabase.co |
| \`NEXT_PUBLIC_SUPABASE_ANON_KEY\` | Supabase Settings → API | anon public |
| \`SUPABASE_SERVICE_ROLE_KEY\` | Supabase Settings → API | server-only |

## Local dev
\`\`\`
cd web
cp .env.example .env.local   # then fill in real values
npm install
npm run dev
\`\`\`

## How the AI toggle works
- The default provider is whatever \`AI_PROVIDER\` is set to in env.
- The dashboard UI has a **Claude / OpenAI** toggle that overrides per-request.
- Both providers return the same JSON shape: \`{ instagram, facebook, linkedin, blog }\`.
- Drafts persist a \`provider\` column so Recent Drafts shows which AI wrote each one.

## Security model
- All third-party API keys (Anthropic, OpenAI, Metricool, OpusClip, Supabase service role) live **only** in Vercel env vars.
- The browser never sees them — every external call goes through a server route.
- Supabase Row Level Security ensures users only see their own drafts/posts/clips.
- The auth middleware redirects unauthenticated users to \`/sign-in\` (the `/sign-in` page and Supabase auth callback are implemented).

## Recently shipped
- Brand Brain profile is now threaded into `/api/generate` — generations follow the stored voice, audience, keywords and guidelines.
- Live Metricool metrics (followers / reach / impressions / engagement) surface as extra cards in the dashboard counter row when analytics are loaded.
- `/sign-in` page with Supabase email auth and `/auth/callback` handler.
- Stat counters (Drafts / Scheduled / Upcoming / Clip jobs) wired to `/api/stats`.
- Content Calendar (`/calendar`) with a month-grid layout and drag-to-reschedule — dropping a post onto another day PATCHes `/api/posts` to move it (keeping its time of day).
- Brand Brain (`/brand`) profile editor backed by the `brand_profiles` table via `/api/brand`.
- `PATCH /api/posts` reschedules a single post's `publication_date` (used by calendar drag-and-drop).
- Schedule Templates (`/templates`) — save a reusable weekly posting cadence (providers, weekdays, time, text) via `/api/templates`.
- Apply a template with `POST /api/templates/apply` to materialize the next N weeks of scheduled posts into the `posts` table.

## Known gaps to wire next
- Nothing outstanding from the original scope — all planned features are shipped. Future idea: multi-account team roles.
