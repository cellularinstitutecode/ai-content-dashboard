'use client';

// The weekly planner: one column per weekday, a theme per slot, and every
// occurrence written fresh.
//
// This is a front end on the existing Autopilot templates — a slot here IS a
// schedule_templates row with strategy { mode: 'fixed_topic', topic, format }.
// "Fixed topic" is the mode where the engine keeps the subject and changes
// the angle each week (lib/autopilot.ts: decideAngle looks at what was
// written recently and picks a different query, question or keyword), so a
// Monday theme never reads as last Monday's post. Several slots on one day are
// fine — a social post at 9 and a blog at 14, say.

import { useMemo, useState } from 'react';
import { nextOccurrence, plannedMix, slotLabel, type NextOccurrence } from '@/lib/strategy-mix';

export type PlannerTemplate = {
  id?: string;
  name?: string;
  providers?: string[];
  weekdays?: number[];
  time_of_day?: string;
  active?: boolean;
  strategy?: { mode?: string; topic?: string; format?: string; goal?: string; pillars?: string[]; rule?: string; seeded?: string; slot?: string; pillarId?: string };
};

/** A slot "Load the weekly strategy" wrote. Its format and angle bank are the document's. */
function isSeededSlot(t: PlannerTemplate | undefined): boolean {
  return String(t?.strategy?.seeded || '') === 'weekly-strategy';
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_INDEX = [1, 2, 3, 4, 5, 6, 0]; // schedule_templates.weekdays uses 0=Sun
const NETWORKS: { id: string; label: string }[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'blog', label: 'Blog' },
];
const FORMATS: { id: string; label: string }[] = [
  { id: 'social', label: 'Social post' },
  { id: 'blog', label: 'Blog article' },
  { id: 'video', label: 'Video script' },
  { id: 'email', label: 'Email' },
];

type Draft = { day: number; topic: string; format: string; time: string; providers: string[]; goal: string; id?: string;
  /**
   * A slot that rotates a bank of angles rather than repeating one theme —
   * what "Load the weekly strategy" creates. This form has no field for an
   * angle bank, so for these it edits the day, time, format, goal and channels
   * and leaves the rotation exactly as it found it.
   */
  rotating?: { name: string; angles: number } & { list?: string[] };
  /** From the weekly strategy: format and goal are the document's, not this form's. */
  seeded?: boolean };

