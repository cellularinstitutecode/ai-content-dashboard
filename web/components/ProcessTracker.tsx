'use client';

// ProcessTracker: ONE shared, visual "what is happening right now" pipeline
// used by every generator on the dashboard — the Content Generator, the Image
// Studio and the Autopilot engine. Each step lights up as the real network
// call behind it starts and finishes, so the viewer always sees WHERE in the
// process a generation is (researching → drafting → image → verifying)
// instead of a bare spinner. The same component also renders a compact
// horizontal variant used on Autopilot "in the pipeline" rows.

import { useEffect, useRef, useState } from 'react';

export type StepStatus = 'pending' | 'active' | 'done' | 'error' | 'skipped';
export type ProcessStep = { id: string; label: string; detail?: string; status: StepStatus };

export function makeSteps(defs: { id: string; label: string; detail?: string }[]): ProcessStep[] {
  return defs.map((d) => ({ ...d, status: 'pending' as StepStatus }));
}

// Mark every step before `id` done and `id` itself active.
export function stepActive(steps: ProcessStep[], id: string): ProcessStep[] {
  const idx = steps.findIndex((s) => s.id === id);
  if (idx < 0) return steps;
  return steps.map((s, i) => ({
    ...s,
    status: i < idx ? (s.status === 'skipped' || s.status === 'error' ? s.status : 'done') : i === idx ? 'active' : 'pending',
  }));
}

// Mark the currently active step (or `id` when given) as failed; later steps stay pending.
export function stepError(steps: ProcessStep[], id?: string): ProcessStep[] {
  const idx = id ? steps.findIndex((s) => s.id === id) : steps.findIndex((s) => s.status === 'active');
  if (idx < 0) return steps;
  return steps.map((s, i) => (i === idx ? { ...s, status: 'error' } : s));
}

// Mark specific steps skipped (e.g. image generation turned off).
export function stepSkip(steps: ProcessStep[], ids: string[]): ProcessStep[] {
  return steps.map((s) => (ids.includes(s.id) ? { ...s, status: 'skipped' } : s));
}

// Everything done (a finished run).
export function stepsDone(steps: ProcessStep[]): ProcessStep[] {
  return steps.map((s) => (s.status === 'skipped' || s.status === 'error' ? s : { ...s, status: 'done' }));
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done') {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-[11px] font-bold text-white">✓</span>
    );
  }
  if (status === 'active') {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-[11px] font-bold text-white">✕</span>
    );
  }
  if (status === 'skipped') {
    return (
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-subtle text-[10px] font-semibold text-ink-faint ring-1 ring-line">–</span>
    );
  }
  return <span className="mx-1 flex h-3 w-3 shrink-0 rounded-full bg-subtle ring-1 ring-line" />;
}

// Live elapsed-seconds counter shown next to the active step, so a long image
// generation reads as "working (23s)" instead of looking frozen.
function Elapsed({ runningKey }: { runningKey: string }) {
  const [sec, setSec] = useState(0);
  const key = useRef(runningKey);
  useEffect(() => {
    if (key.current !== runningKey) { key.current = runningKey; setSec(0); }
    const t = setInterval(() => setSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [runningKey]);
  if (sec < 2) return null;
  return <span className="text-[11px] tabular-nums text-ink-faint">{sec}s</span>;
}

export default function ProcessTracker({
  title,
  steps,
  onClose,
  compact = false,
}: {
  title?: string;
  steps: ProcessStep[];
  onClose?: () => void;
  compact?: boolean;
}) {
  const total = steps.filter((s) => s.status !== 'skipped').length || 1;
  const done = steps.filter((s) => s.status === 'done').length;
  const activeStep = steps.find((s) => s.status === 'active');
  const failed = steps.some((s) => s.status === 'error');
  const finished = !activeStep && !failed && done > 0 && done >= total;
  const pct = Math.round(((done + (activeStep ? 0.5 : 0)) / total) * 100);

  if (compact) {
    // Horizontal mini pipeline: dot–line–dot with the active stage pulsing.
    return (
      <div className="flex items-center gap-1" aria-label={title || 'Progress'}>
        {steps.map((s, i) => (
          <span key={s.id} className="flex items-center gap-1" title={s.label}>
            {i > 0 && <span className={'h-px w-3 ' + (s.status === 'done' || s.status === 'active' ? 'bg-emerald-400' : 'bg-line')} />}
            <span
              className={
                'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ' +
                (s.status === 'done'
                  ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                  : s.status === 'active'
                  ? 'bg-accent/10 text-accent ring-accent/30'
                  : s.status === 'error'
                  ? 'bg-red-50 text-red-700 ring-red-200'
                  : 'bg-subtle text-ink-faint ring-line')
              }
            >
              {s.status === 'active' && <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />}
              {s.status === 'done' && '✓ '}
              {s.label}
            </span>
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-line" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 border-b border-line bg-subtle/50 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {!finished && !failed && <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />}
          <span className="truncate text-[13px] font-semibold text-ink">
            {failed ? 'Something went wrong' : finished ? 'All done' : title || 'Working…'}
          </span>
          {activeStep && <Elapsed runningKey={activeStep.id} />}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] font-medium tabular-nums text-ink-faint">{Math.min(pct, 100)}%</span>
          {onClose && (finished || failed) && (
            <button type="button" onClick={onClose} className="rounded-full px-2 py-0.5 text-[11px] font-medium text-ink-muted ring-1 ring-line transition hover:bg-subtle">
              Hide
            </button>
          )}
        </div>
      </div>
      <div className="h-1 w-full bg-subtle">
        <div
          className={'h-1 transition-all duration-500 ' + (failed ? 'bg-red-400' : 'bg-emerald-500')}
          style={{ width: Math.min(pct, 100) + '%' }}
        />
      </div>
      <ol className="space-y-2.5 px-4 py-3">
        {steps.map((s) => (
          <li key={s.id} className="flex items-center gap-2.5">
            <StepIcon status={s.status} />
            <div className="min-w-0">
              <div
                className={
                  'text-[13px] leading-tight ' +
                  (s.status === 'active'
                    ? 'font-semibold text-ink'
                    : s.status === 'done'
                    ? 'font-medium text-ink'
                    : s.status === 'error'
                    ? 'font-semibold text-red-700'
                    : 'text-ink-faint')
                }
              >
                {s.label}
                {s.status === 'skipped' && <span className="ml-1.5 text-[11px] font-normal text-ink-faint">skipped</span>}
              </div>
              {s.detail && (s.status === 'active' || s.status === 'error') && (
                <div className={'mt-0.5 text-[11px] leading-tight ' + (s.status === 'error' ? 'text-red-600' : 'text-ink-muted')}>{s.detail}</div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
