'use client';
// The dashboard's "Prepare checked boxes" button and panel.
//
// The sheet's boxes say WHERE a video goes; this is where a person says WHEN.
// Tick the network boxes on a row in the sheet: the sheet's edit trigger tells
// the dashboard, which holds the row (a `ticked` line in the register) rather
// than sending it. Press the button here, and the panel lists those rows
// first — "Just ticked in the sheet", pre-selected — with the month and the
// clinic's slot times. Send posts each chosen row to POST /api/videos/row with
// the day and time picked (`publishAt`, on the clinic's clock), the same door
// the sweep's posts go through, so they are the same posts at the time chosen.
//
// A row whose every ticked network already has its post can still be chosen:
// Send then MOVES those posts to the time picked (POST /api/posts reschedule),
// which is what ticking a finished row and picking a time means.
//
// Rows go one at a time: the dashboard gives the first the time as picked and
// moves the next to the following free slot, so two rows sent together land
// two slots apart. A network the row already has is never sent twice.
import { useState } from 'react';
import { announce } from '@/components/refreshBus';
import { friendlyErrorFromResponse } from '@/lib/friendly-error';
import { scheduleInstantFromInput } from '@/lib/schedule-clock';

type Post = { id: string; network: string; at: string; status: string };
type Row = { tab: string; row: number; title: string; ticked: string[]; owed: string[]; state: 'ready' | 'nothing_new'; have: Post[]; pending: boolean; tickedAt: string | null };
type Listing = { rows: Row[]; notPrepared: number; slotTimes: string[]; timezone: string; today: string; now: string };
type Result = { key: string; ok: boolean; text: string };

