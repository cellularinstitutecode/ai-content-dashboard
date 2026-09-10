'use client';

// MobiusProgress — a band that turns while work is happening, and fills as it
// finishes, with the number readable in the middle.
//
// It replaces two things that were technically present and practically
// invisible: a 2px hairline across the top of the page and a 10px percentage
// chip beside it. progressBus has always computed a calibrated number — a
// per-endpoint moving average of that machine's real durations — and it was
// being whispered.
//
// The shape is not arbitrary. A Möbius strip has exactly ONE edge, so a single
// continuous stroke genuinely traverses the whole band; "filling as it goes" is
// a true statement about the figure rather than a metaphor draped over a
// circle. The arithmetic lives in lib/mobius-progress.ts because this file is a
// component and the test runner only reaches lib/.

import { MOBIUS_INNER_PATH, MOBIUS_PATH, PATH_LENGTH, clampPercent, dashOffsetFor } from '@/lib/mobius-progress';

export default function MobiusProgress({
  percent,
  size = 48,
  showNumber = true,
}: {
  percent: number;
  size?: number;
  showNumber?: boolean;
}) {
  const pct = clampPercent(percent);
  // Under about 40px the digits stop being legible, which is the entire
  // complaint this component exists to answer — so below that it draws the band
  // alone rather than an unreadable number inside one.
  const withNumber = showNumber && size >= 40;

  return (
    <span
      className="mobius relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden="true">
        {/* The band turns; the number below does not. Rotating the digits would
            make them unreadable, which is the problem being fixed. */}
        <g className="mobius-spin" style={{ transformOrigin: '50px 50px' }}>
          {/* The unfilled band. */}
          <path
            d={MOBIUS_PATH}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.14}
            strokeWidth={7}
            strokeLinecap="round"
          />
          {/* The inner edge. Without it the figure reads as a bent wire rather
              than a ribbon with a twist in it. */}
          <path
            d={MOBIUS_INNER_PATH}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.1}
            strokeWidth={1.5}
          />
          {/* Progress. pathLength lets the path declare its own length as 100,
              so the percentage IS the dash offset — nothing is measured, and it
              stays correct at every size this is drawn at. */}
          <path
            d={MOBIUS_PATH}
            fill="none"
            stroke="var(--accent, #0071e3)"
            strokeWidth={7}
            strokeLinecap="round"
            pathLength={PATH_LENGTH}
            strokeDasharray={PATH_LENGTH}
            strokeDashoffset={dashOffsetFor(pct)}
            style={{ transition: 'stroke-dashoffset 220ms cubic-bezier(0.28,0.11,0.32,1)' }}
          />
        </g>
      </svg>

      {withNumber && (
        <span
          className="absolute inset-0 flex items-center justify-center font-semibold tabular-nums text-ink"
          style={{ fontSize: Math.round(size * 0.28) }}
        >
          {pct}
        </span>
      )}

      <style jsx>{`
        .mobius-spin {
          animation: mobius-turn 2.4s linear infinite;
        }
        @keyframes mobius-turn {
          to { transform: rotate(360deg); }
        }
        /* A permanently rotating element is exactly what this setting is for.
           The fill still tracks progress, so nothing is lost but the motion. */
        @media (prefers-reduced-motion: reduce) {
          .mobius-spin { animation: none; }
        }
      `}</style>
    </span>
  );
}
