'use client';

// components/SchedulePack.tsx
// "Schedule this pack" — under the Content Generator's output, where the post
// actually is.
//
// The generator wrote three posts and made a hero image, and the image said
// "attaches when you schedule" while nothing on the screen scheduled anything.
// The only route to Metricool was to copy one variant into the composer, which
// sends the same words to every network — so the Instagram caption went out on
// LinkedIn, or three trips were made by hand.
//
// This sends each network ITS OWN variant, with the image attached, at a slot
// off the weekly planner, in one press. Every row is checked before anything
// is sent (lib/pack-schedule.ts): the right length for that network, the
// advertising notice and the citation where the rule applies, and a picture
// where the network refuses to post without one.
import { useEffect, useMemo, useState } from 'react';

import { MediaPreview } from '@/components/MediaPicker';
import { friendlyError } from '@/lib/friendly-error';
import { METRICOOL_BLOG_ID, metricoolPlannerUrl } from '@/lib/metricool-links';
import { planFromPack, scheduleReady } from '@/lib/pack-schedule';
import { nextDayAt, themeLabel, weekFromThemes, type PlannerTheme } from '@/lib/planner-slot';
import { fmtScheduleDateTime, scheduleInputValue, scheduleInstantFromInput, scheduleTzLabel } from '@/lib/schedule-clock';

const LABEL: Record<string, string> = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn' };
const EMOJI: Record<string, string> = { instagram: '📸', facebook: '📘', linkedin: '💼' };

