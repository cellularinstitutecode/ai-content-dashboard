'use client';

// components/QueueCalendar.tsx
// The publishing queue as a month (lib/queue-calendar.ts). Each post is a chip
// on its day — time, status, the start of its caption, its channel — with a
// one-click Approve on posts waiting for approval, as on the calendar page.
// Clicking a day or a chip selects that day; the page then lists that day's
// posts underneath with the full set of buttons. Clicking a chip's text opens
// the post's preview.

import { gridKey, monthGrid, shiftMonth, type MonthCursor } from '@/lib/queue-calendar';
import { isAwaitingApproval } from '@/lib/post-mode';
import { metricoolPlannerUrl } from '@/lib/metricool-links';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Post = { id?: string; text?: string; providers?: string[]; status?: string; videoPending?: boolean; publication_date?: string };

export default function QueueCalendar<T extends Post>({
  cursor,
  onCursor,
  byDay,
  todayKey,
  selectedDay,
  onSelectDay,
  timeOf,
  onPreview,
  onApprove,
  approvingId,
  matchIds,
  plannerUrl,
}: {
  cursor: MonthCursor;
  onCursor: (c: MonthCursor) => void;
  byDay: Map<string, T[]>;
  todayKey: string;
  selectedDay: string;
  onSelectDay: (key: string) => void;
  timeOf: (p: T) => string;
  onPreview: (id: string) => void;
  onApprove: (p: T) => void;
  approvingId: string | null;
  /** While a search is on, the posts it matches; the rest are dimmed. */
  matchIds: Set<string> | null;
  /** Metricool's own calendar for this brand; the clinic's default when omitted. */
  plannerUrl?: string;
}) {
  const grid = monthGrid(cursor);
  const label = new Date(cursor.year, cursor.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const btn = 'rounded-full bg-white px-3.5 py-1.5 text-[12px] font-medium text-ink ring-1 ring-line transition hover:bg-subtle';

  return (
    <div className="mt-3" aria-label="Publishing queue calendar">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button type="button" className={btn} onClick={() => onCursor(shiftMonth(cursor, -1))}>&lsaquo; Prev</button>
          <button
            type="button"
            className={btn}
            onClick={() => { const [y, m] = todayKey.split('-').map(Number); onCursor({ year: y, month: m - 1 }); onSelectDay(todayKey); }}
          >
            Today
          </button>
          <button type="button" className={btn} onClick={() => onCursor(shiftMonth(cursor, 1))}>Next &rsaquo;</button>
        </div>
        <div className="flex items-center gap-3">
          <h3 className="text-[16px] font-semibold text-ink">{label}</h3>
          <a
            href={plannerUrl || metricoolPlannerUrl()}
            target="_blank"
            rel="noopener noreferrer"
            title="What has been posted and what is waiting for approval, on Metricool's calendar"
            className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-transparent px-3 py-1.5 text-[12px] font-medium text-accent transition hover:bg-accent/5"
          >
            {'\u{1F4C5}'} Metricool planner ↗
          </a>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1.5">
        {DOW.map((d) => <div key={d} className="py-1 text-center text-[11px] font-medium text-ink-faint">{d}</div>)}
        {grid.map((day) => {
          const k = gridKey(day);
          const inMonth = day.getMonth() === cursor.month;
          const posts = byDay.get(k) ?? [];
          const selected = k === selectedDay;
          const shown = posts.slice(0, 3);
          return (
            <div
              key={k}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={day.toDateString() + (posts.length ? ', ' + posts.length + ' post' + (posts.length === 1 ? '' : 's') : '')}
              onClick={() => onSelectDay(k)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectDay(k); } }}
              className={
                'flex min-h-[96px] min-w-0 cursor-pointer flex-col rounded-xl p-1.5 ring-1 transition ' +
                (inMonth ? 'bg-white ' : 'bg-subtle/60 ') +
                (selected ? 'ring-2 ring-accent ' : 'ring-line hover:ring-accent/40 ')
              }
            >
              <div className={'mb-1 text-right text-[11px] tabular-nums ' + (k === todayKey ? 'font-semibold text-accent' : inMonth ? 'text-ink-muted' : 'text-ink-faint')}>
                {day.getDate()}
              </div>
              <div className="space-y-1">
                {shown.map((p, i) => {
                  const id = String(p.id || '');
                  const approvable = isAwaitingApproval(p.status) && p.videoPending !== true;
                  const dim = matchIds && !matchIds.has(id);
                  const tone = p.videoPending ? 'bg-rose-50 ring-rose-200' : approvable ? 'bg-blue-50 ring-blue-100' : 'bg-emerald-50 ring-emerald-100';
                  return (
                    <div key={id || i} className={'min-w-0 rounded-lg px-1.5 py-1 text-[10.5px] ring-1 ' + tone + (dim ? ' opacity-30' : '')}>
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-semibold tabular-nums text-accent">{timeOf(p)}</span>
                        {approvable && id && (
                          <button
                            type="button"
                            disabled={approvingId === id}
                            onClick={(e) => { e.stopPropagation(); onApprove(p); }}
                            className="rounded-full bg-accent px-1.5 text-[9.5px] font-semibold leading-[16px] text-white disabled:opacity-50"
                          >
                            {approvingId === id ? '…' : 'Approve'}
                          </button>
                        )}
                        {p.videoPending && <span className="text-[9.5px] font-medium text-rose-700">Video</span>}
                      </div>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onSelectDay(k); if (id) onPreview(id); }}
                        title="Preview this post"
                        className="block w-full truncate text-left text-ink hover:underline"
                      >
                        {p.text || 'Scheduled post'}
                      </button>
                      <div className="truncate text-[9.5px] text-ink-faint">{(p.providers || []).join(', ')}</div>
                    </div>
                  );
                })}
                {posts.length > shown.length && (
                  <div className="px-1 text-[10px] font-medium text-accent">+{posts.length - shown.length} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
