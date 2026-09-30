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
import PercentBar from './PercentBar';
import { isPaused, queuesRunning, setPaused, subscribePause } from './pauseBus';

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
        <div className="mx-auto flex w-40 flex-col items-center">
          <div
            className="font-display text-[30px] font-bold leading-none tabular-nums text-ink"
            data-testid="panel-loading-percent"
          >
            {snap.percent}
            <span className="ml-0.5 align-top text-[14px] font-semibold text-ink-muted">%</span>
          </div>
          {/* The blue line under the number: fills as the work finishes. */}
          <span className="mt-3 block h-1 w-full overflow-hidden rounded-full" style={{ background: 'rgba(0,113,227,0.15)' }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={snap.percent}>
            <span className="block h-full rounded-full" style={{ width: Math.max(0, Math.min(100, snap.percent)) + '%', background: 'var(--accent, #0071e3)', transition: 'width 220ms cubic-bezier(0.28,0.11,0.32,1)' }} />
          </span>
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
  // The pause (components/pauseBus.ts): shown while a queue that spends money
  // is running — the week a dropped strategy writes — so it can be stopped
  // from anywhere on the page, before the next post or picture is started.
  const [pause, setPause] = useState({ paused: false, queues: 0 });
  useEffect(() => {
    const pull = () => setPause({ paused: isPaused(), queues: queuesRunning() });
    pull();
    return subscribePause(pull);
  }, []);
  const busy = snap.running.length > 0;
  const paused = pause.paused;
  if (!busy && pause.queues === 0) return null;
  return (
    // Vertically centred on the right edge, not tucked under the top bar.
    // At top-4 it sat on the page header — the row carrying the nav and Sign
    // out — and nothing else on the page is fixed, so the right-hand edge is
    // free the whole way down.
    <div className="pointer-events-none fixed right-4 top-1/2 z-[90] -translate-y-1/2" role="status" aria-live="polite">
      {/* The 2px hairline and the 10px chip that used to live here are gone.
          Both were present and neither was noticeable, which is the whole
          reason this changed — one visible thing beats two invisible ones. */}
      <span
        className="flex flex-col items-center gap-1.5 rounded-2xl bg-white/85 px-2.5 pb-1.5 pt-2.5 text-ink-muted shadow-soft ring-1 ring-line backdrop-blur"
        data-testid="top-progress-percent"
        data-percent={snap.percent}
      >
        {/* The number, with a blue line under it that fills as the work finishes. */}
        <PercentBar percent={snap.percent} width={64} fontSize={16} unit />
        {/* What it is doing, which the bus has always carried and this badge
            has always dropped. Capped narrow: it lives beside the page, not in
            it, and a sentence here would be a second thing to read. */}
        {snap.label && (
          <span className="max-w-[92px] px-1 pb-0.5 text-center text-[10px] font-medium leading-tight text-ink-muted">
            {snap.label}
          </span>
        )}
        {paused && !busy && <span className="px-1 text-[10px] font-medium text-amber-700">Paused</span>}
        {pause.queues > 0 && (
          <button
            type="button"
            onClick={() => setPaused(!paused)}
            title={paused ? 'Start the next post and picture again' : 'Stop before the next post or picture is started; what is in flight finishes'}
            className={'pointer-events-auto mt-0.5 rounded-full px-3 py-1 text-[11px] font-semibold ring-1 ' + (paused ? 'bg-accent text-white ring-accent' : 'bg-white text-ink ring-black/10 hover:bg-black/5')}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
        )}
      </span>
      <span className="sr-only">{snap.label} — {snap.percent} percent complete{paused ? ', paused' : ''}</span>
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
