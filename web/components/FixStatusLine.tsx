'use client';

// components/FixStatusLine.tsx
// What the FIX button is doing for a run, read from the run itself
// (`angle.fix`, lib/fix-plan.ts fixView): "Fixing the citation and copy…
// started 12:03 · now: the image · 45 s" while it works, the result when it
// is done, and a plain "did not finish" when the platform cut it off, so the
// card never waits forever. FIX runs after its request answers; the page
// polls the run while this says running.

import { useEffect, useState } from 'react';
import { FIX_STALLED_NOTE, fixStepsLabel, fixView, type FixStatus, type FixStep } from '@/lib/fix-plan';

/** "12:03" in the viewer's clock, or nothing when the stamp cannot be read. */
function clock(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function FixStatusLine({ angle, steps, className = '' }: {
  angle: { fix?: FixStatus | null } | null | undefined;
  /** The steps the card shows warnings for (fixPlan), named while it runs. */
  steps: readonly FixStep[];
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const view = fixView(angle, now);
  const running = view?.kind === 'running';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  if (!view) return null;

  const box = 'rounded-xl px-3 py-2 text-[12px] ring-1 ' + className + ' ';
  if (view.kind === 'running') {
    const planned = angle?.fix?.steps?.length ? angle.fix.steps : steps;
    const what = planned.length ? 'the ' + fixStepsLabel(planned) : 'this post';
    const started = clock(view.startedAt);
    return (
      <div role="status" className={box + 'bg-sky-50 text-sky-900 ring-sky-100'}>
        Fixing {what}…{started ? ' started ' + started + ' ·' : ''}{view.step ? ' now: the ' + view.step + ' ·' : ''} {view.elapsedSec} s. This usually takes one to four minutes. You can close this and keep working.
      </div>
    );
  }
  if (view.kind === 'stalled') {
    return <div role="status" className={box + 'bg-amber-50 text-amber-900 ring-amber-200/60'}>{FIX_STALLED_NOTE}</div>;
  }
  return (
    <div role="status" className={box + (view.clean ? 'bg-emerald-50 text-emerald-700 ring-emerald-100' : 'bg-amber-50 text-amber-900 ring-amber-200/60')}>
      {view.note}
    </div>
  );
}
