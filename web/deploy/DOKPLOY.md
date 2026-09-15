# Running the dashboard on Dokploy

A second, identical copy of the app, alongside Vercel. Same database, same
Google Sheets, same Metricool account — so **anything a person does on either
copy is real**, and **the four crons must run on one copy only**.

## What is in the repo

| | |
|---|---|
| `Dockerfile` (repo root) | the image: Node 22, `next build` in standalone mode, ffmpeg installed from the OS, runs as `node`, port 3000 |
| `.dockerignore` | keeps `node_modules`, `.next`, `.env*`, tests and licensed fonts out of the image |
| `web/scripts/cron-tick.mjs` | what a schedule runs: `GET /api/<route>` inside the container with `Bearer CRON_SECRET` |
| `web/deploy/dokploy-schedules.json` | the four crons, copied from `vercel.json`; a test keeps them identical |

## Set-up, once (≈ 20 minutes)

### 1. The environment variables — copy them, don't retype them

In a terminal (a GitHub Codespace on this repo is fine):

```bash
npx vercel login
npx vercel env pull .env.dokploy --environment=production
```

Open `.env.dokploy`. It is the exact production set. Two edits before pasting:

- **delete `MAINTENANCE_PRUNE`** — only one copy should ever sweep;
- **delete `FFMPEG_DOWNLOAD_URL` and `FFMPEG_SHA256`** if present — the image has ffmpeg on disk.

Everything else stays exactly as it is, `CRON_SECRET` included (the schedules
use it). That includes the pacing settings (`VIDEO_START_ROW`,
`VIDEO_DAILY_QUOTA`, `VIDEO_AUTOPILOT_TIMES`, `VIDEO_POST_DAYS`): the copy
reads the same values, and since only one side runs the video schedule the
daily count is never doubled.

### 2. Create the application

Dokploy → **Projects → Create Project** `ai-content-dashboard` → **Create
Service → Application**:

- **Provider:** GitHub → install the Dokploy GitHub App on
  `cellularinstitutecode` when asked → repository `ai-content-dashboard`,
  branch `main`.
- **Build Type:** *Dockerfile*. Docker File `Dockerfile`, Docker Context
  Path `.` (the repo root — the Dockerfile copies `web/` itself).
- **Environment:** paste the contents of `.env.dokploy`.
- **Domains → Generate Domain** (a `*.traefik.me` name for now), container
  port **3000**, HTTPS on. A real subdomain can be added here later.
- **Auto Deploy:** on — every merge to `main` then updates both copies.

**Deploy.** The first build takes 4–6 minutes.

### 3. The schedules — create them DISABLED

Dokploy → the application → **Schedules → Create**, one per entry in
`deploy/dokploy-schedules.json`:

| Name | Cron (UTC) | Command |
|---|---|---|
| `maintenance-prune` | `0 5 * * *` | `node scripts/cron-tick.mjs maintenance/prune` |
| `metricool-sync` | `0 6 * * *` | `node scripts/cron-tick.mjs metricool/sync` |
| `autopilot-tick` | `30 6 * * *` | `node scripts/cron-tick.mjs autopilot/tick` |
| `videos-watch` | `*/15 * * * *` | `node scripts/cron-tick.mjs videos/watch` |

Shell type `sh`, timezone `UTC`, and **leave each one disabled**. They exist so
that cutover is a toggle. While Vercel is live, Vercel's crons are the ones
running; two copies of the sweep would prepare every video twice.

To prove a schedule works without enabling it, run `metricool-sync` once by
hand from its log page — it only reads from Metricool.

### 4. Supabase — allow the new sign-in URL

Supabase → **Authentication → URL Configuration → Redirect URLs** → add
`https://<the generated domain>/auth/callback`. Vercel's entry stays.

## Proving the copy is a copy

1. Sign in on the new URL: the same drafts, posts, queue and register appear.
2. The status banner matches Vercel's; *audio_extractor* reads
   "ffmpeg runs from /usr/bin/ffmpeg".
3. **Prepare** a Drive video from the Video Library — transcript, keywords,
   REF, AVISO, and the row written back to the sheet. That is the whole
   pipeline, and the part that had platform limits on Vercel.
4. Generate a hero image and a brand card.
5. Nothing about publishing changes: approve is still a person, behind the
   same gates, on either copy.

## Cutover, on a day of your choosing

1. Point the real domain at the Dokploy copy (Domains tab, then DNS).
2. Enable the four schedules on Dokploy.
3. Disable the crons on Vercel (remove the `crons` block from `vercel.json`,
   or pause the Vercel project).
4. Update `OPUS_WEBHOOK_URL` and the Opus dashboard's webhook to the new
   domain; the poll fallback covers the gap.

Until then Vercel is production and the copy is a live rehearsal.
