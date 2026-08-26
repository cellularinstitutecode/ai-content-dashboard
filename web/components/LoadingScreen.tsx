'use client';

// Loading UI — two pieces, neither of which ever covers the whole app:
//
//   • PanelLoader — a frosted overlay with the calibrated percentage ring that
//     covers ONLY the panel doing generation work (Content Generator, Image
//     Studio, Autopilot, the calendar's AI drafting, the assistant). It reads
//     the shared progressBus scoped to its own panel, so two panels generating
//     at once each show their own honest number.
//   • TopProgressBar — a 2px hairline with a small % chip for everything else
//     (sign-in boot fetches, saves, refreshes, pollers). Informative, never
//     blocking, and it also covers a generation that keeps running after the
//     user navigates away from the panel that started it.
//
// The old full-screen overlay is gone on purpose: only drafting and image
// generation earn a loading screen, and it takes up the panel, not the page.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  installFetchProgress, subscribe, snapshot, scopedSnapshot, type Snapshot,
} from './progressBus';

const SHOW_AFTER_MS = 220;   // don't flash for a request that finishes instantly

const EMPTY: Snapshot = {
  tasks: [], running: [], percent: 0, active: false, backgroundActive: false, label: '', since: 0,
};

function useProgress(read: () => Snapshot): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    installFetchProgress();
    let alive = true;
    const pull = () => { if (alive) setSnap(read()); };
    const unsub = subscribe(pull);
    // The eased curve advances with time, not just with events, so the number
    // keeps moving while a single long request is outstanding.
    const tick = window.setInterval(() => {
      if (raf.current != null) return;
      raf.current = window.requestAnimationFrame(() => { raf.current = null; pull(); });
    }, 100);
    pull();
    return () => {
      alive = false;
      unsub();
      window.clearInterval(tick);
      if (raf.current != null) window.cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return snap;
}

function Ring({ percent, size = 176 }: { percent: number; size?: number }) {
  const R = size * 0.42;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - Math.max(0, Math.min(100, percent)) / 100);
  const mid = size / 2;
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full -rotate-90" aria-hidden="true">
      <circle cx={mid} cy={mid} r={R} fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth="8" />
      <circle
        cx={mid} cy={mid} r={R} fill="none"
        stroke="var(--accent, #0071e3)" strokeWidth="8" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 220ms cubic-bezier(0.28,0.11,0.32,1)' }}
      />
    </svg>
  );
}

// Covers exactly one panel while that panel is drafting or generating images.
// Drop it inside any container with `position: relative`; it fills the
// container, matches its rounded corners, and disappears when the work ends.
export function PanelLoader({ scope, rounded = 'rounded-3xl' }: { scope: string; rounded?: string }) {
  const snap = useProgress(() => scopedSnapshot(scope));
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!snap.active) { setVisible(false); return; }
    const waited = Date.now() - snap.since;
    if (waited >= SHOW_AFTER_MS) { setVisible(true); return; }
    const t = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS - waited);
    return () => window.clearTimeout(t);
  }, [snap.active, snap.since]);

  if (!visible) return null;

  const running = snap.tasks;

  return (
    <div
      className={
        'absolute inset-0 z-20 flex items-center justify-center bg-surface/75 backdrop-blur-md ' + rounded
      }
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="panel-loading-screen"
      data-scope={scope}
    >
      <div className="mx-4 w-full max-w-xs p-4 text-center">
        <div className="relative mx-auto flex h-28 w-28 items-center justify-center">
          <Ring percent={snap.percent} size={112} />
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className="font-display text-[30px] font-bold leading-none tabular-nums text-ink"
              data-testid="panel-loading-percent"
            >
              {snap.percent}
              <span className="ml-0.5 align-top text-[14px] font-semibold text-ink-muted">%</span>
            </div>
          </div>
        </div>

        <p className="mt-4 text-[14px] font-semibold text-ink" data-testid="panel-loading-label">
          {snap.label}
        </p>

        {running.length > 1 && (
          <ul className="mx-auto mt-3 max-w-[240px] space-y-1 text-left">
            {running.map((t) => (
              <li key={t.id} className="flex items-center gap-2 text-[12px] leading-tight">
                <span
                  className={
                    'h-1.5 w-1.5 shrink-0 rounded-full ' +
                    (t.state === 'done' ? 'bg-emerald-500' : t.state === 'error' ? 'bg-red-500' : 'animate-pulse bg-accent')
                  }
                />
                <span className={t.state === 'running' ? 'text-ink-muted' : 'text-ink-faint line-through decoration-ink-faint/40'}>
                  {t.label}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-3 text-[11px] text-ink-faint">
          Timing is calibrated from how long this step actually takes on your account.
        </p>
      </div>
    </div>
  );
}

// Everything that is not generation: a hairline at the top of the page with a
// small percentage chip. Never blocks, never takes over the screen.
export function TopProgressBar() {
  const snap = useProgress(() => snapshot());
  const busy = snap.running.length > 0;
  if (!busy) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[90]" role="status" aria-live="polite">
      <div className="h-0.5 w-full bg-transparent">
        <div
          className="h-0.5 bg-accent/70"
          style={{ width: snap.percent + '%', transition: 'width 220ms cubic-bezier(0.28,0.11,0.32,1)' }}
        />
      </div>
      <div className="flex justify-end px-3 pt-1">
        <span
          className="rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-ink-muted shadow-soft ring-1 ring-line backdrop-blur"
          data-testid="top-progress-percent"
        >
          {snap.percent}%
        </span>
      </div>
      <span className="sr-only">Update {snap.percent} percent complete</span>
    </div>
  );
}

// Mounted once in the root layout, above every panel.
export default function ProgressProvider({ children }: { children: ReactNode }) {
  useEffect(() => { installFetchProgress(); }, []);
  return (
    <>
      {children}
      <TopProgressBar />
    </>
  );
}
