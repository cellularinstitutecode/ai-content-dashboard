// components/slotPreview.ts
// The requests behind a previewed post — the copy, its picture, "Verify /
// fix", the edited copy saved — shared by the dropped strategy's slots
// (components/StrategyDrop.tsx) and "Preview" on a saved template
// (components/TemplatePreview.tsx), so both write, check and picture a post
// through the one route (app/api/templates/strategy-upload/route.ts) and
// show exactly the same thing.

import { friendlyErrorFromResponse } from '@/lib/friendly-error';
import type { UploadSlot } from '@/lib/strategy-upload';

export type PreviewChecks = { keywords: string[]; keywordSource: string; citation: string; held: string | null };
export type PreviewImage = { url: string; alt?: string | null } | null;
export type PreviewDraft = {
  draftId: string | null;
  pack: Record<string, unknown>;
  image: PreviewImage;
  note?: string;
  /** Keywords and the citation verdict, as every other post has them at the door. */
  checks?: PreviewChecks;
  /** Why there is no picture, when the picture step said. */
  imageNote?: string;
  /** What the last Verify / fix concluded. */
  fixNote?: string;
  /** The quality the picture was made at ('medium' for a preview's first take, 'library' for a photograph). */
  imageQuality?: string;
};
/** Which half of the work a post is on. */
export type Writing = 'text' | 'picture' | 'fix' | 'saving' | null;
/** The progress scope a post's loader listens on (components/LoadingScreen.tsx PanelLoader). */
export const scopeFor = (k: string) => 'strategy-' + k;
export const CHANNEL_KEYS: { key: string; label: string }[] = [
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'linkedin', label: 'LinkedIn' },
  { key: 'blog', label: 'Article' },
];

const ROUTE = '/api/templates/strategy-upload';
const headersFor = (scope: string, loud: boolean) => ({ 'Content-Type': 'application/json', 'x-chi-progress': loud ? 'loud' : 'quiet', 'x-chi-progress-scope': scope });

/** The post, written and saved to Recent Drafts (its picture is a second request). */
export async function requestDraft(slot: UploadSlot, direction: string, angle: string, scope: string): Promise<PreviewDraft> {
  const r = await fetch(ROUTE, { method: 'POST', headers: headersFor(scope, true), body: JSON.stringify({ action: 'draft', slot, direction, angle }) });
  if (!r.ok) throw new Error(await friendlyErrorFromResponse(r, 'The post could not be written just now.'));
  return (await r.json()) as PreviewDraft;
}

export type PictureResult = { image: PreviewImage; reason?: string; quality?: string; source?: string; notes?: string[] };

/** The post's picture: a library photograph when one fits, else made; `again` forces a fresh high-quality one. */
export async function requestPicture(draftId: string, again: boolean, scope: string): Promise<PictureResult> {
  const r = await fetch(ROUTE, { method: 'POST', headers: headersFor(scope, false), body: JSON.stringify({ action: 'picture', draftId, again }) });
  if (!r.ok) throw new Error(await friendlyErrorFromResponse(r, 'The picture could not be made just now.'));
  return (await r.json()) as PictureResult;
}

export type FixResult = { pack: Record<string, unknown>; note: string; swapped: boolean; checks: PreviewChecks };

/** "Verify / fix": the cited study checked against the copy, swapped when it does not back it. */
export async function requestFix(draftId: string, scope: string): Promise<FixResult> {
  const r = await fetch(ROUTE, { method: 'POST', headers: headersFor(scope, true), body: JSON.stringify({ action: 'fix', draftId }) });
  if (!r.ok) throw new Error(await friendlyErrorFromResponse(r, 'The citation could not be checked just now.'));
  return (await r.json()) as FixResult;
}

/** The copy as edited, saved to the draft it was written to (PATCH /api/drafts, as Recent Drafts saves). Resolves to the pack as saved. */
export async function requestSave(draftId: string, pack: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch('/api/drafts', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: draftId, pack }) });
  if (!r.ok) throw new Error(await friendlyErrorFromResponse(r, 'We could not save those changes.'));
  const j = (await r.json().catch(() => null)) as { draft?: { pack?: Record<string, unknown> } } | null;
  return j?.draft?.pack || pack;
}

/** The preview with its new picture on it, or with the reason there is none. */
export function withPicture(cur: PreviewDraft, out: PictureResult): PreviewDraft {
  return out.image?.url
    ? { ...cur, image: out.image, imageNote: (out.notes || []).join(' ') || undefined, imageQuality: out.quality, pack: { ...cur.pack, _image: out.image } }
    : { ...cur, imageNote: out.reason || 'The picture could not be made just now.' };
}
