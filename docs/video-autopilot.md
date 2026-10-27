# Video Autopilot

A new link in Rodrigo's **Distribución RRSS CHI** sheet becomes a transcript, a
keyword brief, a REF citation and publish-ready copy — without anyone pressing
anything.

This is the routine the team was doing by hand, automated. Nothing about the
output changes: the same voice, the same `AVISO DE PUBLICIDAD` line, the same
`REF:` citation checked against Crossref.

## What happens when a link appears

```
new row with LINK VIDEO, COPY empty
  → transcript      YouTube captions if the YOUTUBE column has a URL,
                    otherwise speech-to-text on the Drive .mp4 — ffmpeg lifts
                    out the audio track first, so a 194 MB reel is transcribed
                    from about 2 MB of sound
  → keywords        Semrush brief on the video's SUBJECT — two or three words
                    taken from the file name (Reel_MolecularHydrogenRyall_
                    Rodrigo.mp4 → "Molecular Hydrogen"), not the transcript.
                    Handing Semrush the whole prompt matches nothing at all.
  → copy            Claude writes the LinkedIn post and the TikTok caption
                    from the transcript, and only from the transcript
  → compliance      the caption is ASSEMBLED — every AVISO line stripped and
                    exactly one written with the clinic's own permit number,
                    the REF citation's DOI verified against Crossref, and the
                    hashtags last. The writer has invented a permit number in
                    a shape the matcher did not recognise; nothing it writes
                    is trusted where it left it.
  → written back    COPY, KEYWORDS, REF and ESTADO IA on that row
  → draft saved     editable in the dashboard under Recent Drafts
  → Metricool       a post waiting in the REVIEW queue for approval
```

The **Prepare** button in the Video Library does all of the above for one row,
through the same code — so a video handled by hand and a video handled
automatically end in the same state. Each row there shows its number in the
sheet, and that number is searchable.

**It schedules.** What reaches Metricool is a post on the calendar, in colour,
set to go out at its slot — the same thing the "Send to Metricool" button now
produces. This changed at the clinic's request: posts used to arrive greyed out
as drafts and were being flipped to scheduled by hand, one at a time.

**Know what that means:** between the sweep creating a post and that post
publishing itself, nobody necessarily looks at it. Set `PUBLISH_MODE=review` to
put the approve-first step back.

Three rules are unchanged either way, and they are the ones that matter most now
there is no human pass: a post whose copy came from a video **does not go out
without that video**; the advertising gate still refuses copy missing its AVISO
or REF; and a row already published is never sent twice. The sweep still never
ticks a network checkbox in the sheet, because a tick is a record that a person
published something.

### Which networks, and when

- **The sheet's ticks decide.** A row ticked for YouTube, LinkedIn and TikTok
  gets a draft for each; any of the six — YOUTUBE, LINKEDIN, TIKTOK, X,
  FACEBOOK, INSTAGRAM — can be ticked. A row with nothing ticked gets YouTube,
  LinkedIn and TikTok. EMAIL is a column, not a network. A column holding the
  live URL counts as *already posted there*, not as a tick. TikTok is skipped
  for a landscape video (FORMATO); the other five go whatever the shape.
- **A box ticked after the row was prepared still counts.** The sweep reads
  the ticks once, when it prepares the row, and never again; so the sheet's
  own **Prepare checked boxes** panel (below) sends the selected rows to
  `/api/videos/row` with the day and time you pick, and each ticked network
  that has no draft yet gets one, from the copy already on the row's draft
  (`lib/video-ticks.ts`). With `INSTANT_TICKS=on` the edit trigger sends a
  tick the moment it is clicked instead, at the next free slot. No duplicates:
  a network the row's record says was sent, or that Metricool already holds
  for this video, is left alone. Nothing is deleted — an unticked box changes
  nothing; withdraw a draft on the dashboard. A row that has not been prepared
  yet is left to the link trigger and the sweep, which own transcription and
  copy.
- **Each network gets copy written for it** (`lib/network-copy.ts`): LinkedIn
  the long, insight-led post; TikTok and Instagram the short caption with the
  hashtags, REF and AVISO; Facebook, X and YouTube an adaptation of those,
  written at the hand-off from the already-checked text. When an adaptation
  cannot be made, the network is sent what it always was.
