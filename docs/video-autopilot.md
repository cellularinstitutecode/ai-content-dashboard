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
                    otherwise speech-to-text on the Drive .mp4
  → keywords        Semrush brief on what the video is about (cached, usually 0 units)
  → copy            Claude writes the LinkedIn post and the TikTok caption
                    from the transcript, and only from the transcript
  → compliance      AVISO line stamped by the app; REF citation's DOI verified
  → written back    COPY, KEYWORDS, REF and ESTADO IA on that row
  → draft saved     editable in the dashboard under Recent Drafts
```

**It never publishes.** It does not tick a network checkbox and does not send
anything to Metricool. Approve is still a person, exactly as before.

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
2. **Share the sheet as Editor** with the service account
   (`GOOGLE_SERVICE_ACCOUNT_JSON`'s `client_email`). Viewer is not enough any
   more — the sweep writes. The Video Library page shows the address.
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

   The reply lists every row it *would* prepare. Check that list before letting
   it write.

The hourly Vercel cron (`vercel.json`) then picks up new rows on its own,
three at a time.

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
one content pack from Claude. Semrush is cached for 30 days, so a repeated
topic costs zero units. A YouTube-published video skips the transcription cost
entirely.

## When it cannot do a video

`ESTADO IA` says `Falta transcripción` and the row waits for a person. The two
reasons:

- **The file is over 25 MB.** That is the transcription upload limit. Either
  publish the video to YouTube (its captions are then used, free) or open the
  row in the dashboard's Video Library and paste the transcript.
- **There is no speech in it.** A silent b-roll clip has nothing to write from.

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
| `web/app/api/videos/watch/route.ts` | The trigger: cron, Apps Script, or a person |
