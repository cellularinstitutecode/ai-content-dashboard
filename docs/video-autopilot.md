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
  → keywords        Semrush brief on what the video is about (cached, usually 0 units)
  → copy            Claude writes the LinkedIn post and the TikTok caption
                    from the transcript, and only from the transcript
  → compliance      AVISO line stamped by the app; REF citation's DOI verified
  → written back    COPY, KEYWORDS, REF and ESTADO IA on that row
  → draft saved     editable in the dashboard under Recent Drafts
  → Metricool       a post waiting in the REVIEW queue for approval
```

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
| `ESTADO IA` | `Listo para revisión` · `Falta transcripción` · `Error — revisar` |

If you would rather add them yourself with different names, the reader matches
`KEYWORDS`/`PALABRAS CLAVE`, `REF`/`REFERENCIA`, and `ESTADO IA`/`AI STATUS`.

## Setup

1. **Run the schema.** `web/supabase/video-autopilot.sql` in the Supabase SQL
   editor. Safe to re-run.
2. **Share both the sheet and the videos** with the service account
   (`GOOGLE_SERVICE_ACCOUNT_JSON`'s `client_email` — the Video Library page
   shows the address). These are two separate permissions:
   - the **sheet**, as Editor. Viewer is not enough any more: the sweep
     writes. If the Edit button on a video row already works for you, this is
     already done.
   - the **video files** in Drive, as Viewer. Sharing the sheet grants nothing
     over the files it links to. Sharing the folder they live in covers all of
     them at once. This is the one most often missed — the dry run in step 4
     checks it for every row.
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
//   DASHBOARD_URL  https://YOUR_DOMAIN
//   CRON_SECRET    the same value as the dashboard's CRON_SECRET
function onSheetEdit(e) {
  if (!e || !e.range) return;
  var edited = String(e.value || '');
  // Only a Drive or YouTube link is worth waking the dashboard for.
  if (!/^https:\/\/(drive\.google\.com|www\.youtube\.com|youtu\.be)\//.test(edited)) return;

  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('DASHBOARD_URL');
  var secret = props.getProperty('CRON_SECRET');
  if (!url || !secret) return;

  // Fire and forget: the sweep is idempotent, so a duplicate call is harmless
  // and a dropped one is caught by the hourly cron.
  UrlFetchApp.fetch(url + '/api/videos/watch', {
    method: 'post',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
  });
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

## When it cannot do a video

`ESTADO IA` says `Falta transcripción` and the row waits for a person. The two
reasons:

- **There is no speech in it.** A silent b-roll clip has nothing to write from.
- **The source file is over 450 MB**, larger than the function's scratch disk.
  Nothing in the sheet today is close.

Either way, pressing **Prepare** on that row in the Video Library with a pasted
transcript finishes it by hand, the same as before.

## Where the code is

| File | What it does |
| --- | --- |
| `web/lib/video-autopilot.ts` | The sweep: which rows, in what order, written back how |
| `web/lib/video-row.ts` | The per-row decisions, as pure functions (unit-tested) |
| `web/lib/video-prepare.ts` | One video → transcript, keywords, copy, REF. Shared with the Prepare button |
| `web/lib/video-transcript.ts` | The transcript ladder: pasted → YouTube → Drive |
| `web/lib/media-transcript.ts` | Speech-to-text on a Drive file |
| `web/lib/audio-extract.ts` | Lifts the audio track out of the video first |
| `web/app/api/videos/watch/route.ts` | The trigger: cron, Apps Script, or a person |
| `web/lib/video-slot.ts` | Which networks, and which posting slot (unit-tested) |
| `web/lib/video-publish.ts` | Puts one post into Metricool's review queue |
