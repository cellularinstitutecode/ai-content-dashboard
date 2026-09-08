'use client';

// Sources — the three Google documents the team plans in, inside the dashboard.
//
//   Social Calendar (Meriz)   the month-by-month post calendar, editable in place
//   Video Library (Rodrigo)   the video inventory, with "Use in post"
//   Image Library             the Drive photo folder, with "Use as hero image"
//
// Each tab shows the live document (the embedded Google editor, so editors
// edit exactly as they do in Drive) next to what the dashboard reads out of
// it. Nothing is copied or cached beyond a minute; the sheet stays the source
// of truth. "Use in post" and "Use as hero image" hand the content to the
// Publishing composer on the dashboard through the shared workspace.

import { Fragment, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import PageNav from '@/components/PageNav';
import { useWorkspace } from '@/components/workspace';
import { friendlyError, friendlyErrorFromResponse } from '@/lib/friendly-error';
import VideoPrepare from '@/components/VideoPrepare';

export type Tab = 'calendar' | 'videos' | 'images';

type CalendarEntry = { tab: string; row: number; headerRow: number; columns: Record<string, string>; date: string | null; type: string; pillar: string; owner: string; cta: string; caption: string; fileName: string; graphicsLink: string; status: string; networks: string[] };
type VideoEntry = { tab: string; row: number; headerRow: number; columns: Record<string, string>; creator: string; month: string; type: string; title: string; copy: string; videoLink: string; youtubeLink?: string; format: string; networks: string[]; thumbnailTitle: string; coverLink: string; notes: string };
type DriveImage = { id: string; name: string; mimeType: string; modifiedTime: string; size: number | null; viewUrl: string; thumbUrl: string };
type Status = { configured: boolean; serviceAccount: string | null; ids: { calendar: string; videos: string; images: string } };

const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: 'calendar', label: 'Social Calendar', blurb: 'Meriz\'s month-by-month post calendar, live. Open it in Google Sheets to edit; the dashboard reads what is planned and writes every approval back.' },
  { id: 'videos', label: 'Video Library', blurb: 'Rodrigo\'s video sheet, live: every produced video with its copy, link and formats. Press "Use in post" to drop one into the Publishing composer.' },
  { id: 'images', label: 'Image Library', blurb: 'The team\'s shared Drive folder of photos and renders. Press "Use as hero image" to attach a real clinic photo to a post.' },
];

const card: React.CSSProperties = { background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: 20 };
const btn: React.CSSProperties = { background: '#0071e3', color: '#fff', border: 'none', borderRadius: 999, padding: '7px 13px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const ghost: React.CSSProperties = { ...btn, background: 'transparent', color: '#0071e3', border: '1px solid rgba(0,113,227,0.35)' };

function sheetEmbed(id: string): string {
  // /preview, not /edit. Google serves the full editor with X-Frame-Options:
  // DENY, so an /edit?widget=true frame renders as the browser's broken-page
  // box no matter what our own CSP allows — which is what the Sources panel
  // was showing. /preview is the form Google publishes for embedding, and it
  // loads for any document the viewer can open (all three of these are
  // link-shared). It is read-only, so editing goes through the button beside
  // it, which opens the real sheet in a tab.
  return 'https://docs.google.com/spreadsheets/d/' + id + '/preview';
}
/** Google's own editor. Whether it survives being framed is the browser's call. */
function sheetEditEmbed(id: string): string {
  return 'https://docs.google.com/spreadsheets/d/' + id + '/edit?widget=true&headers=false&rm=minimal';
}
function sheetOpen(id: string): string {
  return 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
}

// The live document, read-only, with editing one click away. Browsers that
// block third-party cookies show the sheet signed-out inside the frame, so the
// "Open in Google Sheets" button is always there.
function SheetFrame({ id, title, height }: { id: string; title: string; height: number }) {
  // /preview always renders but is read-only; Google's own editor may or may
  // not survive being framed here — it depends on the browser's third-party
  // cookie setting as much as on Google. Rather than guess for everyone, offer
  // the swap: if the editor loads for you, type in it; if it comes up blank,
  // switch back and use the fields beside it, which write to the same sheet.
  const [tryEditor, setTryEditor] = useState(false);
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(0,0,0,0.08)', fontSize: 12, flexWrap: 'wrap' }}>
        <span style={{ opacity: .7 }}>
          {title} — {tryEditor ? 'Google’s editor, embedded. If this panel is blank, switch back to read-only.' : 'the live sheet, read-only here. Edit with the fields beside it, or open it in Google.'}
        </span>
        <span style={{ display: 'flex', gap: 8 }}>
          <button type="button" style={ghost} onClick={() => setTryEditor(!tryEditor)}>
            {tryEditor ? 'Back to read-only' : 'Try editing here'}
          </button>
          <a href={sheetOpen(id)} target="_blank" rel="noreferrer" style={{ ...ghost, textDecoration: 'none' }}>Open in Google Sheets ↗</a>
        </span>
      </div>
      <iframe
        key={tryEditor ? 'edit' : 'preview'}
        title={title + ' (Google Sheets)'}
        src={tryEditor ? sheetEditEmbed(id) : sheetEmbed(id)}
        style={{ width: '100%', height, border: 0, display: 'block' }}
      />
    </div>
  );
}