export default function SchedulePack({
  pack,
  draftId,
  imageUrl,
  avisoNumber,
  slots,
  blogId,
}: {
  pack: Record<string, unknown> | null;
  draftId: string | null;
  imageUrl: string | null;
  avisoNumber?: string | null;
  /** The next free planner slots, from /api/schedule/next-slots. */
  slots: string[];
  blogId?: string;
}) {
  const plans = useMemo(
    () => planFromPack(pack, { mediaUrl: imageUrl, avisoNumber }),
    [pack, imageUrl, avisoNumber],
  );
  // Everything the writer produced and the network will take, ticked — the
  // ordinary case is "all of it", and a row that is not ready says why rather
  // than being hidden.
  const [chosen, setChosen] = useState<string[]>(() => plans.filter((p) => p.ready).map((p) => p.network));
  const [when, setWhen] = useState<string>(() => (slots[0] ? scheduleInputValue(slots[0]) : ''));
  // THE WEEKLY PLANNER, HERE.
  //
  // It has held a theme per day since it was built, and the only thing that
  // could use it was the Autopilot — which writes its OWN post for the slot. A
  // post already written, the one on this screen, could not be put on a day at
  // all.
  const [themes, setThemes] = useState<PlannerTheme[]>([]);
  useEffect(() => {
    let alive = true;
    fetch('/api/templates')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive) return;
        const rows = Array.isArray(j?.templates) ? j.templates : [];
        setThemes(rows.map((t: Record<string, unknown>) => ({
          id: String(t.id || ''),
          name: String(t.name || 'Theme'),
          days: Array.isArray(t.weekdays) ? (t.weekdays as unknown[]).map((d) => Number(d)).filter((d) => Number.isFinite(d)) : [],
          time: String(t.time_of_day || '09:00'),
          networks: Array.isArray(t.providers) ? (t.providers as unknown[]).map((x) => String(x)) : [],
        })));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const week = useMemo(() => weekFromThemes(themes), [themes]);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (!plans.length) return null;

  const gate = scheduleReady(plans, chosen, when);

  const toggle = (network: string) =>
    setChosen((prev) => (prev.includes(network) ? prev.filter((n) => n !== network) : [...prev, network]));

  async function scheduleAll() {
    if (!gate.ok || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const publishAt = scheduleInstantFromInput(when) || when;
      const picked = plans.filter((p) => chosen.includes(p.network));
      // One request per network, each carrying that network's OWN text. The
      // route is the same one the video path uses, so a post from here lands in
      // the queue exactly like a post from anywhere else.
      const results = await Promise.all(
        picked.map(async (p) => {
          const r = await fetch('/api/metricool/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              network: p.network,
              text: p.text,
              publishAt,
              blogId: blogId || METRICOOL_BLOG_ID,
              ...(imageUrl ? { mediaUrl: imageUrl } : {}),
              ...(draftId ? { draftId } : {}),
            }),
          });
          const data = await r.json().catch(() => ({}));
          return { network: p.network, ok: r.ok, data };
        }),
      );
      const good = results.filter((x) => x.ok).map((x) => LABEL[x.network] || x.network);
      const bad = results.filter((x) => !x.ok);
      if (good.length) setSent(true);
      setStatus(
        [
          good.length ? '✓ Scheduled on ' + good.join(', ') + '. They go out at the time above on their own.' : '',
          ...bad.map((x) => (LABEL[x.network] || x.network) + ': ' + friendlyError(x.data, 'it was not created.')),
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (e) {
      setStatus(friendlyError(e, 'They could not be scheduled just now.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-4 rounded-2xl border border-line bg-white p-4" aria-label="Schedule this pack">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-ink">Schedule this — each channel gets its own version</h3>
        <a href={metricoolPlannerUrl()} target="_blank" rel="noopener noreferrer" className="text-[11px] font-medium text-accent hover:underline">
          Open in Metricool ↗
        </a>
      </div>

      {/* The image the generator already made. It said "attaches when you
          schedule" for weeks with nothing on the screen that scheduled it. */}
      {imageUrl ? (
        <div className="mt-3">
          <div className="text-[12px] font-medium text-emerald-700">✅ The hero image goes with every channel below</div>
          <div className="mt-1.5 max-w-sm"><MediaPreview url={imageUrl} label="Hero image" /></div>
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-amber-700">No image was made for this one, so Instagram cannot be scheduled from here.</p>
      )}

      <div className="mt-4 grid gap-2">
        {plans.map((p) => {
          const on = chosen.includes(p.network);
          return (
            <div key={p.network} className={'rounded-xl p-3 ring-1 ' + (p.ready ? 'bg-subtle ring-line' : 'bg-amber-50 ring-amber-200')}>
              <label className="flex cursor-pointer items-center gap-2">
                <input type="checkbox" checked={on} disabled={!p.ready} onChange={() => toggle(p.network)} aria-label={LABEL[p.network]} />
                <span className="text-[13px] font-semibold text-ink">{EMOJI[p.network]} {LABEL[p.network] || p.network}</span>
                <span className="text-[11px] text-ink-muted">
                  {p.length.toLocaleString()}{Number.isFinite(p.limit) ? ' / ' + p.limit.toLocaleString() : ''} characters
                </span>
                {p.compliance === 'ok' && <span className="text-[11px] font-medium text-emerald-700">✓ notice + citation</span>}
              </label>
              {/* The words that will actually be sent to THIS network, visible
                  before they go — not a summary of them. */}
              <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white p-2 text-[11px] leading-relaxed text-ink-muted ring-1 ring-line">
                {p.text}
              </pre>
              {!p.ready && <p className="mt-1.5 text-[12px] font-medium text-amber-800">{p.problem}</p>}
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <label htmlFor="pack-when" className="text-[12px] font-medium text-ink-muted">When should they go out?</label>
        <span className="text-[11px] text-ink-faint">All times {scheduleTzLabel()} time</span>
      </div>
      {/* THE PLANNER ITSELF: a day, with its theme and its time. Picking one
          sets the next time that day comes round — and today only counts while
          its slot is still ahead, or a post would be scheduled into a morning
          that has already gone and refused at the door. */}
      <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
        {week.map((d) => {
          const time = d.themes[0]?.time || '09:00';
          const value = nextDayAt(d.day, time);
          const on = when === value;
          return (
            <button
              key={d.day}
              type="button"
              onClick={() => setWhen(value)}
              title={themeLabel(d.themes)}
              className={'rounded-xl p-2 text-left ring-1 transition hover:ring-accent ' +
                (on ? 'bg-accent/10 ring-accent' : 'bg-subtle ring-line')}
            >
              <span className="block text-[12px] font-semibold text-ink">{d.name}</span>
              <span className="block truncate text-[10px] text-ink-muted">{themeLabel(d.themes)}</span>
            </button>
          );
        })}
      </div>
      {/* And the next free slots the composer already offered. */}
      <div className="mt-2 flex flex-wrap gap-2">
        {slots.map((slot) => (
          <button
            key={slot}
            type="button"
            onClick={() => setWhen(scheduleInputValue(slot))}
            className={'rounded-full px-3 py-1 text-[12px] font-medium ring-1 transition hover:ring-accent ' +
              (when === scheduleInputValue(slot) ? 'bg-accent/10 text-accent ring-accent' : 'bg-subtle text-ink-muted ring-line')}
          >{fmtScheduleDateTime(slot)}</button>
        ))}
      </div>
      <input
        id="pack-when"
        type="datetime-local"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        className="mt-2 w-full rounded-xl bg-subtle px-3 py-2 text-[14px] text-ink ring-1 ring-line focus:ring-accent"
      />

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void scheduleAll()}
          disabled={!gate.ok || busy}
          title={gate.ok ? undefined : gate.reason}
          className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-semibold text-white shadow-soft transition-all hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        >{busy ? 'Scheduling…' : sent ? 'Scheduled ✓' : 'Schedule ' + chosen.length + ' post' + (chosen.length === 1 ? '' : 's')}</button>
        {!gate.ok && <span className="text-[12px] font-medium text-amber-800">{gate.reason}</span>}
      </div>
      {status && (
        <p className={'mt-2 text-[12px] ' + (sent ? 'text-emerald-700' : 'text-danger')} role="status">{status}</p>
      )}
      <p className="mt-2 text-[11px] text-ink-faint">
        Each channel is sent its own version of the post with the image attached, at the time above. They appear in your queue
        and on the Metricool calendar in colour, and go out on their own — delete or reschedule them there if you change your mind.
      </p>
    </section>
  );
}