- **A network that needs a video** only gets a draft when Metricool can fetch
  one, and that took three attempts to get right:

  1. A world-readable **copy in Drive**. Google answers the download link for
     anything over ~100 MB with its "cannot scan this file for viruses" web
     page, and Metricool stored that page *as the video*, with a 200, so the
     draft looked finished until somebody opened it.
  2. The file streamed into a **public Supabase bucket**. Correct, and still
     used — for files under 50 MB. That is the Free plan's upload limit, it is
     fixed, and the clinic's reels run 96 MB to 1.8 GB.
  3. **The app serves the file itself.** Everything above the bucket's limit
     goes out as a signed link on this app's own domain
     (`/api/media/video/…/video.mp4`), which streams the bytes out of Drive on
     demand. Nothing is copied, nothing is stored, and there is no size limit —
     but only a long-lived host can serve it; a Vercel function cannot hand
     Metricool a whole reel, and a Drive link is handed straight back at any
     size (row 191, 21 September).
  4. **The file is uploaded straight into Metricool.** For anything the bucket
     will not take, the app now does what Metricool's own media library does:
     opens an upload transaction (`PUT /v2/media/s3/upload-transactions`), is
     handed a pre-signed S3 address, and puts the bytes there itself — staged
     on the function's scratch disk up to 360 MB, and above that streamed out
     of Drive in 25 MB slices with no disk at all, up to 5 GB. A reel one
     request cannot finish is **resumed** by the next pass of the sweep: the
     slices measured and the slices already in Metricool are kept in the
     `metricool_uploads` table (`supabase/metricool-uploads.sql`), one request
     holds a video at a time, and the row's drafts get their video when the
     last slice lands — including the YouTube and TikTok drafts that could
     not be made while the video was still uploading, which the sweep makes
     on the pass that finds the copy. The
     resulting Metricool-hosted URL goes into the post as is — it needs no
     host of ours and no normalise step. `METRICOOL_DIRECT_UPLOAD=off` turns it
     off; when it fails, the routes above run exactly as before and the refusal
     says what Metricool answered.

  Whichever path is used, the URL is **read back anonymously before any post is
  created** — the first sixteen bytes must be an MP4 header and the length must
  match the source. A URL that fails is deleted and reported, never sent. Your
  originals' sharing is never changed. (The direct upload is the one exception:
  its bytes came straight out of Drive and the storage answered 2xx for the
  full length, and Metricool's storage need not answer strangers.)

  Two settings decide those links: `PUBLIC_MEDIA_BASE_URL` (the https origin
  that serves them — optional, and only worth setting to the Dokploy copy if
  large files turn out to be slow from the default host) and `MEDIA_URL_SECRET`
  (signs them; rotating it invalidates every outstanding link). System Status's
  **video_media** check reports both, and goes red only when one is genuinely
  missing — not because of which host it resolved.
- **Timing:** the next free slot on the clinic's clock — **13:00 and 17:00**,
  two a day, every day — one post per slot. Working off a backlog therefore
  spreads across days instead of stacking thirty posts on one, which would read
  as spam on every network. Change the grid with `VIDEO_AUTOPILOT_TIMES`
  (e.g. `08:00,13:00,17:00`); `VIDEO_POST_DAYS=weekdays` limits it to Monday–Friday.
- **Every post carries the AVISO line and the REF citation** — LinkedIn
  included. `lib/compliance.ts` scopes the advertising rule to Instagram and
  Facebook, so the writer is only asked for a citation on those two; the
  LinkedIn post reuses the same Crossref-verified citation rather than asking
  for a second one that would need verifying again.
- **Copy that fails the compliance gate is not sent at all.** Instagram and
  Facebook posts missing the AVISO line or the REF citation stay out of the
  queue rather than sitting somewhere one wrong click publishes them.

To fill the sheet without handing anything to Metricool — worth doing for the
first few, to read the copy before any of it reaches a posting queue:

```
curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://YOUR_DOMAIN/api/videos/watch?sheetOnly=1"
```

## The three rules it will not break

