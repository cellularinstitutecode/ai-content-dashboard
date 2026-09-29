'use client';

// PercentBar — the number, and a blue line under it that fills as the work
// finishes. This replaced the turning Möbius band: the band was decoration
// around the number, and the number is the thing being read.
//
// The arithmetic is trivial (a width in percent), so nothing lives in lib/ for
// it; the clamp is here because NaN and Infinity are not the same mistake —
// NaN is no information and shows nothing, Infinity is past the end and shows
// a full bar.

export function clampPercent(percent: number): number {
  if (Number.isNaN(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

export default function PercentBar({
  percent,
  width = 56,
  fontSize = 15,
  unit = false,
}: {
  percent: number;
  /** The bar's width in px; the number is centred over it. */
  width?: number;
  fontSize?: number;
  /** Show a small % after the number. */
  unit?: boolean;
}) {
  const pct = clampPercent(percent);
  return (
    <span className="inline-flex shrink-0 flex-col items-center" style={{ width }}>
      <span className="font-semibold leading-none tabular-nums text-ink" style={{ fontSize }}>
        {pct}
        {unit && <span className="ml-0.5 align-top font-semibold text-ink-muted" style={{ fontSize: Math.round(fontSize * 0.5) }}>%</span>}
      </span>
      <span
        className="mt-1.5 block h-[3px] w-full overflow-hidden rounded-full"
        style={{ background: 'rgba(0,113,227,0.15)' }}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span
          className="block h-full rounded-full"
          style={{
            width: pct + '%',
            background: 'var(--accent, #0071e3)',
            transition: 'width 220ms cubic-bezier(0.28,0.11,0.32,1)',
          }}
        />
      </span>
    </span>
  );
}
