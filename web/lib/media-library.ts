// web/lib/media-library.ts
// The videos a post can actually carry.
//
// Metricool cannot fetch an ordinary Google Drive link — the clinic's footage
// is private, and a post handed that URL gets a permission wall. What it CAN
// fetch is the world-readable copy `completeRow` makes when a row is prepared,
// recorded against the source video in video_transcripts.public_copy_url
// (lib/transcript-cache.ts).
//
// Two questions, and the difference between them matters:
//
//   listShareableVideos  — which videos ALREADY have such a copy? Read-only.
//                          Browsing the picker never creates one.
//   ensureShareableVideo — make one for this video if it has none. A real side
//                          effect, reached only from a button that says so.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { deleteDriveFile, driveFolderReport, publicVideoCopy } from '@/lib/drive';
import { deleteBucketVideo, stageVideoInBucket } from '@/lib/video-bucket';
import { verifyPlayableMp4 } from '@/lib/media-verify';
import { cachedPublicCopy, rememberPublicCopy } from '@/lib/transcript-cache';
import { parseDriveFileId } from '@/lib/drive-url';
import { copyFailureAdvice, storageAdvice } from '@/lib/drive-copy-error';
import { disposalFor, type CopyWhere } from '@/lib/copy-disposal';
import { MediaKeyMissing, mediaUrlIsFresh, mediaVideoUrl, parseStreamCopyId, streamCopyId, streamCopyIdFromUrl } from '@/lib/media-url';
import { MediaBaseUnresolved, publicBase } from '@/lib/public-base';
import { reportError } from '@/lib/report';
import { cachedCopyUsable, copyRouteFor, type DirectUploadState } from '@/lib/copy-source';
import { directUploadPossible, isMetricoolCopyId, uploadVideoToMetricool, type DirectUpload } from '@/lib/metricool-upload';
import { recordVideoEvent } from '@/lib/video-register';
import { driveVideoKey, type VideoActor } from '@/lib/video-event';

export type ShareableVideo = {
  /** The SOURCE video's id — a Drive file id, or a YouTube video id. */
  videoId: string;
  title: string;
  /** The public copy's URL. This is what goes to Metricool as `mediaUrl`. */
  url: string;
  source: string;
  updatedAt: string;
};

/**
 * Videos with a shareable copy, newest first.
 *
 * Never throws. supabase-js RESOLVES a failed query rather than rejecting it,
 * which has bitten this codebase repeatedly: an unchecked `.error` turns an
 * outage into "you have no videos", and an empty picker is indistinguishable
 * from a broken one. The error is reported and an empty list returned, and the
 * route says which of the two happened.
 */
export async function listShareableVideos(limit = 40): Promise<{ videos: ShareableVideo[]; failed: boolean }> {
  const capped = Math.min(Math.max(Math.trunc(limit) || 40, 1), 200);
  const r = await supabaseAdmin()
    .from('video_transcripts')
    .select('video_id, title, source, public_copy_id, public_copy_url, updated_at')
    .not('public_copy_url', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(capped)
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));

  if (r.error) {
    reportError('media-library:list', r.error);
    return { videos: [], failed: true };
  }

  const rows = (r.data || []) as {
    video_id?: string | null; title?: string | null; source?: string | null;
    public_copy_id?: string | null; public_copy_url?: string | null; updated_at?: string | null;
  }[];

  const videos: ShareableVideo[] = [];
  for (const row of rows) {
    const url = String(row.public_copy_url || '').trim();
    const videoId = String(row.video_id || '').trim();
    // A row can carry an id with no copy if a previous copy was forgotten;
    // `is not null` would still return it if the column held an empty string.
    if (!url || !videoId) continue;
    videos.push({
      videoId,
      title: String(row.title || '').trim() || 'Untitled video',
      // Re-minted here too. The composer can post one of these URLs straight
      // to Metricool, so handing out an expired one from the picker would
      // fail in exactly the place that is hardest to explain. Read-only: the
      // banked value is refreshed by ensureShareableVideo, not by browsing.
      url: freshCopyUrl(String(row.public_copy_id || '').trim() || streamCopyIdFromUrl(url) || '', url, videoId),
      source: String(row.source || 'drive').trim(),
      updatedAt: String(row.updated_at || ''),
    });
  }
  return { videos, failed: false };
}