1. **It never overwrites what a person wrote.** Every target cell is re-read
   immediately before writing, and a cell with anything in it is left alone.
   You can point this at a sheet with hundreds of finished rows and nothing is
   at risk. (`ESTADO IA` is the one exception — it is the sweep's own column.)
2. **A row is identified by its content, not its row number.** Insert a row at
   the top of a tab and nothing below it is re-processed.
3. **A row is attempted three times, then left alone.** A video that cannot be
   transcribed does not cost money every morning.

## New columns

The sweep adds three headers to the right of everything already on a tab,
creating them on first run. Appended, never inserted — nothing shifts:

| Column | What goes in it |
| --- | --- |
| `KEYWORDS` | `primary keyword · supporting, terms, here` |
| `REF` | The citation the copy carries, e.g. `Author, A.B., et al. (2023). "Title." Journal…` |
| `ESTADO IA` | `Listo para revisión` · `Listo — SIN keywords` · `Listo — copy muy larga, acortar` · `Falta transcripción` · `Error — revisar` |

`Listo — SIN keywords` is the one to watch. The copy was written, but no
keyword data reached the writer — Semrush unset, erroring, or below its unit
floor. The row is usable; it just did not get the thing this automation exists
to add. Check `/api/health` → `semrush` when you see it.

`Listo — copy muy larga, acortar` means a post exceeded what its network takes
(LinkedIn 3000, TikTok and Instagram 2200, X 280) and was NOT sent. It is never
trimmed to fit: the REF and AVISO lines sit at the end, so trimming would cut
exactly the two lines that must be there.

If you would rather add them yourself with different names, the reader matches
`KEYWORDS`/`PALABRAS CLAVE`, `REF`/`REFERENCIA`, and `ESTADO IA`/`AI STATUS`.

## Setup

1. **Run the schema.** `web/supabase/video-autopilot.sql` in the Supabase SQL
   editor. Safe to re-run.
2. **Share both the sheet and the videos** with the service account, *by
   address*. Get it from `/api/sources?kind=status` → `serviceAccount`, or the
   Video Library page. These are two separate permissions:
   - the **sheet**, shared with that address as **Editor**.
   - the **video files** in Drive, as Viewer at least. Sharing the sheet grants
     nothing over the files it links to; sharing the folder they live in covers
     all of them at once.

   > **"Anyone with the link" is not enough, and it is worse than nothing,**
   > because it hides the problem. A sheet set to *anyone with the link →
   > Viewer* lets the service account READ every row, so the Video Library
   > fills, the dry run passes, and everything looks configured — right up
   > until the first write, which comes back `403`. That is exactly how this
   > deployment was set up, and the fault only surfaced the first time a
   > prepared row tried to reach column E.
   >
   > Verify by opening the sheet's **Share** dialog and looking for the
   > `…iam.gserviceaccount.com` address under *People with access*, set to
   > **Editor**. If it is not listed there by name, it is not shared with it,
   > whatever the General access row says.
3. **Set the environment variables** (see `web/.env.example`):
   - `OPENAI_API_KEY` — already set; speech-to-text uses it.
   - `CRON_SECRET` — already set; authorizes the sweep.
   - `VIDEO_AUTOPILOT_USER_ID` — optional. Whose brand voice to write in.
     Without it, the workspace's oldest brand profile is used.
4. **Dry run first.** With nothing written:

   ```
   curl -H "Authorization: Bearer $CRON_SECRET" \
        "https://YOUR_DOMAIN/api/videos/watch?dry=1"
   ```

   The reply lists every row it *would* prepare, and for each one whether the
   video file can actually be opened — `Reachable · 14.2 MB`, or the reason it
   is not. Nothing is downloaded, transcribed or written. A row that says the
   file cannot be opened needs sharing (step 2) before the sweep can do it.

   Check that list before letting it write.

The daily Vercel cron (`vercel.json`, 07:00 UTC) then picks up new rows on its
own, up to five per run (`?max=N` raises it, ceiling ten).

> **Plan note.** This deployment is on Vercel **Hobby**.
>
> **Cron frequency: proven.** Hobby allows only once-a-day cron jobs, and a
> more frequent schedule is rejected at deploy time rather than silently
> ignored — the deployment failed with "Hobby accounts are limited to daily
> cron jobs." So the cron is daily, at 07:00 UTC.
>
> **Function duration: was wrong here, now 300.** This note used to say Hobby
> "kills any function at 60 seconds", and the routes were sized for that. Vercel
> now documents Hobby functions running **Fluid compute** (the default) as
> allowed up to 300 seconds, and `/api/videos/prepare` and this route both
> declare 300 and deploy. If a long video is ever killed at about a minute
> again, that is the signal that Fluid is off on this project — and the budgets
> in `lib/prepare-budget.ts` and the routes must come back down with it, because
> a budget larger than the real ceiling is worse than a small one: the
> stop-and-bank check never fires and the request dies with nothing kept.
>
> That still makes the Apps Script trigger below the thing that keeps up: it
> fires per edit, so every new link gets its own run within a minute. **Set it
> up — the daily cron alone is a backstop, not the mechanism.**

### Clearing the backlog

There are about 33 rows with a video and no copy. The daily run takes five, so
work them off directly instead — each call takes another five and returns:

```
for i in $(seq 1 33); do
  curl -s -H "Authorization: Bearer $CRON_SECRET" \
       "https://YOUR_DOMAIN/api/videos/watch" | head -c 200; echo
done
```

Runs are idempotent, so stopping and restarting this costs nothing: a row
already prepared is skipped on sight.

## Prepare checked boxes, from the dashboard

The Video Library has a **Prepare checked boxes** button, above the videos
table. It needs nothing installed in the sheet. Tick the network boxes on a
row in the sheet — FACEBOOK, INSTAGRAM, YOUTUBE, LINKEDIN, TIKTOK, X — then
press the button: the panel lists every ticked row that is still owed a post
(`/api/videos/ticks`), shows the month and the clinic's slot times, and sends
the rows you choose at the day and time you pick (`/api/videos/row` with
`publishAt`, the same door as the sheet's script below). The first row gets
the time as picked; a row after it, or a slot already taken, moves to the next
free slot and the answer says so. A network the row already has is left alone.
Rows must be prepared (they have COPY); ticks on rows outside the pipeline are
counted, not listed.

The panel opens on **Just ticked in the sheet**: the rows whose boxes were
ticked since they were last sent, pre-selected. The sheet's edit trigger sends
every tick to the dashboard, which holds the row and writes a `ticked` line in
the register (`lib/video-ticks.ts` hold, `lib/tick-pending.ts`); the line is
closed by the `queued` line the send writes. The sheet's whole ticked history
is behind "Show N other ticked rows", unselected, with a box to find a row by
number. A row whose every tick already has its post shows when each goes out,
and choosing it with a day and time **moves** those posts there instead.

## Making it instant

The cron is the safety net. Three things should happen from inside the sheet,
and one script project does all three (`web/scripts/sheet-apps-script/`,
two files: `Code.gs` and `Dialog.html`):

- **a link pasted** → the sweep runs, and the row is prepared within a minute;
- **boxes ticked, then "Prepare checked boxes"** → a panel opens with a month
  and a time; the rows you selected go to Metricool for the networks they are
  ticked for, at the day and time you picked (`/api/videos/row` with
  `publishAt`). The first row gets the time as picked; when that slot is
  already taken — a second row sent from the same panel, or a post already
  there — the next free slot after it is used, and the answer says so. A
  network the row already has is left alone, so pressing it twice sends
  nothing twice. A time already gone is refused before any copy is written.
- **a box ticked, sent at once** (optional) → the edit trigger sends that row
  the moment the box is clicked, at the next free slot, without any panel.
  Off by default, twice: the script's `INSTANT_TICKS` property must be `on`,
  **and** the dashboard's `VIDEO_TICK_INSTANT` must be `on`. Otherwise the
  dashboard answers a time-less tick with `needs_time` and holds it for the
  panel — which is what an older copy of the script, still installed in the
  sheet, gets as well, so nothing has to be changed there.

### Set it up

1. **Extensions → Apps Script.** Paste `Code.gs` over the default file. Then
   **File → New → HTML file**, name it `Dialog`, and paste `Dialog.html` into
   it. Save.
2. **Project Settings → Script properties:**

   | Property | Value |
   | --- | --- |
   | `DASHBOARD_URL` | `https://YOUR_DOMAIN` (no trailing slash) |
   | `CRON_SECRET` | the same secret the dashboard uses |
   | `SLOT_TIMES` | optional, `13:00,17:00` — the panel's quick-pick times; keep equal to `VIDEO_AUTOPILOT_TIMES` |
   | `INSTANT_TICKS` | optional, `on` — send a tick the moment it is clicked |

   Keep `CRON_SECRET` in Script properties, never typed into the script body —
   anyone with view access to the sheet can read the script.
3. **Triggers → Add Trigger → `onSheetEdit` → From spreadsheet → On edit.** It
   has to be an *installable* trigger made that way, not a function merely
   named `onEdit`: a simple trigger is not allowed to call out to the dashboard.
4. **Reload the sheet.** A **Dashboard** menu appears with **Prepare checked
   boxes…**. The first use asks you to authorise the script (it reads the sheet
   and calls the dashboard).
5. **A button in the corner, if you want one.** Insert → Drawing, draw a button
   that says *Prepare checked boxes*, place it where you like; then click it,
   open its ⋮ menu → **Assign script** → type `prepareCheckedBoxes`. It does
   the same as the menu item.

### Using it

1. Tick the network boxes on the row — FACEBOOK, INSTAGRAM, YOUTUBE, LINKEDIN,
   TIKTOK, X. The row must already be prepared (it has COPY, written by the
   sweep or by Prepare); a row that is not answers *not prepared yet*.
2. Select the row (click its number), or several rows.
3. **Dashboard → Prepare checked boxes…** (or the button). The panel lists the
   rows and their networks, shows the month, and the times. Pick a day and a
   time — on the clinic's clock, whatever your computer's is — and press
   **Send to Metricool**.
4. Each row's answer appears in the panel and as a toast in the corner:
   *sent to Metricool for Tue 3 Nov, 13:00 — Facebook, Instagram*, or why a
   network was not sent (copy too long for X, no video for TikTok, already
   there). The posts are on the dashboard calendar and in Metricool, scheduled
   — the same posts the sweep makes, by the same path (`lib/video-ticks.ts` →
   `handOffToMetricool` → `lib/video-publish.ts`).

Sending can take up to a minute per row when the video still has to be copied
into Metricool; a row whose video is already there answers in seconds.

To try it without the sheet, the same call from a terminal — `publishAt` is
optional, "YYYY-MM-DDTHH:mm" on the clinic's clock:

```
curl -X POST -H "Authorization: Bearer $CRON_SECRET" -H "Content-Type: application/json" \
     -d '{"tab":"TAB NAME","row":224,"publishAt":"2026-11-03T13:00"}' "https://YOUR_DOMAIN/api/videos/row"
```

## Costs

About **two cents per video**: roughly $0.006 per minute of speech-to-text, plus
one content pack from Claude. Extracting the audio costs nothing but a few
seconds of CPU. Semrush is cached for 30 days, so a repeated topic costs zero
units. A video that is already on YouTube skips the transcription cost
entirely, if its URL is in the YOUTUBE column.

## How a 200 MB reel gets transcribed

The transcription endpoint refuses anything over 25 MB, and the clinic's reels
run 76–283 MB — so for a while the automatic path could not read a single video
in the sheet.

It does not send the video. A three-minute reel's *speech* is about two
megabytes; the other 190 are pixels the transcriber would discard on arrival.
So the file is streamed to the function's scratch disk, `ffmpeg` lifts out the
audio as 16 kHz mono (the rate the transcriber resamples to anyway, so nothing
it would have used is lost), and only that is uploaded. Both scratch files are
deleted on every path, including failure.

At that bitrate about 50 minutes of speech fits inside the ceiling, so length
is no longer a practical limit either. The remaining cap is 450 MB on the
*source* file, which is scratch space, not the transcriber.

## If transcription stops working

`/api/health` → `audio_extractor` answers it without anyone pressing Prepare.
The three causes need different fixes and used to look identical:

| `code` | What it means |
| --- | --- |
| `absent` | The build never fetched the binary, **or** the path is a build-time one baked into a bundled chunk. `serverExternalPackages` in `next.config.mjs` prevents the second; `scripts/ensure-ffmpeg.mjs` the first. |
| `copy_failed` | Present but not executable, and not copyable to `/tmp`. |
| `no_path` | Nothing configured at all — set `FFMPEG_BIN` or reinstall `ffmpeg-static`. |

`ffmpeg-static` computes its binary's location as `path.join(__dirname,
'ffmpeg')`. If Next bundles the package into a server chunk, `__dirname`
becomes the chunk's directory **as it stood at build time**, so the deployed
function looks somewhere that only exists on the build machine. Keeping it in
`serverExternalPackages` is what stops that.

## When it cannot do a video

`ESTADO IA` says `Falta transcripción` and the row waits for a person. The two
reasons:

- **There is no speech in it.** A silent b-roll clip has nothing to write from.
- **The source file is over 450 MB**, larger than the function's scratch disk.
  Nothing in the sheet today is close.

Either way, pressing **Prepare** on that row in the Video Library with a pasted
transcript finishes it by hand, the same as before.

## If the trigger reports `no_owner`

The sweep needs an account to write as — the drafts belong to somebody, and the
copy is written in somebody's brand voice. `/api/health` → **`sweep_owner`**
runs that lookup live and reports the reason, because for one deployment the
old message asserted a cause it could not tell from two others and sent a
person to press Save on a page they had already saved.

| `code` | What it means |
| --- | --- |
| `rls_blocked` | The credential cannot see past row-level security. Almost always the **anon key in `SUPABASE_SERVICE_ROLE_KEY`** — see below. |
| `unreadable` | The query failed. A database or credential problem; the detail carries the Postgres error. Nothing can be concluded about whether a Brand Brain exists. |
| `empty` | The query *succeeded* and there is genuinely no Brand Brain row and no allowlisted account. Sign in to the dashboard once, then save Brand Brain. |

A saved Brand Brain is preferred and looked for first — it is the clinic's
voice, not merely an owner. Its absence costs the copy its voice and nothing
more: the sweep falls back to the first allowlisted account, because the sheet
belongs to the workspace rather than to a person. `VIDEO_AUTOPILOT_USER_ID`
overrides both.

### The anon key in the service-role slot

`brand_profiles` has row-level security: *you may read your own row and nobody
else's*. The service role reads past that policy; the anon key does not. So
with the wrong key in `SUPABASE_SERVICE_ROLE_KEY`:

- **Saving Brand Brain works.** That write carries your own session, the policy
  passes, and the page shows your values back on reload.
- **Every background read of it returns zero rows.** The sweep has no session,
  so the policy matches nothing.

Saved and unsaved at the same time — and nothing anywhere said so, because the
check that existed only asked whether the variable was *set*. It was.

`/api/health` → **`supabase_service_role`** now reads the role out of the key
itself (a Supabase key is a JWT whose payload names its role, so this needs no
network call and the key never leaves the process). `anon_key` there is the
whole diagnosis: copy the **service_role** key from Supabase → Project Settings
→ API into Vercel and redeploy.

## Where the code is

| File | What it does |
| --- | --- |
| `web/lib/video-autopilot.ts` | The sweep: which rows, in what order, written back how |
| `web/lib/sweep-owner.ts` | Who the sweep writes as, and *why* when the answer is nobody |
| `web/lib/supabase-key.ts` | Which Supabase key is in the service-role slot, read from the key (unit-tested) |
| `web/lib/video-row.ts` | The per-row decisions, as pure functions (unit-tested) |
| `web/lib/video-prepare.ts` | One video → transcript, keywords, copy, REF. Shared with the Prepare button |
| `web/lib/video-transcript.ts` | The transcript ladder: pasted → YouTube → Drive |
| `web/lib/media-transcript.ts` | Speech-to-text on a Drive file |
| `web/lib/audio-extract.ts` | Lifts the audio track out of the video first |
| `web/app/api/videos/watch/route.ts` | The trigger: cron, Apps Script, or a person |
| `web/app/api/videos/row/route.ts` | A row's ticked networks sent from the sheet, at the time the panel chose (`lib/video-ticks.ts`; which networks and which slot in `lib/tick-add.ts`) |
| `web/scripts/sheet-apps-script/` | The sheet's script: the Dashboard menu, the "Prepare checked boxes" panel, the edit trigger |
| `web/components/TickScheduler.tsx` | The same panel in the dashboard's Video Library, listing rows from `app/api/videos/ticks` (rule in `lib/tick-rows.ts`) |
| `web/lib/video-slot.ts` | Which networks, and which posting slot (unit-tested) |
| `web/lib/video-publish.ts` | Puts one post into Metricool's review queue |
