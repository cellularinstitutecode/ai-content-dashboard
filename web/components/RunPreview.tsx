'use client';

// components/RunPreview.tsx
// The Calendar / Publishing page's preview of an Autopilot draft that is still
// waiting for approval: the same picture, copy and warnings the Dashboard card
// shows, with the same decisions under it. Approve goes through the one route
// the Dashboard uses (POST /api/autopilot/runs); this only draws.

import { useState, type ReactNode } from 'react';
import { citationLabel, type CitationCheck } from '@/lib/citation';
import { claimSupportNote, type ClaimSupportStamp } from '@/lib/claim-support';
import { fixPlan, fixRunning, fixStepsLabel, runFixInput, type FixStatus } from '@/lib/fix-plan';
import { imageUnshippable } from '@/lib/image-verdict';
import { complianceLines, runChannels } from '@/lib/publishing-list';
import { fmtScheduleSlot } from '@/lib/schedule-clock';
import FixStatusLine from '@/components/FixStatusLine';

export type ReviewRunImage = {
  url: string;
  alt?: string;
  model?: string;
  verification?: { status?: 'approved' | 'flagged' | 'unchecked'; score?: number | null; issues?: string[]; textDetected?: boolean; bannedProp?: boolean };
  titled?: { title: string; photoUrl: string };
  source?: string;
  /** Older takes only: an AI image styled after a library photo (that path is gone). */
  styledAfter?: string;
  brandGraded?: boolean;
  libraryName?: string;
};

/** What GET /api/autopilot/runs returns for one run, as far as this page reads it. */
export type ReviewRun = {
  id: string;
  draft_id: string | null;
  template_name: string;
  writes_article?: boolean;
  scheduled_for: string;
  state: string;
  missed?: boolean;
  angle: { query?: string; rationale?: string; fix?: FixStatus | null } | null;
  score: { total: number; safetyFlags: { code: string; message: string }[]; promotionFlags?: string[]; openingRepeat?: boolean } | null;
  pack: (Record<string, unknown> & { _image?: ReviewRunImage; _compliance?: { citation?: CitationCheck | null }; _claimSupport?: ClaimSupportStamp | null }) | null;
};

const btn = 'rounded-full px-3 py-1 text-[12px] font-medium transition disabled:opacity-50 ';

