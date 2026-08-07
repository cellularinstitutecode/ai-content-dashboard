// Server-only helper: persist an Opus clip MP4 into Google Drive so the
// dashboard stops depending on Opus's short-lived signed CDN links.
//
// Opus serves finished clips from signed-ext.cdn.opus.pro with an Akamai
// 'hdnts' signed token that EXPIRES. Once it lapses the CDN returns
// "Invalid signed request / Error: 30" and drafts become unplayable.
// The fix: while the token is still valid (right when the webhook fires),
// download the bytes and copy them into a Drive folder we control, then
// store the permanent Drive link instead.
//
// Auth: a Google service account with Drive scope. Set these env vars:
//   GOOGLE_SERVICE_ACCOUNT_JSON  - the full service-account JSON (stringified)
//   DRIVE_FOLDER_ID              - target Drive folder id (shared with the SA)
// NOTE: connect/authorize this credential yourself - never commit the JSON.

import { google } from 'googleapis';
import { Readable } from 'stream';

function driveClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  const creds = JSON.parse(raw);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// Download the source (signed) URL and upload to Drive. Returns a stable
// webViewLink you can persist and replay any time.
export async function persistToDrive(
  sourceUrl: string,
  filename: string
): Promise<{ fileId: string; url: string }> {
  const folderId = process.env.DRIVE_FOLDER_ID;
  if (!folderId) throw new Error('DRIVE_FOLDER_ID missing');

  const res = await fetch(sourceUrl);
  if (!res.ok) {
    // Token likely expired already - surface it so the caller can log/skip.
    throw new Error('source fetch failed: ' + res.status);
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const drive = driveClient();
  const created = await drive.files.create({
    supportsAllDrives: true,
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: 'video/mp4', body: Readable.from(buf) },
    fields: 'id, webViewLink, webContentLink',
  });

    // Make the file readable by anyone with the link so <video> can stream it.
  await drive.permissions.create({
      supportsAllDrives: true,
      fileId: created.data.id as string,
      requestBody: { role: 'reader', type: 'anyone' },
  });

  const fileId = created.data.id as string;
const url =
    created.data.webContentLink ||
    'https://drive.google.com/uc?export=download&id=' + fileId;
  return { fileId, url };
}


// Shared helper: copy each finished clip's MP4 into Google Drive and swap in the
// permanent Drive URL, so BOTH the webhook (fast path) and the /api/opus/clip poll
// (fallback path) store durable links instead of Opus's short-lived signed CDN URLs.
// On a per-clip failure we keep the original Opus link so a single bad clip never
// loses the whole batch. Idempotent-ish: clips already carrying a driveFileId are
// left untouched so repeated polls don't re-upload.
export async function persistClips(clips: any[], projectId: string): Promise<any[]> {
    const out: any[] = [];
    for (let i = 0; i < clips.length; i++) {
          const clip = clips[i];
          if (clip && clip.driveFileId) { out.push(clip); continue; }
          const src = clip?.export || clip?.preview;
          if (!src) { out.push(clip); continue; }
          try {
                  const filename = 'clip-' + projectId + '-' + (i + 1) + '.mp4';
                  const { fileId, url } = await persistToDrive(src, filename);
                  out.push({ ...clip, preview: url, export: url, driveFileId: fileId, opusExport: clip.export });
          } catch (e) {
                  out.push({ ...clip, driveError: (e as any)?.message || 'persist failed' });
          }
    }
    return out;
}