export const SOURCE_SECTIONS: { id: Tab; href: string; label: string }[] = [
  { id: 'calendar', href: '/sources/calendar', label: 'Social Calendar' },
  { id: 'videos', href: '/sources/videos', label: 'Video Library' },
  { id: 'images', href: '/sources/images', label: 'Image Library' },
];


/**
 * Edit one row of a Google Sheet from here, written straight back to the file.
 *
 * Google will not let its editor be framed by another site, so "edit live"
 * cannot mean their editor inside our page. It means these fields: what you
 * save lands in the real sheet immediately. `expected` carries the values the
 * row had when it was read, and the server refuses the write if any of them
 * moved — so two people editing the same row cannot silently overwrite one
 * another.
 */
function RowEditor({ kind, tab, row, fields, onSaved }: {
  kind: 'calendar' | 'videos';
  tab: string;
  row: number;
  fields: { name: string; label: string; value: string; multiline?: boolean }[];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.name, f.value])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = fields.some((f) => draft[f.name] !== f.value);

  async function save() {
    const changes: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const f of fields) {
      if (draft[f.name] !== f.value) { changes[f.name] = draft[f.name]; expected[f.name] = f.value; }
    }
    if (!Object.keys(changes).length) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/sources', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, tab, row, changes, expected }),
      });
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'That change was not saved.')); return; }
      onSaved();
    } catch (e) {
      setErr(friendlyError(e, 'That change was not saved.'));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
      {fields.map((f) => (
        <label key={f.name} style={{ display: 'grid', gap: 3, fontSize: 11 }}>
          <span style={{ opacity: .6 }}>{f.label}</span>
          {f.multiline
            ? <textarea value={draft[f.name]} rows={4} onChange={(ev) => setDraft({ ...draft, [f.name]: ev.target.value })}
                style={{ font: 'inherit', fontSize: 12, padding: 7, borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', resize: 'vertical' }} />
            : <input value={draft[f.name]} onChange={(ev) => setDraft({ ...draft, [f.name]: ev.target.value })}
                style={{ font: 'inherit', fontSize: 12, padding: '6px 7px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)' }} />}
        </label>
      ))}
      {err && <p role="alert" style={{ margin: 0, fontSize: 11, color: '#b42318' }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" style={{ ...btn, opacity: dirty && !busy ? 1 : .45 }} disabled={!dirty || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save to sheet'}
        </button>
        <span style={{ fontSize: 10, opacity: .55 }}>Writes into row {row} of “{tab}”.</span>
      </div>
    </div>
  );
}


/** Write a brand new row into a sheet tab. */
function RowAdder({ kind, tab, fields, onAdded }: {
  kind: 'calendar' | 'videos';
  tab: string;
  fields: { name: string; label: string; multiline?: boolean }[];
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    const values = Object.fromEntries(Object.entries(draft).filter(([, v]) => String(v || '').trim()));
    if (!Object.keys(values).length) { setErr('Write something first.'); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch('/api/sources', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add_row', kind, tab, values }),
      });
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'That row was not added.')); return; }
      setDraft({}); setOpen(false); onAdded();
    } catch (e) {
      setErr(friendlyError(e, 'That row was not added.'));
    } finally { setBusy(false); }
  }

  if (!open) {
    return <button type="button" style={{ ...btn, marginTop: 10 }} onClick={() => setOpen(true)}>Add a post to the sheet</button>;
  }
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 10, borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 10 }}>
      <strong style={{ fontSize: 12 }}>New row in “{tab}”</strong>
      {fields.map((f) => (
        <label key={f.name} style={{ display: 'grid', gap: 3, fontSize: 11 }}>
          <span style={{ opacity: .6 }}>{f.label}</span>
          {f.multiline
            ? <textarea rows={4} value={draft[f.name] || ''} onChange={(ev) => setDraft({ ...draft, [f.name]: ev.target.value })}
                style={{ font: 'inherit', fontSize: 12, padding: 7, borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)', resize: 'vertical' }} />
            : <input value={draft[f.name] || ''} onChange={(ev) => setDraft({ ...draft, [f.name]: ev.target.value })}
                style={{ font: 'inherit', fontSize: 12, padding: '6px 7px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.15)' }} />}
        </label>
      ))}
      {err && <p role="alert" style={{ margin: 0, fontSize: 11, color: '#b42318' }}>{err}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" style={btn} disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add to sheet'}</button>
        <button type="button" style={ghost} disabled={busy} onClick={() => { setOpen(false); setErr(null); }}>Cancel</button>
      </div>
    </div>
  );
}

