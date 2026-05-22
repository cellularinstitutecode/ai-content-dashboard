// Server-only OpusClip client.
// Docs: https://help.opus.pro/api-reference/overview
// Base: https://api.opus.pro  |  Auth: Bearer <OPUS_API_KEY>

export interface CreateClipProjectInput {
  videoUrl: string;
  brandTemplateId?: string;
  language?: string; // ISO code, e.g. 'en'
}

function opusKey() {
  const k = process.env.OPUS_API_KEY;
  if (!k) throw new Error('OPUS_API_KEY missing');
  return k;
}

export async function opusCreateClipProject(input: CreateClipProjectInput) {
  const res = await fetch('https://api.opus.pro/api/clip-projects', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + opusKey(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      videoUrl: input.videoUrl,
      ...(input.brandTemplateId ? { brandTemplateId: input.brandTemplateId } : {}),
      ...(input.language ? { language: input.language } : {})
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Opus ' + res.status + ': ' + JSON.stringify(data));
  return data; // { projectId, ... }
}

export async function opusGetClips(projectId: string) {
  const res = await fetch('https://api.opus.pro/api/clip-projects/' + projectId + '/clips', {
    headers: { 'Authorization': 'Bearer ' + opusKey() }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Opus ' + res.status + ': ' + JSON.stringify(data));
  return data;
}