/**
 * A stored copy URL, re-minted when it is one of ours and has gone stale.
 *
 * A streamed video's URL carries an expiry, so the string banked in
 * video_transcripts.public_copy_url has a shelf life that the marker beside it
 * does not. Re-minting is a pure HMAC with no I/O, so it is done on every read
 * rather than on a schedule; a bucket or Drive URL is returned untouched.
 *
 * Never throws: with no public address configured the stored URL is still the
 * best answer available, and the health check is where that is said out loud.
 */
export function freshCopyUrl(copyId: string, url: string, sourceFileId: string): string {
  const streamed = parseStreamCopyId(copyId);
  if (!streamed) return url;
  try {
    const base = publicBase();
    return mediaUrlIsFresh(url, streamed, base) ? url : mediaVideoUrl(streamed, base);
  } catch {
    return url;
  }
}

/**
 * Remove a copy that failed verification \u2014 and ONLY a copy.
 *
 * Exhaustive through lib/copy-disposal.ts rather than an `else`. The streamed
 * path creates nothing: its recorded id wraps the SOURCE video's Drive id, the
 * clinic's master, so a catch-all Drive branch here would delete the footage
 * the post was made from.
 */
async function removeMade(made: { fileId: string; where: CopyWhere }): Promise<void> {
  switch (disposalFor(made.where)) {
    case 'bucket': await deleteBucketVideo(made.fileId); return;
    case 'drive': await deleteDriveFile(made.fileId).catch(() => undefined); return;
    case 'none': return;
  }
}

/**
 * Make sure this video CAN be attached, and say where it lives.
 *
 * "Use in post" used to hand over the caption and an empty media slot whenever
 * the row had never been prepared, which from the outside looks exactly like a
 * broken button: the text arrives, the video does not, and nothing says why.
 * The missing thing is the world-readable Drive copy — the clinic's own file is
 * private, so no network can fetch it.
 *
 * So this makes the copy when it is missing. That is a real side effect and the
 * button that calls it says so in as many words before it runs; it is not done
 * on a page load, a hover, or the picker merely being opened. The copy is made
 * once per source video and remembered, so pressing the button twice costs one
 * database read.
 */
export async function ensureShareableVideo(
  videoLink: string,
  title?: string | null,
  /**
   * Who to credit in the register, and which Metricool brand the video is for
   * (the direct upload lands it in that brand's library). Optional so existing
   * callers keep compiling.
   */
  who?: { userId?: string; actor?: VideoActor; blogId?: string | null },
): Promise<
  | { ok: true; url: string; fileId: string; created: boolean }
  | { ok: false; reason: 'not_drive' | 'failed'; code?: string; message: string }