export default function SourcesView({ kind }: { kind: Tab }) {
  const router = useRouter();
  const workspace = useWorkspace();
  const tab: Tab = kind;
  const [status, setStatus] = useState<Status | null>(null);
  // The embedded sheet should fill the window and keep filling it. This was
  // read once at first render, so the frame kept its original height through
  // any resize or full-screen — on the one page whose whole point is the size
  // of the document.
  const [viewportH, setViewportH] = useState(900);
  useEffect(() => {
    const measure = () => setViewportH(window.innerHeight);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const sheetHeight = Math.max(760, viewportH - 190);

  // Which row has its editor open, as "tab:row".
  const [editing, setEditing] = useState<string | null>(null);

  // Add a photo to the shared Drive folder. Upload only — the dashboard never
  // renames or deletes anything in Drive, because adding a file is undoable in
  // one click and removing one is not.
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  async function uploadImage(file: File) {
    setUploading(true); setUploadErr(null);
    try {
      if (file.size > 12 * 1024 * 1024) { setUploadErr('That image is over 12 MB. Add it in Drive directly.'); return; }
      const data = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(new Error('could not read the file'));
        fr.readAsDataURL(file);
      });
      const r = await fetch('/api/sources', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'upload_image', name: file.name, contentType: file.type, data }),
      });
      if (!r.ok) { setUploadErr(await friendlyErrorFromResponse(r, 'That photo was not added.')); return; }
      await load('images', true);
    } catch (e) {
      setUploadErr(friendlyError(e, 'That photo was not added.'));
    } finally { setUploading(false); }
  }

  const [calendar, setCalendar] = useState<{ entries: CalendarEntry[]; tabs: string[] } | null>(null);
  const [videos, setVideos] = useState<{ entries: VideoEntry[]; tabs: string[] } | null>(null);
  const [images, setImages] = useState<DriveImage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [prepareUrl, setPrepareUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    fetch('/api/sources?kind=status').then((r) => (r.ok ? r.json() : null)).then((j) => j && setStatus(j)).catch(() => undefined);
  }, []);

  useEffect(() => {
    load(tab, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function load(kind: Tab, fresh: boolean) {
    setErr(null);
    try {
      const r = await fetch('/api/sources?kind=' + kind + (fresh ? '&fresh=1' : ''));
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'We could not read that document.')); return; }
      const j = await r.json();
      if (kind === 'calendar') setCalendar(j);
      else if (kind === 'videos') setVideos(j);
      else setImages(Array.isArray(j?.images) ? j.images : []);
    } catch {
      setErr('We could not read that document just now.');
    }
  }

  function firstLink(v: VideoEntry): string {
    return (v.videoLink || '').split(/\s+/).find((x) => /^https?:/.test(x)) || v.videoLink || '';
  }
  function youtubeOf(v: VideoEntry): string {
    const l = v.youtubeLink || firstLink(v);
    return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(l) ? l : '';
  }
  function prepare(v: VideoEntry) {
    const link = youtubeOf(v);
    if (!link) return;
    setPrepareUrl(link);
    setTimeout(() => document.getElementById('video-prepare')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  function handoff(text: string, media: string, mediaLabel: string) {
    workspace.patch({ handoffText: text, handoffMedia: media, handoffMediaLabel: mediaLabel, handoffNonce: Date.now() });
    router.push('/draft#section-publish' as Route);
  }

  async function importImage(img: DriveImage) {
    setBusy(img.id); setErr(null);
    try {
      const r = await fetch('/api/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import_image', fileId: img.id }) });
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'We could not copy that image.')); return; }
      const j = await r.json();
      handoff('', String(j.url || ''), 'Drive photo: ' + img.name);
    } catch {
      setErr('We could not copy that image just now.');
    } finally {
      setBusy(null);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = useMemo(() => (calendar?.entries || []).filter((e) => e.date && e.date >= today).sort((a, b) => String(a.date).localeCompare(String(b.date))), [calendar, today]);
  const recent = useMemo(() => (calendar?.entries || []).filter((e) => !e.date || e.date < today).slice(0, 12), [calendar, today]);
  const filteredVideos = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = videos?.entries || [];
    if (!needle) return list;
    return list.filter((v) => [v.title, v.copy, v.type, v.creator, v.format, v.tab].join(' ').toLowerCase().includes(needle));
  }, [videos, q]);

  const active = TABS.find((t) => t.id === tab)!;
  const ids = status?.ids;

  return (
    <main style={{ minHeight: '100vh', background: '#f5f5f7', color: '#1d1d1f', fontFamily: '-apple-system,Segoe UI,sans-serif' }}>
      <header style={{ padding: '20px 32px', borderBottom: '1px solid rgba(0,0,0,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>{active.label}</h1>
          <div style={{ fontSize: 13, opacity: .6, marginTop: 4 }}>{active.blurb}</div>
        </div>
        <PageNav current={SOURCE_SECTIONS.find((s) => s.id === tab)?.href || '/sources/calendar'} />
      </header>

      {/* Sources is the one place the page's job IS the document: a
          spreadsheet at half width is a spreadsheet you cannot read. 1200 is
          the shell every other page uses, and here it left the sheet about
          790px on a 1567px screen. These three sections get the room instead;
          nothing else renders this component, so no other page moves. 2100
          still centres on an ultrawide rather than stretching a sheet across
          a metre of glass. */}
      <div style={{ maxWidth: 2100, margin: '0 auto', padding: '24px 28px', display: 'grid', gap: 20 }}>

        {status && !status.configured && (
          <div role="alert" style={{ ...card, borderColor: '#f0c36d', background: '#fff8e6', fontSize: 13 }}>
            Google access is not set up yet — the documents still open below, but the dashboard cannot read them. Ask whoever set this up to add the Google service account.
          </div>
        )}
        {err && <div role="alert" style={{ color: '#d70015', fontSize: 13 }}>{err}</div>}

        {tab === 'calendar' && (
          <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'minmax(0, 4fr) minmax(300px, 1fr)' }} className="sources-grid">
            <section style={{ ...card, padding: 0, overflow: 'hidden', minHeight: 640 }}>
              {ids && <SheetFrame id={ids.calendar} title="Cellular Institute Social Media Calendar" height={sheetHeight} />}
            </section>
            <aside style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
              <section style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ margin: 0, fontSize: 15 }}>Coming up</h2>
                  <button type="button" style={ghost} onClick={() => load('calendar', true)}>Refresh</button>
                </div>
                {!calendar ? <p style={{ fontSize: 13, opacity: .6 }}>Reading the sheet…</p>
                  : upcoming.length === 0 ? <p style={{ fontSize: 13, opacity: .6 }}>Nothing dated from today onward — every row below is editable.</p>
                  : (
                    <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 10 }}>
                      {upcoming.slice(0, 14).map((e, i) => (
                        <li key={i} style={{ borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 10, fontSize: 12 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                            <strong>{e.date}</strong>
                            <span style={{ opacity: .6 }}>{e.status || '—'}</span>
                          </div>
                          <div style={{ marginTop: 4, opacity: .85, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{e.caption}</div>
                          <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                            {e.networks.map((n) => <span key={n} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 999, background: '#eef3ff', color: '#1d4ed8' }}>{n}</span>)}
                            {e.caption && <button type="button" style={{ ...ghost, padding: '3px 9px', fontSize: 11 }} onClick={() => handoff(e.caption, '', '')}>Use in post</button>}
                            <button type="button" style={{ ...ghost, padding: '3px 9px', fontSize: 11 }} onClick={() => setEditing(editing === e.tab + ':' + e.row ? null : e.tab + ':' + e.row)}>
                              {editing === e.tab + ':' + e.row ? 'Close' : 'Edit'}
                            </button>
                            {e.graphicsLink && <a href={e.graphicsLink} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>graphic ↗</a>}
                          </div>
                          {editing === e.tab + ':' + e.row && (
                            <RowEditor
                              kind="calendar" tab={e.tab} row={e.row}
                              onSaved={() => { setEditing(null); void load('calendar', true); }}
                              fields={[
                                { name: 'description', label: 'Post text', value: e.caption, multiline: true },
                                { name: 'date', label: 'Date', value: e.date || '' },
                                { name: 'status', label: 'Status', value: e.status || '' },
                                { name: 'owner', label: 'Owner', value: e.owner || '' },
                              ].filter((f) => e.columns && (e.columns as Record<string, string>)[f.name])}
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                {calendar && calendar.entries.length > 0 && (
                  <RowAdder
                    kind="calendar"
                    tab={calendar.entries[0].tab}
                    onAdded={() => void load('calendar', true)}
                    fields={[
                      { name: 'description', label: 'Post text', multiline: true },
                      { name: 'date', label: 'Date' },
                      { name: 'status', label: 'Status' },
                      { name: 'owner', label: 'Owner' },
                    ].filter((f) => (calendar.entries[0].columns as Record<string, string>)[f.name])}
                  />
                )}
              </section>
              {calendar && recent.length > 0 && (
                <section style={card}>
                  <h2 style={{ margin: 0, fontSize: 15 }}>Everything else on the sheet ({recent.length})</h2>
                  <p style={{ fontSize: 11, opacity: .6, margin: '4px 0 0' }}>Press Edit on any row to change it here; it saves into the sheet.</p>
                  <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8, fontSize: 12 }}>
                    {recent.map((e, i) => (
                      <li key={i} style={{ borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 8 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{e.caption || e.fileName}</span>
                          <span style={{ whiteSpace: 'nowrap', opacity: .6 }}>{e.date || e.tab}</span>
                        </div>
                        <div style={{ marginTop: 5, display: 'flex', gap: 6, alignItems: 'center' }}>
                          {e.caption && <button type="button" style={{ ...ghost, padding: '3px 9px', fontSize: 11 }} onClick={() => handoff(e.caption, '', '')}>Use in post</button>}
                          <button type="button" style={{ ...ghost, padding: '3px 9px', fontSize: 11 }} onClick={() => setEditing(editing === e.tab + ':' + e.row ? null : e.tab + ':' + e.row)}>
                            {editing === e.tab + ':' + e.row ? 'Close' : 'Edit'}
                          </button>
                        </div>
                        {editing === e.tab + ':' + e.row && (
                          <RowEditor
                            kind="calendar" tab={e.tab} row={e.row}
                            onSaved={() => { setEditing(null); void load('calendar', true); }}
                            fields={[
                              { name: 'description', label: 'Post text', value: e.caption, multiline: true },
                              { name: 'date', label: 'Date', value: e.date || '' },
                              { name: 'status', label: 'Status', value: e.status || '' },
                              { name: 'owner', label: 'Owner', value: e.owner || '' },
                            ].filter((f) => e.columns && (e.columns as Record<string, string>)[f.name])}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <p style={{ fontSize: 11, opacity: .55, margin: 0 }}>Every post you approve on the dashboard is also written to this sheet, on a &quot;Dashboard Approvals&quot; tab.</p>
            </aside>
          </div>
        )}

        {tab === 'videos' && (
          <div style={{ display: 'grid', gap: 20 }}>
            <VideoPrepare initialUrl={prepareUrl} />
            <section style={{ ...card, padding: 0, overflow: 'hidden' }}>
              {ids && <SheetFrame id={ids.videos} title="Distribución RRSS CHI" height={sheetHeight - 60} />}
            </section>
            <section style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 15 }}>Videos {videos ? '(' + videos.entries.length + ')' : ''}</h2>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, copy, creator…" style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)', fontSize: 13, minWidth: 240 }} />
                  <button type="button" style={ghost} onClick={() => load('videos', true)}>Refresh</button>
                </div>
              </div>
              {!videos ? <p style={{ fontSize: 13, opacity: .6 }}>Reading the sheet…</p>
                : filteredVideos.length === 0 ? <p style={{ fontSize: 13, opacity: .6 }}>No videos match.</p>
                : (
                  <div style={{ overflowX: 'auto', marginTop: 12 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', opacity: .6 }}>
                          <th style={{ padding: '6px 8px' }}>Title</th><th style={{ padding: '6px 8px' }}>Copy</th><th style={{ padding: '6px 8px' }}>Format</th><th style={{ padding: '6px 8px' }}>Networks</th><th style={{ padding: '6px 8px' }}>By</th><th style={{ padding: '6px 8px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredVideos.map((v, i) => (
                          <Fragment key={i}>
                          <tr style={{ borderTop: '1px solid rgba(0,0,0,0.08)', verticalAlign: 'top' }}>
                            <td style={{ padding: '8px' }}>
                              <div style={{ fontWeight: 600 }}>{v.title || v.type || '—'}</div>
                              <div style={{ opacity: .6 }}>{[v.type, v.month, v.tab].filter(Boolean).join(' · ')}</div>
                              {v.videoLink && <a href={v.videoLink.split(/\s+/).find((x) => /^https?:/.test(x)) || v.videoLink} target="_blank" rel="noreferrer">open video ↗</a>}
                            </td>
                            <td style={{ padding: '8px', maxWidth: 380 }}><div style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', opacity: .85 }}>{v.copy || '—'}</div></td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{v.format || '—'}</td>
                            <td style={{ padding: '8px' }}><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{v.networks.map((n) => <span key={n} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 999, background: '#eef3ff', color: '#1d4ed8' }}>{n}</span>)}</div></td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{v.creator || '—'}</td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'grid', gap: 6 }}>
                                {youtubeOf(v) && (
                                  <button type="button" style={btn} onClick={() => prepare(v)} title="Transcript → keywords → LinkedIn + TikTok copy">Prepare</button>
                                )}
                                <button type="button" style={ghost} onClick={() => handoff([v.copy || v.title, v.videoLink ? 'Watch: ' + firstLink(v) : ''].filter(Boolean).join('\n\n'), '', '')}>Use in post</button>
                                <button type="button" style={{ ...ghost, padding: '5px 10px' }} onClick={() => setEditing(editing === v.tab + ':' + v.row ? null : v.tab + ':' + v.row)}>
                                  {editing === v.tab + ':' + v.row ? 'Close' : 'Edit'}
                                </button>
                              </div>
                            </td>
                          </tr>
                          {editing === v.tab + ':' + v.row && (
                            <tr>
                              <td colSpan={6} style={{ padding: '4px 8px 14px', background: 'rgba(0,0,0,0.02)' }}>
                                <RowEditor
                                  kind="videos" tab={v.tab} row={v.row}
                                  onSaved={() => { setEditing(null); void load('videos', true); }}
                                  fields={[
                                    { name: 'title', label: 'Title', value: v.title },
                                    { name: 'copy', label: 'Copy', value: v.copy, multiline: true },
                                    { name: 'format', label: 'Format', value: v.format },
                                    { name: 'notes', label: 'Notes (OBSERVACIÓN)', value: v.notes },
                                  ].filter((f) => v.columns && (v.columns as Record<string, string>)[f.name])}
                                />
                              </td>
                            </tr>
                          )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </section>
          </div>
        )}

        {tab === 'images' && ids && (
          <section style={{ ...card, padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid rgba(0,0,0,0.08)', fontSize: 12 }}>
              <span style={{ opacity: .7 }}>The shared Drive folder — photos and videos the team adds here show up in the dashboard.</span>
              <a href={'https://drive.google.com/drive/folders/' + ids.images} target="_blank" rel="noreferrer" style={{ ...ghost, textDecoration: 'none' }}>Open in Google Drive ↗</a>
            </div>
            <iframe title="Images folder (Google Drive)" src={'https://drive.google.com/embeddedfolderview?id=' + ids.images + '#grid'} style={{ width: '100%', height: Math.max(460, Math.round(sheetHeight * 0.62)), border: 0, display: 'block' }} />
          </section>
        )}
        {tab === 'images' && (
          <section style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>Images {images ? '(' + images.length + ')' : ''}</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                {ids && <a href={'https://drive.google.com/drive/folders/' + ids.images} target="_blank" rel="noreferrer" style={{ ...ghost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Open folder in Drive ↗</a>}
                <label style={{ ...btn, display: 'inline-flex', alignItems: 'center', cursor: uploading ? 'wait' : 'pointer', opacity: uploading ? .5 : 1 }}>
                  {uploading ? 'Uploading…' : 'Add a photo'}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={uploading} style={{ display: 'none' }}
                    onChange={(ev) => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) void uploadImage(f); }} />
                </label>
                <button type="button" style={ghost} onClick={() => load('images', true)}>Refresh</button>
              </div>
            </div>
            {uploadErr && <p role="alert" style={{ fontSize: 12, color: '#b42318', marginTop: 8 }}>{uploadErr}</p>}
            <p style={{ fontSize: 12, opacity: .65, marginTop: 8 }}>&quot;Add a photo&quot; puts it straight into the team&apos;s Drive folder — everyone sees it, not just the dashboard. &quot;Use as hero image&quot; copies one into the dashboard so Metricool can publish it; the photo itself stays in Drive.</p>
            {!images ? <p style={{ fontSize: 13, opacity: .6 }}>Reading the folder…</p>
              : images.length === 0 ? <p style={{ fontSize: 13, opacity: .6 }}>No images in the folder yet.</p>
              : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 14, marginTop: 14 }}>
                  {images.map((img) => (
                    <figure key={img.id} style={{ margin: 0, border: '1px solid rgba(0,0,0,0.08)', borderRadius: 10, overflow: 'hidden', background: '#fafafa' }}>
                      <a href={img.viewUrl} target="_blank" rel="noreferrer" style={{ display: 'block', aspectRatio: '4 / 3', background: '#eee' }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={img.thumbUrl} alt={img.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                      </a>
                      <figcaption style={{ padding: 10, fontSize: 11 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={img.name}>{img.name}</div>
                        <div style={{ opacity: .55, marginTop: 2 }}>{img.modifiedTime.slice(0, 10)}{img.size ? ' · ' + (img.size / 1024 / 1024).toFixed(1) + ' MB' : ''}</div>
                        <button type="button" style={{ ...btn, marginTop: 8, width: '100%' }} disabled={busy === img.id} onClick={() => importImage(img)}>{busy === img.id ? 'Copying…' : 'Use as hero image'}</button>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              )}
          </section>
        )}
      </div>
      <style>{`@media (max-width: 900px) { .sources-grid { grid-template-columns: minmax(0,1fr) !important; } }`}</style>
    </main>
  );
}