/** Badge under the picture: the verifier's verdict, worded as on the Dashboard. */
export function ImageVerdictBadge({ image }: { image: ReviewRunImage | undefined }) {
  const v = image?.verification;
  if (!image?.url) return null;
  if (['library', 'upload'].includes(String(image.source || ''))) {
    // A brand-graded library photo was checked like a cover: a flag on it is shown, as FIX reads it.
    const flagged = image.brandGraded && v?.status === 'flagged';
    return (
      <>
        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[10px] font-semibold text-sky-800">{image.brandGraded ? 'Clinic photo · brand filter' : 'Clinic photo'}</span>
        {flagged && <span className="rounded-full bg-amber-500/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(v?.issues || []).join(' · ')}>⚠ flagged: {(v?.issues || []).slice(0, 2).join('; ')}</span>}
      </>
    );
  }
  if (v?.textDetected) return <span className="rounded-full bg-red-600/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(v.issues || []).join(' · ')}>✗ text in image — change it before approving</span>;
  if (imageUnshippable(v)) return <span className="rounded-full bg-red-600/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(v?.issues || []).join(' · ')}>✗ banned prop in frame — this image will not ship</span>;
  if (v?.status === 'approved') return <span className="rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-semibold text-white" title={v.score != null ? 'Machine-verified clean · ' + v.score + '/100' : 'Machine-verified clean'}>✓ verified</span>;
  if (v?.status === 'flagged') return <span className="rounded-full bg-amber-500/95 px-2 py-0.5 text-[10px] font-semibold text-white" title={(v.issues || []).join(' · ')}>⚠ flagged: {(v.issues || []).slice(0, 2).join('; ') || 'check before approving'}</span>;
  return <span className="rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white">review manually</span>;
}

export default function RunPreview({
  run,
  busy,
  onClose,
  onApprove,
  onApproveDraft,
  onSkip,
  onFix,
  imageControls,
}: {
  run: ReviewRun;
  busy: boolean;
  onClose: () => void;
  /** Approve & schedule — the caller confirms and posts to /api/autopilot/runs. */
  onApprove: () => void;
  onApproveDraft: () => void;
  onSkip: () => void;
  /**
   * FIX — resolve every warning shown here (POST /api/autopilot/runs
   * { action: 'fix' }). It runs in the background; its progress and result
   * are on the run (angle.fix), shown by FixStatusLine.
   */
  onFix?: () => void;
  /** The Image section (New AI image / library), rendered under the picture. */
  imageControls?: ReactNode;
}) {
  const channels = runChannels(run.pack);
  const [openChannel, setOpenChannel] = useState<string | null>(null);
  const open = openChannel && channels.includes(openChannel) ? openChannel : channels[0] || '';
  const text = open && run.pack ? String(run.pack[open] || '') : '';
  const lines = complianceLines(text);
  const image = run.pack?._image;
  const citation = run.pack?._compliance?.citation;
  const citationBad = citation && ['not_found', 'mismatch', 'no_doi'].includes(String(citation.status));
  const claim = claimSupportNote(run.pack?._claimSupport);
  const plan = fixPlan(runFixInput(run));
  const fixing = fixRunning(run.angle);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl ring-1 ring-black/10" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Autopilot draft preview">
        <div className="flex items-start justify-between gap-3 border-b border-black/5 px-5 py-4">
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <span className="rounded-full bg-amber-100 px-2 py-[2px] text-[10px] font-semibold text-amber-800">Autopilot · needs approval</span>
              {run.missed && <span className="rounded-full bg-red-100 px-2 py-[2px] text-[10px] font-semibold text-red-700" title="Its time passed before it was approved">Missed</span>}
              {run.score && <span className={'rounded-full px-2 py-[2px] text-[10px] font-semibold ' + (run.score.total >= 70 ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700')}>{run.score.total}/100</span>}
            </div>
            <h3 className="truncate text-base font-semibold text-ink">{run.angle?.query || run.template_name || 'Autopilot draft'}</h3>
            <p className="mt-0.5 text-[12px] text-ink/50">{fmtScheduleSlot(run.scheduled_for)} · {run.template_name}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-full px-2 text-lg leading-none text-ink/50 hover:bg-black/5" aria-label="Close preview">×</button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {image?.url ? (
            <div className="mb-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt={image.alt || 'AI hero image'} className="max-h-72 w-full rounded-xl object-contain ring-1 ring-black/5" />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <ImageVerdictBadge image={image} />
                <span className="text-[11px] text-ink/50">{image.styledAfter ? 'AI image styled after a library photo. ' : image.titled && image.source === 'library' ? 'Library photo with the post title — no AI. ' : ''}Attaches to the post on approve.</span>
              </div>
            </div>
          ) : (
            <p className="mb-3 text-[12px] text-ink/50">No image yet.</p>
          )}
          {imageControls}

          {/* The same warnings the Dashboard card shows, so nothing is approved
              here that would have been held there. */}
          {run.score && run.score.safetyFlags.length > 0 && (
            <div className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800">⚠ {run.score.safetyFlags.length} compliance flag(s): {run.score.safetyFlags.map((f) => f.message).join(' ')}</div>
          )}
          {citation && citation.status !== 'verified' && citation.status !== 'not_required' && (
            <div className={'mb-2 rounded-xl px-3 py-2 text-[12px] ' + (citationBad ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}>
              {citationBad ? '✗ ' : '⚠ '}{citationLabel(citation)}{citation.status === 'not_found' || citation.status === 'mismatch' ? ' — this post will not be sent until the REF line cites a real study.' : ''}
            </div>
          )}
          {claim && (
            <div className={'mb-2 rounded-xl px-3 py-2 text-[12px] ' + (run.pack?._claimSupport?.status === 'unsupported' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}>⚠ {claim}</div>
          )}
          {Boolean(run.score?.promotionFlags?.length) && (
            <div className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800">⚠ Reads as promotion: {run.score!.promotionFlags!.join(', ')}. Ask for changes on the Dashboard, or skip it.</div>
          )}
          {run.score?.openingRepeat && (
            <div className="mb-2 rounded-xl bg-amber-50 px-3 py-2 text-[12px] text-amber-800">⚠ Opens the same way as a recent post.</div>
          )}
          {/* One button for every warning above, as on the Dashboard card. */}
          {plan.steps.length > 0 && onFix && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl bg-amber-50/70 px-3 py-2 text-[12px] text-amber-900 ring-1 ring-amber-200/60">
              <span className="min-w-0">Fix the {fixStepsLabel(plan.steps)} automatically, then re-check.</span>
              <button type="button" disabled={busy || fixing} onClick={onFix} title={'Resolves: ' + plan.reasons.join('; ')} className={btn + 'ml-auto bg-accent font-semibold text-white hover:opacity-90'}>{fixing ? 'Fixing…' : 'FIX'}</button>
            </div>
          )}
          <FixStatusLine angle={run.angle} steps={plan.steps} className="mb-2 block" />

          {channels.length > 0 ? (
            <>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {channels.map((c) => (
                  <button key={c} type="button" onClick={() => setOpenChannel(c)} className={'rounded-full px-3 py-1 text-[12px] font-medium transition ' + (open === c ? 'bg-ink text-white' : 'bg-black/5 text-ink/60 hover:text-ink')}>{c}</button>
                ))}
              </div>
              <div className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl bg-canvas p-3 text-[13px] leading-relaxed text-ink ring-1 ring-black/5">{text}</div>
              <dl className="mt-2 space-y-1 text-[11px]">
                <div className="flex gap-2"><dt className="w-12 shrink-0 font-semibold text-ink/50">REF</dt><dd className={'min-w-0 break-words ' + (lines.ref ? 'text-ink/80' : 'text-red-600')}>{lines.ref ? lines.ref.replace(/^REF(?:ERENCIA)?\s*[.:：]\s*/i, '') : 'No REF line in this copy.'}</dd></div>
                <div className="flex gap-2"><dt className="w-12 shrink-0 font-semibold text-ink/50">AVISO</dt><dd className={'min-w-0 break-words ' + (lines.aviso ? 'text-ink/80' : 'text-ink/50')}>{lines.aviso || 'No AVISO line in this copy — it is added when the post is sent.'}</dd></div>
              </dl>
            </>
          ) : (
            <p className="text-[12px] text-ink/50">This draft has no copy yet.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-black/5 bg-canvas px-5 py-3">
          <span className="text-[11px] text-ink/50">{run.missed ? 'Its time has passed. Re-date it from the Dashboard, or skip it.' : 'Nothing goes out until you approve it.'}</span>
          <span className="flex-1" />
          {run.missed ? null : (
            <>
              <button type="button" disabled={busy || fixing} title={fixing ? 'Wait for FIX to finish' : undefined} onClick={onApprove} className={btn + 'bg-accent font-semibold text-white hover:opacity-90'}>{busy ? 'Working…' : 'Approve & schedule'}</button>
              {run.writes_article ? (
                <span className="text-[11px] text-ink/50" title="Articles are approved and scheduled together, so the post and its link go out at the slot.">No draft option for articles</span>
              ) : (
                <button type="button" disabled={busy || fixing} onClick={onApproveDraft} className={btn + 'text-ink/70 ring-1 ring-black/10 hover:bg-black/5'}>Approve as draft</button>
              )}
            </>
          )}
          <button type="button" disabled={busy || fixing} onClick={onSkip} className={btn + 'text-red-600 ring-1 ring-red-200 hover:bg-red-50'}>{busy ? 'Working…' : 'Skip'}</button>
        </div>
      </div>
    </div>
  );
}
