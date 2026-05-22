# AI Content Dashboard — Next.js app

Full-stack rebuild of the dashboard at \`/index.html\`. Lives in this \`web/\` subfolder. Deploys as a **new** Vercel project pointed at this folder.

## Stack
- **Frontend + API routes:** Next.js 14 (App Router) + Tailwind
- **AI generation:** OpenAI (\`/api/generate\`)
- **Scheduling proxy:** Metricool (\`/api/metricool/schedule\`) — token never leaves the server
- **Video clips proxy:** OpusClip (\`/api/opus/clip\`) — key never leaves the server
- **Drafts + Auth:** Supabase (Postgres + RLS + email auth)

## One-time setup (do these yourself — I cannot create accounts on your behalf)

### 1. Supabase
1. Go to https://supabase.com and create a new project (free tier is fine to start).
2. In the project's **SQL editor**, paste the contents of \`web/supabase/schema.sql\` and run it.
3. Project Settings → API: copy the **Project URL**, the **anon public** key, and the **service_role** key.
4. Authentication → Providers: enable **Email** (and optionally Google).

### 2. OpenAI
1. Go to https://platform.openai.com/api-keys and create a key for this project.

### 3. OpusClip
1. Open https://clip.opus.pro/dashboard. In the lower-left corner you'll find your **API access key** (requires Pro Beta or Business plan).
2. Copy the key.

### 4. Metricool (fresh token — old one was rotated)
1. Open https://app.metricool.com/user-settings/api?blogId=4308292&userId=3377431.
2. Generate / copy the **User Token**.

### 5. Vercel — create a NEW project (do not touch \`ci-hubspot-proxy\`)
1. Go to https://vercel.com/new and import \`cellularinstitutecode/ai-content-dashboard\`.
2. **Root Directory:** set to \`web\`.
3. Framework Preset will auto-detect as Next.js.
4. Click **Environment Variables** and paste these 9 values (use the keys from steps 1–4):

   | Key | Value |
   |---|---|
   | \`OPENAI_API_KEY\` | sk-... |
   | \`OPENAI_MODEL\` | gpt-4o-mini |
   | \`METRICOOL_USER_TOKEN\` | (fresh Metricool token) |
   | \`METRICOOL_BLOG_ID\` | 4308292 |
   | \`METRICOOL_USER_ID\` | 3377431 |
   | \`OPUS_API_KEY\` | (OpusClip key) |
   | \`NEXT_PUBLIC_SUPABASE_URL\` | https://YOUR_PROJECT.supabase.co |
   | \`NEXT_PUBLIC_SUPABASE_ANON_KEY\` | eyJ... |
   | \`SUPABASE_SERVICE_ROLE_KEY\` | eyJ... |
5. Click **Deploy**.

## After first deploy
1. Visit the new Vercel URL. The middleware will redirect you to \`/sign-in\` (you'll need to add a sign-in page next — Supabase has a drop-in component, or use \`supabase.auth.signInWithOtp\`).
2. Once signed in, the dashboard counters and Recent Drafts will populate from Supabase.
3. Generate a post pack — it'll be saved as a draft.
4. Click **Schedule in Metricool** on any channel card — it'll POST to your server, which adds the X-Mc-Auth header and forwards to Metricool.
5. Click **Send to OpusClip** with a video URL — it'll POST to your server, which adds the Bearer key and forwards to OpusClip.

## Notes on safety
- All third-party keys (Metricool, OpusClip, OpenAI, Supabase service role) live ONLY in Vercel env vars. They are never sent to the browser.
- The old static dashboard at \`/index.html\` will keep working on GitHub Pages until you delete it. The new Next.js app is independent.
- This project does NOT touch the existing \`ci-hubspot-proxy\` Vercel project.

## API surface (server-side)
- \`POST /api/generate\` — body \`{ topic, audience, tone, goal, cta, channels[] }\` → \`{ pack: { instagram, facebook, linkedin, blog } }\`
- \`POST /api/metricool/schedule\` — body \`{ text, providers[], publicationDate, autoPublish? }\` → forwards to \`POST app.metricool.com/api/v2/scheduler/posts\`
- \`POST /api/opus/clip\` — body \`{ videoUrl }\` → forwards to \`POST api.opus.pro/api/clip-projects\`
- \`GET /api/opus/clip?projectId=...\` — fetches clips for that project
- \`GET /api/drafts\` — your saved drafts
- \`POST /api/drafts\` — save a generated pack
