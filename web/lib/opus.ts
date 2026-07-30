// Server-only OpusClip client.
// Docs: https://help.opus.pro/api-reference/overview
// Base: https://api.opus.pro | Auth: Bearer <OPUS_API_KEY>
//
// Two calls matter here:
//   * opusCreateClipProject  -> POST /api/clip-projects (kick off a render job)
//   * opusGetExportableClips -> GET  /api/exportable-clips?q=findByProjectId (fetch finished clips)
// The previous GET path (/clip-projects/{id}/clips) does not exist and always 404'd.

export interface CreateClipProjectInput {
  videoUrl: string;
  brandTemplateId?: string;
  language?: string; // ISO code, e.g. 'en'
  title?: string;    // custom project title (uploadedVideoAttr.title)
}

export interface OpusClip {
  id: string;
  projectId: string;
  title: string;
  text: string;
  description: string;
  hashtags: string;
  durationMs: number;
  preview: string; // uriForPreview (streamable mp4)
  export: string;  // uriForExport (download mp4)
}

function opusKey() {
  const k = process.env.OPUS_API_KEY;
  if (!k) throw new Error('OPUS_API_KEY missing');
  return k;
}

// Optional org header — required only for API keys that belong to multiple orgs.
function orgHeader(): Record<string, string> {
  const org = process.env.OPUS_ORG_ID;
  return org ? { 'x-opus-org-id': org } : {};
}

export async function opusCreateClipProject(input: CreateClipProjectInput) {
  // Register a per-project webhook so Opus notifies us the moment clips are ready,
  // instead of us polling blindly. OPUS_WEBHOOK_URL should point at /api/opus/webhook.
  const webhookUrl = process.env.OPUS_WEBHOOK_URL;
  const body: Record<string, unknown> = {
    videoUrl: input.videoUrl,
    ...(input.brandTemplateId ? { brandTemplateId: input.brandTemplateId } : {}),
    ...(input.language ? { importPreference: { sourceLang: input.language } } : {}),
    ...(input.title ? { uploadedVideoAttr: { title: input.title } } : {}),
    ...(webhookUrl
      ? { conclusionActions: [{ type: 'WEBHOOK', notifyFailure: true, url: webhookUrl }] }
      : {}),
  };

  const res = await fetch('https://api.opus.pro/api/clip-projects', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + opusKey(),
      'Content-Type': 'application/json',
      ...orgHeader(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) throw new Error('Opus ' + res.status + ': ' + JSON.stringify(data));
  return data; // { id / projectId, orgId, sourceInfo, ... }
}

// Normalize whatever Opus returns for a clip into our OpusClip shape.
function normalizeClip(c: any): OpusClip {
  return {
    id: String(c?.id ?? ''),
    projectId: String(c?.projectId ?? ''),
    title: String(c?.title ?? ''),
    text: String(c?.text ?? ''),
    description: String(c?.description ?? ''),
    hashtags: String(c?.hashtags ?? ''),
    durationMs: Number(c?.durationMs ?? 0) || 0,
    preview: String(c?.uriForPreview ?? ''),
    export: String(c?.uriForExport ?? ''),
  };
}

// Fetch finished (exportable) clips for a project.
// Correct endpoint per Opus docs: GET /api/exportable-clips?q=findByProjectId&projectId=<id>
export async function opusGetExportableClips(projectId: string): Promise<OpusClip[]> {
  const url =
    'https://api.opus.pro/api/exportable-clips?q=findByProjectId&projectId=' +
    encodeURIComponent(projectId);
  const res = await fetch(url, {
    headers: {
      'Authorization': 'Bearer ' + opusKey(),
      ...orgHeader(),
    },
  });
  const data = await res.json().catch(() => ([] as any));
  if (!res.ok) throw new Error('Opus ' + res.status + ': ' + JSON.stringify(data));
  const arr = Array.isArray(data) ? data : Array.isArray((data as any)?.data) ? (data as any).data : [];
  return arr.map(normalizeClip);
}

// Back-compat alias for older imports.
export const opusGetClips = opusGetExportableClips;