const inputStyle: React.CSSProperties = { width: '100%', padding: 8, borderRadius: 6, background: '#f5f5f7', border: '1px solid rgba(0,0,0,0.1)', color: '#1d1d1f', marginTop: 4, boxSizing: 'border-box', fontSize: 13 };
const btn: React.CSSProperties = { background: '#0071e3', color: '#fff', border: 'none', borderRadius: 999, padding: '7px 13px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const ghost: React.CSSProperties = { ...btn, background: 'transparent', color: '#0071e3', border: '1px solid rgba(0,113,227,0.35)' };

export default function WeeklyPlanner({
  templates,
  onSave,
  onDelete,
  onToggle,
  onLoadStrategy,
  loadingStrategy = false,
}: {
  templates: PlannerTemplate[];
  onSave: (t: PlannerTemplate) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onToggle: (t: PlannerTemplate, active: boolean) => Promise<void>;
  /** Fill the week from the clinic's written strategy. Optional, so this component still stands alone. */
  onLoadStrategy?: () => Promise<void> | void;
  loadingStrategy?: boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Slots per weekday: every template that posts on that day, soonest first.
  const byDay = useMemo(() => {
    const map = new Map<number, PlannerTemplate[]>();
    for (const d of DAY_INDEX) map.set(d, []);
    for (const t of templates) {
      for (const w of t.weekdays || []) map.get(w)?.push(t);
    }
    for (const list of map.values()) list.sort((a, b) => String(a.time_of_day || '').localeCompare(String(b.time_of_day || '')));
    return map;
  }, [templates]);

  // Phase 4: is the week still the strategy, and what is each slot about to
  // write? Only once the strategy is loaded — a hand-built planner has no
  // frequency table to be measured against.
  const hasStrategy = templates.some((t) => Boolean(t.strategy?.slot));
  const mix = useMemo(() => (hasStrategy ? plannedMix(templates) : null), [templates, hasStrategy]);
  const nexts = useMemo(() => {
    const out = new Map<string, NextOccurrence>();
    for (const t of templates) if (t.id && t.strategy?.slot) out.set(t.id, nextOccurrence(t));
    return out;
  }, [templates]);

  function startNew(day: number) {
    setError(null);
    setDraft({ day, topic: '', format: 'social', time: '09:00', providers: ['instagram', 'facebook'], goal: 'rank' });
  }
  function startEdit(day: number, t: PlannerTemplate) {
    setError(null);
    // A seeded slot is rotating whatever its mode says: the assistant can set
    // one to fixed_topic, and treating it as a themed slot here then wrote a
    // strategy without the seed's mark or rule.
    const seeded = isSeededSlot(t);
    const angles = t.strategy?.mode === 'pillars' || seeded ? (t.strategy?.pillars || []).length : 0;
    setDraft({
      day,
      id: t.id,
      topic: t.strategy?.topic || '',
      format: t.strategy?.format || 'social',
      time: t.time_of_day || '09:00',
      providers: t.providers || [],
      goal: t.strategy?.goal || 'rank',
      rotating: angles ? { name: t.name || 'This slot', angles, list: (t.strategy?.pillars || []).slice() } : undefined,
      seeded,
    });
  }

  async function commit() {
    if (!draft) return;
    // A rotating slot has an angle bank instead of a theme, and this form has
    // no field for one — so asking for a theme would be asking for something
    // it does not have, and saving one would replace the rotation with it.
    if (!draft.rotating && !draft.topic.trim()) { setError('Give this slot a theme — what should every ' + DAYS[DAY_INDEX.indexOf(draft.day)] + ' post be about?'); return; }
    if (!draft.providers.length) { setError('Pick at least one channel.'); return; }
    setBusy(true); setError(null);
    try {
      const existing = draft.id ? templates.find((t) => t.id === draft.id) : undefined;
      // A slot edited here keeps the other weekdays it may already have.
      const weekdays = Array.from(new Set([...(existing?.weekdays || []).filter((w) => w !== draft.day), draft.day])).sort();
      // THE ONE THAT USED TO GO WRONG. This form writes `mode: 'fixed_topic'`
      // and a name built from the theme box. Run that over a slot loaded from
      // the weekly strategy and a six-week pillar rotation silently became one
      // fixed topic — with an empty topic, because the box was empty, because
      // the slot never had one. A rotating slot therefore keeps its name, its
      // mode and its bank, and this form changes only what it actually shows.
      const rotating = Boolean(draft.rotating);
      await onSave({
        id: draft.id,
        name: rotating
          ? (existing?.name || draft.rotating?.name || 'Untitled slot')
          : DAYS[DAY_INDEX.indexOf(draft.day)] + ' · ' + draft.topic.trim().slice(0, 60),
        providers: draft.providers,
        weekdays: existing && existing.weekdays && existing.weekdays.length > 1 ? weekdays : [draft.day],
        time_of_day: draft.time,
        active: existing?.active ?? true,
        strategy: rotating
          ? {
              ...(existing?.strategy || {}),
              mode: 'pillars',
              pillars: existing?.strategy?.pillars || [],
              rule: existing?.strategy?.rule,
              // A seeded slot's format is the document's (a Monday article stays
              // an article): a social slot switched to "video" or "email" here
              // shipped a teaser for a video or newsletter that did not exist.
              format: draft.seeded ? (existing?.strategy?.format || 'social') : draft.format,
              goal: draft.goal,
            }
          // Spread, like the branch above: whatever else the strategy carries —
          // a seed's mark, slot key and rule among them — is not this form's
          // to drop.
          : { ...(existing?.strategy || {}), mode: 'fixed_topic', topic: draft.topic.trim(), format: draft.format, goal: draft.goal, pillars: existing?.strategy?.pillars || [] },
      });
      setDraft(null);
    } catch (e: any) {
      setError(e?.message || 'Could not save this slot.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 17 }}>Weekly planner</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, opacity: .65 }}>
            A theme for each day of the week. Every occurrence is researched and written fresh. Weekly-strategy slots also rotate their angle, caption shape and reader each time, so a Monday post does not read like last Monday&apos;s. Add as many slots to a day as you like.
          </p>
        </div>
        {onLoadStrategy && (
          <div style={{ textAlign: 'right' }}>
            <button type="button" style={btn} disabled={loadingStrategy} onClick={() => void onLoadStrategy()}>
              {loadingStrategy ? 'Loading…' : 'Load the weekly strategy'}
            </button>
            <div style={{ fontSize: 11, opacity: .6, marginTop: 5, maxWidth: 230 }}>
              Fills the week from the clinic&apos;s written strategy: 15 slots — two posts a day, plus Monday&apos;s article, promoted on Facebook and LinkedIn with its link (15 posts a week there; Instagram stays at 14). Nothing is published by this; every one waits for your approval.
            </div>
          </div>
        )}
      </div>

      {mix && <MixPanel mix={mix} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(150px, 1fr))', gap: 10, marginTop: 18, overflowX: 'auto' }}>
        {DAYS.map((label, i) => {
          const day = DAY_INDEX[i];
          const slots = byDay.get(day) || [];
          return (
            <div key={day} style={{ background: '#f5f5f7', borderRadius: 10, padding: 10, minHeight: 180, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, opacity: .75 }}>{label}</div>
              {slots.length === 0 && <div style={{ fontSize: 11, opacity: .45 }}>No theme yet.</div>}
              {slots.map((t) => {
                const auto = t.strategy?.mode && t.strategy.mode !== 'off';
                return (
                  <div key={t.id} style={{ background: '#fff', borderRadius: 8, padding: 8, border: '1px solid rgba(0,0,0,0.08)', opacity: t.active === false ? .55 : 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.3 }}>{t.strategy?.topic || t.name || 'Untitled'}</div>
                    <div style={{ fontSize: 10, opacity: .6, marginTop: 3 }}>
                      {t.time_of_day || '—'} · {FORMATS.find((f) => f.id === (t.strategy?.format || 'social'))?.label || 'Social post'}
                      {auto ? (t.strategy?.mode === 'pillars' && (t.strategy?.pillars || []).length
                        ? ' · ' + (t.strategy?.pillars || []).length + ' angles, one a week'
                        : ' · fresh angle weekly') : ' · fixed text'}
                    </div>
                    <div style={{ fontSize: 10, opacity: .6, marginTop: 2 }}>{(t.providers || []).join(', ') || 'no channels'}</div>
                    {t.id && t.active !== false && <NextLine next={nexts.get(t.id) ?? null} />}
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      <button type="button" style={{ ...ghost, padding: '3px 8px', fontSize: 11 }} onClick={() => startEdit(day, t)}>Edit</button>
                      <button type="button" style={{ ...ghost, padding: '3px 8px', fontSize: 11 }} onClick={() => void onToggle(t, t.active === false)}>{t.active === false ? 'Turn on' : 'Pause'}</button>
                      {t.id && <button type="button" style={{ ...ghost, padding: '3px 8px', fontSize: 11, color: '#d70015', borderColor: 'rgba(215,0,21,0.3)' }} onClick={() => { if (window.confirm('Remove this slot?')) void onDelete(String(t.id)); }}>Remove</button>}
                    </div>
                  </div>
                );
              })}
              <button type="button" style={{ ...ghost, marginTop: 'auto', padding: '6px 10px', fontSize: 12 }} onClick={() => startNew(day)}>+ Add theme</button>
            </div>
          );
        })}
      </div>

      {draft && (
        <div role="dialog" aria-label="Plan a weekly slot" style={{ marginTop: 18, background: '#f5f5f7', borderRadius: 10, padding: 16, border: '1px solid rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>{draft.id ? 'Edit' : 'New'} slot · every {DAYS[DAY_INDEX.indexOf(draft.day)]}</h3>
            <button type="button" style={ghost} onClick={() => setDraft(null)}>Cancel</button>
          </div>
          {draft.rotating ? (
            <div style={{ fontSize: 12, marginTop: 12, background: '#fff', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 8, padding: 10 }}>
              <div style={{ fontWeight: 600 }}>{draft.rotating.name}</div>
              <div style={{ opacity: .65, marginTop: 3 }}>
                From the weekly strategy: {draft.rotating.angles} angles, one a week, so this slot does not repeat itself for {draft.rotating.angles} weeks. The rotation is kept as it is — change the time or channels below. {draft.seeded ? 'Its post type is set by the strategy, and each week it gets a new caption shape and reader. ' : ''}To move it to another day, remove it and add it on that day.
              </div>
              {/* The angles themselves. Until now the panel said "5 angles" and
                  showed none, so nobody could check what a slot would write. */}
              {draft.rotating.list && draft.rotating.list.length > 0 && (
                <ol style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.5 }}>
                  {draft.rotating.list.map((a, i) => {
                    const n = draft.id ? nexts.get(draft.id) : null;
                    const isNext = Boolean(n && n.angle && n.angle === a);
                    return (
                      <li key={i} style={isNext ? { fontWeight: 600, color: '#0071e3' } : undefined}>
                        {a}{isNext ? ' — next' : ''}
                      </li>
                    );
                  })}
                </ol>
              )}
              <div style={{ opacity: .65, marginTop: 6 }}>
                {'Each post is written as education on that week\'s angle — no treatment pitch, no "free consultation" — and gets a bright consultation photo of the topic with its title set on top.'}
              </div>
            </div>
          ) : (
            <label style={{ display: 'block', fontSize: 12, marginTop: 12 }}>Theme — what every {DAYS[DAY_INDEX.indexOf(draft.day)]} post is about
              <input id="planner-topic" style={inputStyle} value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })} placeholder="e.g. Stem cell safety and what to ask your provider" />
            </label>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 10 }}>
            <label style={{ fontSize: 12 }}>Format
              <select style={inputStyle} value={draft.format} disabled={draft.seeded} title={draft.seeded ? 'Set by the weekly strategy' : undefined} onChange={(e) => setDraft({ ...draft, format: e.target.value })}>
                {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
            </label>
            <label style={{ fontSize: 12 }}>Time (clinic time)
              <input type="time" style={inputStyle} value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
            </label>
            <label style={{ fontSize: 12 }}>Goal
              {/* A seeded slot is written from the strategy's own brief, which
                  does not read the goal — so the control would change nothing. */}
              <select style={inputStyle} value={draft.goal} disabled={draft.seeded} title={draft.seeded ? 'Set by the weekly strategy' : undefined} onChange={(e) => setDraft({ ...draft, goal: e.target.value })}>
                <option value="rank">Rank for searches</option>
                <option value="traffic">Traffic</option>
                <option value="engagement">Engagement</option>
                <option value="authority">Authority</option>
              </select>
            </label>
          </div>
          <div style={{ fontSize: 12, marginTop: 10 }}>Channels</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {NETWORKS.map((n) => {
              const on = draft.providers.includes(n.id);
              return (
                <button key={n.id} type="button" aria-pressed={on} onClick={() => setDraft({ ...draft, providers: on ? draft.providers.filter((p) => p !== n.id) : [...draft.providers, n.id] })}
                  style={{ ...(on ? btn : ghost), padding: '5px 11px' }}>{n.label}</button>
              );
            })}
          </div>
          {error && <div role="alert" style={{ color: '#d70015', fontSize: 12, marginTop: 10 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center' }}>
            <button type="button" style={btn} disabled={busy} onClick={() => void commit()}>{busy ? 'Saving…' : 'Save slot'}</button>
            <span style={{ fontSize: 11, opacity: .6 }}>Autopilot drafts each occurrence ahead of time and waits for your approval. Nothing posts on its own.</span>
          </div>
        </div>
      )}
    </section>
  );
}

const GROUP_LABEL: Record<string, string> = {
  medical: 'Medical',
  lifestyle: 'Healthy lifestyle',
  recovery: 'Recovery',
  cancun: 'Cancún',
};

const STATUS_STYLE: Record<string, React.CSSProperties> = {
  ok: { color: '#248a3d' },
  under: { color: '#b25000', fontWeight: 600 },
  over: { color: '#b25000', fontWeight: 600 },
};

/** The frequency table, as the planner stands now. */
function MixPanel({ mix }: { mix: ReturnType<typeof plannedMix> }) {
  const off = mix.rows.filter((r) => r.status !== 'ok');
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 16, background: '#f5f5f7', borderRadius: 10, padding: 12, fontSize: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <span style={{ fontWeight: 700 }}>Strategy mix this week</span>
          <span style={{ marginLeft: 8, ...(off.length || mix.missing.length || mix.paused.length ? STATUS_STYLE.under : STATUS_STYLE.ok) }}>
            {off.length || mix.missing.length || mix.paused.length
              ? '⚠ ' + [
                  off.length ? off.length + (off.length === 1 ? ' pillar' : ' pillars') + ' off the document\'s frequency' : '',
                  mix.paused.length ? mix.paused.length + ' paused' : '',
                  mix.missing.length ? mix.missing.length + ' missing' : '',
                ].filter(Boolean).join(' · ')
              : '✓ Matches the document\'s frequency table'}
          </span>
        </div>
        <button type="button" style={{ ...ghost, padding: '3px 10px', fontSize: 11 }} onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide details' : 'Show details'}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8 }}>
        {Object.entries(mix.groups).map(([g, v]) => (
          <div key={g} title={'Recommended mix: ' + v.recommended + ' · the document\'s day map: ' + v.dayMap}>
            <span style={{ opacity: .65 }}>{GROUP_LABEL[g] || g}</span>{' '}
            <strong>{v.planned}</strong>
            <span style={{ opacity: .55 }}> / {v.recommended === v.dayMap ? v.recommended : v.recommended + '–' + v.dayMap}</span>
          </div>
        ))}
        <div><span style={{ opacity: .65 }}>Weekly article</span> <strong style={mix.article === 'on' ? STATUS_STYLE.ok : STATUS_STYLE.under}>{mix.article === 'on' ? 'on' : mix.article}</strong></div>
      </div>
      {open && (
        <div style={{ marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', opacity: .6 }}>
                <th style={{ padding: '4px 6px', fontWeight: 600 }}>Pillar</th>
                <th style={{ padding: '4px 6px', fontWeight: 600 }}>Document</th>
                <th style={{ padding: '4px 6px', fontWeight: 600 }}>Planned</th>
              </tr>
            </thead>
            <tbody>
              {mix.rows.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid rgba(0,0,0,0.06)' }}>
                  <td style={{ padding: '4px 6px' }}>{r.name}</td>
                  <td style={{ padding: '4px 6px', opacity: .7 }}>{r.frequency}</td>
                  <td style={{ padding: '4px 6px', ...STATUS_STYLE[r.status] }}>
                    {r.planned}{r.status === 'under' ? ' — below' : r.status === 'over' ? ' — above' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {(mix.paused.length > 0 || mix.missing.length > 0) && (
            <div style={{ marginTop: 8, opacity: .8 }}>
              {mix.paused.length > 0 && <div>Paused: {mix.paused.map(slotLabel).join(', ')}.</div>}
              {mix.missing.length > 0 && <div>Missing: {mix.missing.map(slotLabel).join(', ')}. &ldquo;Load the weekly strategy&rdquo; puts them back without touching the rest.</div>}
            </div>
          )}
          <div style={{ marginTop: 8, opacity: .55 }}>
            Group totals count each slot&apos;s main pillar. The document recommends 5 lifestyle posts but its day map schedules 7 (Saturday&apos;s two), so both numbers are shown.
          </div>
        </div>
      )}
    </div>
  );
}

const nextFmt = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Cancun', weekday: 'short', month: 'short', day: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
};

/** What a strategy slot writes next — the rotation's own deal. */
function NextLine({ next }: { next: NextOccurrence }) {
  if (!next) return null;
  if (next.angle === null) {
    const why = next.reason === 'edited'
      ? 'its angle list was edited, so it rotates its own list'
      : next.reason === 'before-start' ? 'the rotation has not started yet' : 'not a strategy slot';
    return <div style={{ fontSize: 10, opacity: .55, marginTop: 4 }}>Next {nextFmt(next.at)}: {why}.</div>;
  }
  return (
    <div style={{ fontSize: 10, marginTop: 4, lineHeight: 1.35 }} title={'Angle ' + next.position + ' of ' + next.of + ' in this slot\'s rotation. The engine may swap it in the first weeks if a recent post already covered it.'}>
      <span style={{ opacity: .55 }}>Next {nextFmt(next.at)}:</span>{' '}
      <span style={{ color: '#1d1d1f' }}>{next.angle}</span>
      {next.format && <span style={{ color: '#6e3fd1' }}> · {next.format} · for {next.audience}</span>}
    </div>
  );
}