> {
  const fileId = parseDriveFileId(String(videoLink || ''));
  if (!fileId) {
    return {
      ok: false,
      reason: 'not_drive',
      message: 'That row has no Google Drive video, so there is nothing to attach.',
    };
  }

  const known = await cachedPublicCopy(fileId);
  // Not registered: nothing happened. The copy already existed, and a register
  // that records "nothing happened" every time somebody opens the picker is a
  // register nobody can read.
  //
  // A STREAMED copy minted against a host that cannot serve a whole video is
  // not a copy — it is the same link that was refused last time. Every row
  // prepared between #253 and this change holds one, so without this check the
  // cache would hand the broken link back forever and the fix would reach no
  // existing row. lib/copy-source.ts.
  // publicBase() THROWS when nothing is configured, and this line sits outside
  // the try below — where that throw would leave the caller with an exception
  // instead of the sentence lib/public-base.ts wrote for exactly this case. An
  // unresolvable base is also not a host that can serve a video, so '' gives
  // the right answer here and the real refusal happens inside the try.
  const servingBase = (() => { try { return publicBase(); } catch { return ''; } })();
  if (known?.url && !cachedCopyUsable(known.id, servingBase, undefined, known.url)) {
    reportError('media-library:cached-unservable', new Error('a cached copy exists that cannot reach Metricool from here'), { fileId });
  } else if (known?.url) {
    // A streamed URL expires. Re-mint it rather than hand on a dead link, and
    // bank the new one so the next read is a plain cache hit again. The marker
    // never changes, so nothing downstream sees a difference.
    const url = freshCopyUrl(known.id, known.url, fileId);
    if (url !== known.url) await rememberPublicCopy(fileId, { id: known.id, url });
    return { ok: true, url, fileId: known.id, created: false };
  }

  /** The direct upload's outcome, kept outside the try so the catch can name it. */
  let direct: DirectUpload | null = null;
  try {
    // THE FILE ITSELF, in a bucket this app controls, as <id>.mp4 — not a Drive
    // download link, which Google answers with its virus-scan page for a file
    // over ~100 MB, so Metricool stored a web page as the video. A file too big
    // to stage is uploaded straight into Metricool (below), and only then does
    // it fall to the Drive copy or the stream; either way the URL is read back
    // before it is recorded (lib/media-verify.ts), and a copy that is not the
    // video is removed and reported instead of handed on.
    const staged = await stageVideoInBucket(fileId);
    let made: { fileId: string; url: string; sizeBytes: number | null; where: CopyWhere };
    const sizeBytes = staged.ok ? staged.sizeBytes : (staged.sizeBytes ?? null);

    // STRAIGHT INTO METRICOOL when the bucket would not take it. Every other
    // route hands Metricool a link and asks it to fetch: a Drive link is
    // handed straight back at any size (row 191, 21 September) and a link
    // served from Vercel cannot carry a whole reel. This one pushes the bytes
    // onto Metricool's own storage — the route its media library uses — and
    // needs no host of ours at all. When it fails, the older routes run
    // exactly as they did, and the refusal says what the upload answered.
    let directUpload: DirectUploadState = { available: !staged.ok && directUploadPossible(sizeBytes) };
    if (directUpload.available) {
      direct = await uploadVideoToMetricool(fileId, title, { blogId: who?.blogId });
      if (!direct.ok && direct.reason === 'pending') {
        // NOT A FAILURE, and not a refusal either: the slices so far are in
        // Metricool and banked, and the next pass — the 15-minute sweep, or
        // the same button — carries on from the first one missing. Nothing
        // else is tried meanwhile: a Drive copy of a 2.7 GB reel is a link
        // Metricool hands back, and a second world-readable copy besides.
        if (who?.userId) {
          void recordVideoEvent({
            userId: who.userId, videoKey: driveVideoKey(fileId), event: 'copy_failed', actor: who.actor ?? 'unknown',
            title, link: videoLink, detail: { reason: 'upload_pending', error: direct.message, ...(direct.progress || {}) },
          });
        }
        return { ok: false, reason: 'failed', code: 'upload_pending', message: direct.message };
      }
      if (!direct.ok) {
        reportError('media-library:direct-upload', new Error(direct.message), {
          fileId, reason: direct.reason, status: String(direct.status ?? ''), shape: direct.shape ?? '',
        });
        directUpload = { available: false, note: direct.message };
      }
    }

    // WHICH SOURCE, BY SIZE. The bucket when it fits (what rows 180 and 182
    // used), the direct upload when it worked, a Drive copy under Google's
    // scan threshold, and this app's own stream only from a host that can
    // actually deliver a whole file. publicBase() throws when there is no
    // address, which is the right sentence for every route but the upload —
    // the one route that needs no address of ours.
    const route = copyRouteFor({
      staged: staged.ok,
      sizeBytes,
      base: direct?.ok ? servingBase : publicBase(),
      directUpload,
    });
    if (route.source === 'refuse') {
      // No attempt first. A Drive copy at Google's confirm=t address WAS tried
      // here on 21 September: it verified, it played, and Metricool stored the
      // link with no video. A verified copy that fails at the send is worse
      // than this refusal, which names the two ways out that work.
      if (who?.userId) {
        void recordVideoEvent({
          userId: who.userId, videoKey: driveVideoKey(fileId), event: 'copy_failed', actor: who.actor ?? 'unknown',
          title, link: videoLink, detail: { reason: 'no_servable_host', error: route.message },
        });
      }
      return { ok: false, reason: 'failed', code: 'no_servable_host', message: route.message };
    }
    if (staged.ok) {
      made = { fileId: staged.key, url: staged.url, sizeBytes: staged.sizeBytes, where: 'bucket' };
    } else if (route.source === 'metricool' && direct?.ok) {
      // The bytes are on Metricool's storage. The URL goes into `media` as is:
      // lib/metricool.ts sends a Metricool-hosted URL without a normalise.
      made = { fileId: direct.copyId, url: direct.url, sizeBytes: direct.sizeBytes, where: 'metricool' };
    } else if (route.source === 'drive') {
      // Under ~100 MB Google serves the file itself rather than its scan page,
      // and this is the path that worked before any of the rest of this existed.
      //
      // A Drive copy this video already has is REUSED, not remade. The cache
      // check above sets a Drive copy aside while the upload is on, so the
      // upload gets its turn — but when the upload fails and this is the route
      // left, making another world-readable copy of the same footage on every
      // press is exactly what rememberPublicCopy exists to prevent.
      const priorDrive = known?.url && parseDriveFileId(known.url) && !parseStreamCopyId(known.id) && !isMetricoolCopyId(known.id)
        ? known
        : null;
      if (priorDrive) {
        made = { fileId: priorDrive.id, url: priorDrive.url, sizeBytes: staged.sizeBytes ?? null, where: 'drive' };
      } else {
        const name = String(title || 'video').replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 80) + '.mp4';
        const copy = await publicVideoCopy(fileId, name);
        made = { fileId: copy.fileId, url: copy.url, sizeBytes: staged.sizeBytes ?? null, where: 'drive' };
      }
    } else if (staged.reason === 'too_large' || staged.reason === 'upload_limit') {
      // THE APP'S OWN DOMAIN. Nothing is copied and nothing is stored: the URL
      // is a signed pointer at the clinic's own file, which this app streams
      // through on demand (app/api/media/video). That is the whole answer to
      // Supabase's fixed 50 MB upload limit \u2014 there is no upload.
      made = {
        fileId: streamCopyId(fileId),
        url: mediaVideoUrl(fileId, publicBase()),
        sizeBytes: staged.sizeBytes ?? null,
        where: 'stream',
      };
    } else {
      throw Object.assign(new Error(staged.message), { stageReason: staged.reason });
    }

    // A direct upload is verified by the upload itself: Drive's byte count
    // matched what left the disk, and the storage answered 2xx. It is not
    // fetched back anonymously, because Metricool's storage need not answer
    // strangers for Metricool to read it — and the check exists to catch a
    // web page stored as a video, which bytes read straight out of Drive
    // cannot be.
    let verdict = made.where === 'metricool' && direct?.ok
      ? { ok: true as const, length: direct.bytes }
      : await verifyPlayableMp4(made.url, made.sizeBytes);

    // THE DRIVE COPY, last and only as a rescue. It is the path that started
    // all of this \u2014 Google answers a download link for a file over ~100 MB
    // with its virus-scan page \u2014 so it is reached only when this app's own
    // host could not answer, and it is verified exactly as before. When it
    // fails too, it fails loudly, naming that page, instead of quietly
    // storing it.
    if (!verdict.ok && made.where === 'stream' && route.source !== 'drive') {
      reportError('media-library:stream-unverified', new Error(verdict.message), { fileId });
      const name = String(title || 'video').replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 80) + '.mp4';
      const copy = await publicVideoCopy(fileId, name);
      made = { fileId: copy.fileId, url: copy.url, sizeBytes: made.sizeBytes, where: 'drive' };
      verdict = await verifyPlayableMp4(made.url, made.sizeBytes);
    }

    if (!verdict.ok) {
      // Not recorded, not sent. Removed so the next attempt starts clean \u2014
      // and for a streamed video there is nothing to remove, which is the one
      // case a catch-all `else` here used to get catastrophically wrong.
      await removeMade(made);
      const message = 'The video copy could not be verified: ' + verdict.message;
      if (who?.userId) {
        void recordVideoEvent({
          userId: who.userId, videoKey: driveVideoKey(fileId), event: 'copy_failed', actor: who.actor ?? 'unknown',
          title, link: videoLink, detail: { reason: 'media_unverified', error: message, where: made.where },
        });
      }
      return { ok: false, reason: 'failed', code: 'media_unverified', message };
    }

    // Remembered immediately: without this, the next press makes ANOTHER
    // world-readable copy of the clinic's footage, and nothing here can delete one.
    await rememberPublicCopy(fileId, { id: made.fileId, url: made.url });
    // THE REGISTER. A copy being made is the moment a video becomes attachable
    // at all, and until now the only evidence was a column quietly changing.
    if (who?.userId) {
      void recordVideoEvent({
        userId: who.userId,
        videoKey: driveVideoKey(fileId),
        event: 'copy_made',
        actor: who.actor ?? 'unknown',
        title,
        link: videoLink,
        detail: { copyId: made.fileId, where: made.where, bytes: verdict.length, verified: true },
      });
    }
    return { ok: true, url: made.url, fileId: made.fileId, created: true };
  } catch (e) {
    reportError('media-library:ensure-copy', e, { fileId });
    // Google says WHICH of five very different problems this is, and the first
    // version of this threw that away and told everyone to "try again" — the
    // right advice for exactly one of them.
    const stageReason = (e as { stageReason?: string } | null)?.stageReason;
    // Two causes that are configuration, not Google: without a public address
    // or a signing key there is no URL to give Metricool at all, and the
    // generic "try again" advice would be the wrong thing to tell anybody.
    let advice = e instanceof MediaBaseUnresolved || e instanceof MediaKeyMissing
      ? { reason: e.code, message: e.message }
      : stageReason
        ? { reason: stageReason, message: e instanceof Error ? e.message : String(e) }
        : copyFailureAdvice(e);
    // Google reports "the drive is full" and "this identity owns no storage at
    // all" with the same code, and only the folder itself distinguishes them.
    // Worth one extra call on a path that has already failed: the difference is
    // between an afternoon clearing space for nothing and a five-minute fix.
    if (advice.reason === 'out_of_space') {
      const folder = await driveFolderReport();
      if (!folder.error) advice = storageAdvice(folder.inSharedDrive);
    }
    // The upload that needs none of the above was tried first. What it
    // answered is the most useful fact on the screen, so it leads.
    if (direct && !direct.ok) {
      advice = {
        ...advice,
        message: 'Uploading this video straight into Metricool was tried first and did not work: ' +
          direct.message.replace(/\.?$/, '.') + ' ' + advice.message,
      };
    }
    // Registered with the CAUSE. While the copies folder is not in a Shared
    // Drive this is the single most common thing that happens to a video, and
    // the only record of it has been a banner that says the latest one.
    if (who?.userId) {
      void recordVideoEvent({
        userId: who.userId,
        videoKey: driveVideoKey(fileId),
        event: 'copy_failed',
        actor: who.actor ?? 'unknown',
        title,
        link: videoLink,
        detail: { reason: advice.reason, error: advice.message },
      });
    }
    return { ok: false, reason: 'failed', code: advice.reason, message: advice.message };
  }
}
