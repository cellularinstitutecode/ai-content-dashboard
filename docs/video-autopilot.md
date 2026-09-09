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

**It never publishes.** What reaches Metricool is a *draft* in the review queue
— the same thing the "Send to Metricool" button has always produced — and it
never ticks a network checkbox in the sheet, because a tick is a record that a
person published something. Approve is still a person, exactly as before.

### Which networks, and when

- **The sheet's ticks decide.** A row ticked for LinkedIn and TikTok gets a
  draft for each. A row with nothing ticked — most new rows — gets LinkedIn,
  the one network whose post is complete without a video attached.
- **LinkedIn and X** get the long, insight-led post; **TikTok, Instagram and
  Facebook** get the short caption with the hashtags, REF and AVISO. Same split
  the Video Library's two boxes have always had.
- **A network that needs a video** only gets a draft when Metricool can fetch
  one. Metricool cannot read an ordinary Drive link, so the reel is copied into
  the app's own Drive folder and that copy is opened to anyone-with-the-link.
  The copy is made *inside* Drive, so a 283 MB file never travels through the
  app. Your originals' sharing is never changed.
- **Timing:** the next free weekday at 09:00 clinic time, one post per slot.
  Working off a backlog therefore spreads across mornings instead of stacking
  thirty posts on one — which would read as spam on every network. Override the
  hour with `VIDEO_AUTOPILOT_TIME` (e.g. `14:30`).
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
own, one per run.

> **Plan note.** This deployment is on Vercel **Hobby**, which allows only
> once-a-day cron jobs — a more frequent schedule is rejected at deploy time,
> not silently ignored — and kills any function at 60 seconds. So the cron is
> daily and each run does one video.
>
> That makes the Apps Script trigger below the thing that actually keeps up:
> it fires per edit, so every new link gets its own 60-second run. **Set it up
> — on Hobby the cron alone is a backstop, not the mechanism.**
>
> On Pro, raise the cron to hourly and `maxVideos` past 1, and the cron alone
> is enough.

### Clearing the backlog

There are about 33 rows with a video and no copy. At one per daily run that is
a month, so work them off directly instead — each call does one and returns:

```
for i in $(seq 1 33); do
  curl -s -H "Authorization: Bearer $CRON_SECRET" \
       "https://YOUR_DOMAIN/api/videos/watch" | head -c 200; echo
done
```

Runs are idempotent, so stopping and restarting this costs nothing: a row
already prepared is skipped on sight.

## Making it instant

The cron is the safety net. To have a link prepared within a minute of being
pasted, add this to the sheet: **Extensions → Apps Script**, paste, then
**Triggers → Add Trigger → `onSheetEdit` → From spreadsheet → On edit**.

```javascript
// Distribución RRSS CHI → the dashboard, when a video link is pasted.
// Script properties (Project Settings → Script properties):
//   DASHBOARD_URL  https://YOUR_DOMAIN      (no trailing slash)
//   CRON_SECRET    the same secret the dashboard uses
function onSheetEdit(e) {
  if (!e || !e.range) return;
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('DASHBOARD_URL');
  var secret = props.getProperty('CRON_SECRET');
  if (!url || !secret) return;

  // Read the RANGE, not e.value. e.value is only set for a single-cell edit,
  // so a pasted row or a dragged fill — which is how rows actually get added —
  // would never fire the sweep.
  var values = e.range.getValues();
  var found = false;
  for (var r = 0; r < values.length && !found; r++) {
    for (var c = 0; c < values[r].length; c++) {
      if (/^https:\/\/(drive\.google\.com|www\.youtube\.com|youtu\.be)\//.test(String(values[r][c] || ''))) {
        found = true; break;
      }
    }
  }
  if (!found) return;

  // Fire and forget: the sweep is idempotent, so a duplicate call is harmless
  // and a dropped one is caught by the daily cron.
  var res = UrlFetchApp.fetch(url + '/api/videos/watch', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
  });
  // Say so in the execution log rather than failing silently forever — a wrong
  // URL or a mismatched secret looks exactly like "nothing was pasted".
  if (res.getResponseCode() >= 300) {
    Logger.log('sweep failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
}
```

Keep `CRON_SECRET` in Script properties, never typed into the script body —
anyone with view access to the sheet can read the script.

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
| `web/lib/video-slot.ts` | Which networks, and which posting slot (unit-tested) |
| `web/lib/video-publish.ts` | Puts one post into Metricool's review queue |
