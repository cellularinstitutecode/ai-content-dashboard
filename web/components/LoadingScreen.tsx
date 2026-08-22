'use client';

// LoadingScreen — the one place the dashboard says "something is happening".
//
// It renders two things from the same progressBus snapshot:
//   • a full-screen frosted overlay with a large numeric percentage, used
//     whenever the user is actively waiting (anything they clicked, plus the
//     first load of the page);
//   • a slim top bar with a small percentage chip for background work
//     (pollers, silent refetches) that must never take over the screen.
//
// Because progressBus observes `fetch` itself, every panel — Content
// Generator, Image Studio, Semrush, Keyword Intelligence, Autopilot, Brand,
// Calendar, Templates and the assistant — feeds this one screen without
// needing its own loading flag.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { installFetchProgress, subscribe, snapshot, type Snapshot } from './progressBus';

const SHOW_AFTER_MS = 220;   // don't flash for a request that finishes instantly

const EMPTY: Snapshot = {
  tasks: [], running: [], percent: 0, active: false, backgroundActive: false, label: '', since: 0,
};

function useProgress(): Snapshot {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    installFetchProgress();
    let alive = true;
    const read = () => { if (alive) setSnap(snapshot()); };
    const unsub = subscribe(read);
    // The eased curve advances with time, not just with events, so the number
    // keeps moving while a single long request is outstanding.
    const tick = window.setInterval(() => {
      if (raf.current != null) return;
      raf.current = window.requestAnimationFrame(() => { raf.current = null; read(); });
    }, 100);
    read();
    return () => {
      alive = false;
      unsub();
      window.clearInterval(tick);
      if (raf.current != null) window.cancelAnimationFrame(raf.current);
    };
  }, []);

  return snap;
}

function Ring({ percent }: { percent: number }) {
  const R = 74;
  const C = 2 * Math.PI * R;
  const offset = C * (1 - Math.max(0, Math.min(100, percent)) / 100);
  return (
    <svg viewBox="0 0 176 176" className="h-44 w-44 -rotate-90" aria-hidden="true">
      <circle cx="88" cy="88" r={R} fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth="8" />
      <circle
        cx="88" cy="88" r={R} fill="none"
        stroke="var(--accent, #0071e3)" strokeWidth="8" strokeLinecap="round"
        strokeDasharray={C} strokeDashoffset={offset}
        style={{ transition: 'stroke-dashoffset 220ms cubic-bezier(0.28,0.11,0.32,1)' }}
      />
    </svg>
  );
}

export function GlobalLoadingScreen() {
  const snap = useProgress();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!snap.active) { setVisible(false); return; }
    const waited = Date.now() - snap.since;
    if (waited >= SHOW_AFTER_MS) { setVisible(true); return; }
    const t = window.setTimeout(() => setVisible(true), SHOW_AFTER_MS - waited);
    return () => window.clearTimeout(t);
  }, [snap.active, snap.since]);

  // Background-only work: a hairline bar, never the screen.
  if (!visible) {
    if (!snap.backgroundActive) return null;
    return (
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[90]" role="status" aria-live="polite">
        <div className="h-0.5 w-full bg-transparent">
          <div
            className="h-0.5 bg-accent/70"
            style={{ width: snap.percent + '%', transition: 'width 220ms cubic-bezier(0.28,0.11,0.32,1)' }}
          />
        </div>
        <div className="flex justify-end px-3 pt-1">
          <span className="rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-ink-muted shadow-soft ring-1 ring-line backdrop-blur">
            {snap.percent}%
          </span>
        </div>
        <span className="sr-only">Background update {snap.percent} percent complete</span>
      </div>
    );
  }

  const running = snap.tasks.filter((t) => t.kind === 'foreground');

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-canvas/70 backdrop-blur-xl"
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="global-loading-screen"
    >
      <div className="mx-4 w-full max-w-md rounded-3xl bg-surface/95 p-8 text-center shadow-pop ring-1 ring-line">
        <div className="relative mx-auto flex h-44 w-44 items-center justify-center">
          <Ring percent={snap.percent} />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <div
              className="font-display text-[52px] font-bold leading-none tabular-nums text-ink"
              data-testid="global-loading-percent"
            >
              {snap.percent}
              <span className="ml-0.5 align-top text-[22px] font-semibold text-ink-muted">%</span>
            </div>
          </div>
        </div>

        <p className="mt-6 text-[15px] font-semibold text-ink" data-testid="global-loading-label">
          {snap.label}
        </p>

        {running.length > 1 && (
          <ul className="mx-auto mt-4 max-w-xs space-y-1.5 text-left">
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

        <div className="mt-6 h-1.5 w-full overflow-hidden rounded-full bg-subtle ring-1 ring-line">
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: snap.percent + '%', transition: 'width 220ms cubic-bezier(0.28,0.11,0.32,1)' }}
          />
        </div>

        <p className="mt-3 text-[11px] text-ink-faint">
          Timing is calibrated from how long this step actually takes on your account.
        </p>
      </div>
    </div>
  );
}

// Mounted once in the root layout, above every panel.
export default function ProgressProvider({ children }: { children: ReactNode }) {
  useEffect(() => { installFetchProgress(); }, []);
  return (
    <>
      {children}
      <GlobalLoadingScreen />
    </>
  );
}