const LABEL: Record<string, string> = { youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok', twitter: 'X', x: 'X', facebook: 'Facebook', instagram: 'Instagram' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const btn: React.CSSProperties = { background: '#0071e3', color: '#fff', border: 'none', borderRadius: 999, padding: '7px 13px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const ghost: React.CSSProperties = { ...btn, background: 'transparent', color: '#0071e3', border: '1px solid rgba(0,113,227,0.35)' };
const panel: React.CSSProperties = { marginTop: 12, padding: 16, borderRadius: 12, border: '1px solid rgba(0,113,227,0.25)', background: '#f7faff' };
const box: React.CSSProperties = { background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 10, padding: 10 };

const pad = (n: number) => (n < 10 ? '0' : '') + n;
const dayKey = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const label = (n: string) => LABEL[n] || n;
const keyOf = (r: { tab: string; row: number }) => r.tab + ':' + r.row;
const fmt = (iso: string, tz: string) => {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? at.toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
};

/** The posts of a finished row that can still be moved: a published one cannot. */
export function movablePosts(r: Pick<Row, 'have'>): Post[] {
  return (r.have || []).filter((p) => p.id && p.status !== 'published' && p.status !== 'failed');
}

/** The server's answer for one row, as a sentence. */
export function describeRowAnswer(row: number, j: Record<string, unknown>, tz: string): { ok: boolean; text: string } {
  if (!j.ok) return { ok: false, text: 'Row ' + row + ': ' + String(j.message || j.error || 'failed') };
  const sent = Array.isArray(j.sent) ? (j.sent as string[]) : [];
  const refused = Array.isArray(j.refused) ? (j.refused as { network: string; message?: string; reason?: string }[]) : [];
  if (j.action === 'added') {
    const when = typeof j.scheduledFor === 'string' ? ' for ' + fmt(j.scheduledFor, tz) + (j.moved ? ' (that slot was taken; moved to the next free one)' : '') : '';
    return {
      ok: sent.length > 0,
      text: 'Row ' + row + ': ' + (sent.length ? 'sent to Metricool' + when + ' — ' + sent.map(label).join(', ') : 'nothing sent')
        + (refused.length ? ' — not ' + refused.map((x) => label(x.network) + ' (' + (x.message || x.reason || 'refused') + ')').join(', ') : ''),
    };
  }
  if (j.action === 'nothing_new') return { ok: true, text: 'Row ' + row + ': every ticked network already has its post' };
  if (j.action === 'not_prepared') return { ok: false, text: 'Row ' + row + ': not prepared yet — Prepare it first, then send' };
  if (j.action === 'bad_time') return { ok: false, text: 'Row ' + row + ': ' + String(j.message || 'that time cannot be used') };
  return { ok: false, text: 'Row ' + row + ': ' + String(j.action || 'no answer').replace(/_/g, ' ') };
}

export default function TickScheduler({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [showRest, setShowRest] = useState(false);
  const [find, setFind] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [time, setTime] = useState<string>('');
  const [view, setView] = useState<{ y: number; m: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Result[]>([]);

  async function load() {
    setLoading(true); setErr(null); setResults([]);
    try {
      const r = await fetch('/api/videos/ticks');
      if (!r.ok) throw new Error(await friendlyErrorFromResponse(r));
      const j = (await r.json()) as Listing & { ok: boolean };
      setListing(j);
      // What the person just ticked in the sheet is pre-selected; nothing else.
      // The rest of the list is the sheet's ticked history, and the first time
      // this opened it offered seven old rows nobody had in mind.
      setChosen(new Set(j.rows.filter((x) => x.pending && (x.state === 'ready' || movablePosts(x).length > 0)).map(keyOf)));
      const [y, m] = j.today.split('-').map(Number);
      setView((v) => v || { y, m: m - 1 });
      if (!time && j.slotTimes[0]) setTime(j.slotTimes[0]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The ticked rows could not be read.');
    } finally {
      setLoading(false);
    }
  }

  const rows = listing ? listing.rows : [];
  const q = find.trim().toLowerCase();
  const matches = (r: Row) => !q || String(r.row) === q || r.title.toLowerCase().includes(q) || r.tab.toLowerCase().includes(q);
  const justTicked = rows.filter((r) => r.pending);
  const rest = rows.filter((r) => !r.pending);
  const selectable = (r: Row) => r.state === 'ready' || movablePosts(r).length > 0;
  const picked = rows.filter((r) => chosen.has(keyOf(r)) && selectable(r));
  const toSend = picked.filter((r) => r.state === 'ready');
  const toMove = picked.filter((r) => r.state !== 'ready');
  const inPast = Boolean(listing && day === listing.today && time && time <= listing.now);
  const canSend = picked.length > 0 && Boolean(day) && /^\d{2}:\d{2}$/.test(time) && !inPast && !sending;

  async function send() {
    if (!listing || !day) return;
    setSending(true); setResults([]);
    const publishAt = day + 'T' + time;
    const out: Result[] = [];
    // New posts first, so the time picked is theirs; moved posts follow.
    for (const r of toSend) {
      try {
        const res = await fetch('/api/videos/row', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tab: r.tab, row: r.row, publishAt }) });
        const j = (await res.json().catch(() => ({ ok: false, error: 'HTTP ' + res.status }))) as Record<string, unknown>;
        out.push({ key: keyOf(r), ...describeRowAnswer(r.row, j, listing.timezone) });
      } catch (e) {
        out.push({ key: keyOf(r), ok: false, text: 'Row ' + r.row + ': ' + (e instanceof Error ? e.message : 'the dashboard did not answer') });
      }
      setResults([...out]);
    }
    const iso = scheduleInstantFromInput(publishAt);
    for (const r of toMove) {
      const posts = movablePosts(r);
      const moved: string[] = []; const failed: string[] = [];
      for (const p of posts) {
        try {
          const res = await fetch('/api/posts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: p.id, action: 'reschedule', publication_date: iso }) });
          if (res.ok) moved.push(label(p.network)); else failed.push(label(p.network) + ' (' + (await friendlyErrorFromResponse(res)) + ')');
        } catch (e) {
          failed.push(label(p.network) + ' (' + (e instanceof Error ? e.message : 'no answer') + ')');
        }
      }
      out.push({
        key: keyOf(r), ok: moved.length > 0 && !failed.length,
        text: 'Row ' + r.row + ': ' + (moved.length ? 'moved ' + moved.join(', ') + ' to ' + fmt(iso || '', listing.timezone) : 'nothing moved') + (failed.length ? ' — not ' + failed.join(', ') : ''),
      });
      setResults([...out]);
    }
    setSending(false);
    announce('posts', 'drafts');
    void load();
  }

  function shift(n: number) {
    if (!view) return;
    let m = view.m + n; let y = view.y;
    if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
    setView({ y, m });
  }

  function rowLine(r: Row) {
    const k = keyOf(r);
    const on = chosen.has(k);
    const can = selectable(r);
    return (
      <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0', fontSize: 13, opacity: can ? 1 : .55 }}>
        <input type="checkbox" disabled={!can || sending} checked={on} onChange={(e) => { const next = new Set(chosen); if (e.target.checked) next.add(k); else next.delete(k); setChosen(next); }} />
        <strong style={{ whiteSpace: 'nowrap' }}>{r.tab} · row {r.row}</strong>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
        <span style={{ color: '#1d4ed8', whiteSpace: 'nowrap' }} title={r.state === 'ready' ? 'Still to send' : 'Already in Metricool; choosing a time moves them'}>
          {r.state === 'ready'
            ? r.owed.map(label).join(', ')
            : (on ? 'will move ' : 'already has ') + r.ticked.map((n) => { const p = r.have.find((h) => h.network === (n === 'x' ? 'twitter' : n) && h.at); return label(n) + (p ? ' (' + fmt(p.at, listing!.timezone) + ')' : ''); }).join(', ')}
        </span>
      </label>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" style={open ? ghost : btn} disabled={disabled} onClick={() => { const next = !open; setOpen(next); if (next) { if (!listing && !loading) void load(); } else setResults([]); }} title="Send the rows whose boxes are ticked in the sheet to Metricool, at a day and time you pick">
          {open ? 'Close' : 'Prepare checked boxes'}
        </button>
        {!open && <span style={{ fontSize: 12, opacity: .65 }}>Tick FACEBOOK, INSTAGRAM, YOUTUBE, LINKEDIN, TIKTOK or X on a row in the sheet, then press this to pick when they go out.</span>}
      </div>

      {open && (
        <div style={panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>Prepare checked boxes</h3>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a row: 224, or a title" aria-label="Find a ticked row by number or title" style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)', fontSize: 12, minWidth: 200 }} />
              <button type="button" style={ghost} disabled={loading || sending} onClick={() => void load()}>{loading ? 'Reading the sheet…' : 'Re-read the sheet'}</button>
            </div>
          </div>
          {err && <p style={{ color: '#d70015', fontSize: 13 }}>{err}</p>}
          {loading && !listing && <p style={{ fontSize: 13, opacity: .7 }}>Reading the sheet’s ticks and what each row already has…</p>}

          {listing && (
            <>
              <div style={{ margin: '10px 0 4px', fontSize: 12, fontWeight: 600 }}>Just ticked in the sheet</div>
              {justTicked.filter(matches).length
                ? <div style={{ ...box, maxHeight: 180, overflow: 'auto' }}>{justTicked.filter(matches).map(rowLine)}</div>
                : <p style={{ fontSize: 12, opacity: .7, margin: '2px 0 8px' }}>{q ? 'No just-ticked row matches.' : 'Nothing yet. Tick a network box on a row in the sheet and it appears here within a few seconds; press Re-read the sheet if it does not.'}</p>}

              {rest.length > 0 && (
                <div style={{ margin: '10px 0 4px', fontSize: 12 }}>
                  <button type="button" style={{ ...ghost, padding: '3px 10px' }} onClick={() => setShowRest(!showRest)}>
                    {showRest ? 'Hide' : 'Show'} {rest.length} other ticked {rest.length === 1 ? 'row' : 'rows'} in the sheet
                  </button>
                  <span style={{ opacity: .65, marginLeft: 8 }}>ticked earlier, {rest.filter((r) => r.state === 'ready').length} still owed a post{listing.notPrepared > 0 ? '; ' + listing.notPrepared + ' more ticked rows are not in the pipeline and are not listed' : ''}</span>
                </div>
              )}
              {(showRest || q) && rest.filter(matches).length > 0 && (
                <div style={{ ...box, maxHeight: 200, overflow: 'auto' }}>{rest.filter(matches).map(rowLine)}</div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) minmax(220px, 1fr)', gap: 12, marginTop: 12 }}>
                <div style={box}>
                  {view && (
                    <>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                        <button type="button" style={ghost} onClick={() => shift(-1)} aria-label="Previous month">‹</button>
                        <strong style={{ fontSize: 13 }}>{MONTHS[view.m]} {view.y}</strong>
                        <button type="button" style={ghost} onClick={() => shift(1)} aria-label="Next month">›</button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
                        {DOW.map((d) => <span key={d} style={{ textAlign: 'center', fontSize: 11, opacity: .6 }}>{d}</span>)}
                        {Array.from({ length: new Date(view.y, view.m, 1).getDay() }).map((_, i) => <i key={'b' + i} />)}
                        {Array.from({ length: new Date(view.y, view.m + 1, 0).getDate() }).map((_, i) => {
                          const k = dayKey(view.y, view.m, i + 1);
                          const past = k < listing.today;
                          const on = k === day;
                          return (
                            <button key={k} type="button" disabled={past || sending} onClick={() => setDay(k)}
                              style={{ border: 0, borderRadius: 6, height: 30, cursor: past ? 'default' : 'pointer', fontSize: 12, background: on ? '#0071e3' : 'transparent', color: on ? '#fff' : past ? '#bdc1c6' : '#1d1d1f', fontWeight: k === listing.today ? 700 : 400 }}>
                              {i + 1}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
                <div style={box}>
                  <div style={{ fontSize: 13 }}><strong>Time</strong> <span style={{ opacity: .6 }}>({listing.timezone})</span></div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0 10px' }}>
                    {listing.slotTimes.map((t) => <button key={t} type="button" disabled={sending} onClick={() => setTime(t)} style={time === t ? btn : ghost}>{t}</button>)}
                  </div>
                  <label style={{ fontSize: 12, opacity: .8, display: 'flex', gap: 8, alignItems: 'center' }}>
                    Or any time
                    <input type="time" step={300} value={time} disabled={sending} onChange={(e) => setTime(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(0,0,0,0.12)', fontSize: 13 }} />
                  </label>
                </div>
              </div>

              <p style={{ fontSize: 13, margin: '12px 0 8px' }}>
                {!picked.length ? 'Tick the rows to send.'
                  : !day ? 'Pick a day.'
                  : !/^\d{2}:\d{2}$/.test(time) ? 'Pick a time.'
                  : inPast ? 'That time has already gone today. Pick a later one.'
                  : <>
                      {toSend.length > 0 && <>{toSend.length === 1 ? 'Row ' + toSend[0].row + ' goes' : toSend.length + ' rows go'} to Metricool <strong>{new Date(day + 'T12:00:00').toDateString()} at {time}</strong>{toSend.length > 1 ? ', the first at that time and each next at the following free slot' : ''}. </>}
                      {toMove.length > 0 && <>{toMove.length === 1 ? 'Row ' + toMove[0].row + '’s ' + movablePosts(toMove[0]).length + ' existing posts move' : toMove.length + ' rows’ existing posts move'} to <strong>{new Date(day + 'T12:00:00').toDateString()} at {time}</strong>.</>}
                    </>}
              </p>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button type="button" style={{ ...btn, opacity: canSend ? 1 : .5 }} disabled={!canSend} onClick={() => void send()}>
                  {sending ? 'Sending…' : (toSend.length && toMove.length ? 'Send and move' : toMove.length ? 'Move' : 'Send') + ' ' + picked.length + (picked.length === 1 ? ' row' : ' rows')}
                </button>
                {sending && <span style={{ fontSize: 12, opacity: .7 }}>A row whose video still has to be copied into Metricool can take a minute.</span>}
              </div>
              {results.length > 0 && (
                <div style={{ marginTop: 10, display: 'grid', gap: 4 }}>
                  {results.map((r) => <div key={r.key} style={{ padding: '6px 8px', borderRadius: 6, fontSize: 13, background: r.ok ? '#e6f4ea' : '#fce8e6' }}>{r.text}</div>)}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
