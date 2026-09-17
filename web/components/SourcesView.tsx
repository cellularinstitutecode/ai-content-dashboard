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

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Route } from 'next';
import PageNav from '@/components/PageNav';
import { useWorkspace } from '@/components/workspace';
import { friendlyError, friendlyErrorFromResponse } from '@/lib/friendly-error';
import { metricoolPlannerUrl } from '@/lib/metricool-links';
import VideoRegister from '@/components/VideoRegister';
import PreparedBoard from '@/components/PreparedBoard';
import VideoPrepare, { type Prepared } from '@/components/VideoPrepare';
import { ensureVideoAttachable, fetchShareableVideos } from '@/components/MediaPicker';
import { runPrepare } from '@/lib/prepare-request';
import { mapLimit } from '@/lib/map-limit';
import { mayStartBatch, reasons, runSummary, tally, tallyRows, type BatchReasons, type BatchState } from '@/lib/batch-plan';
import { isDriveUrl, parseDriveFileId } from '@/lib/drive-url';
import { parseFromRow, rowsBetween, rowsFrom } from '@/lib/rows-from';
import { attachPlanFor, pendingPosts, postsByRow } from '@/lib/attach-plan';
import { preparedByRow, rowKeyOf, type PreparedRow } from '@/lib/prepared-rows';
import { ZOOM_MAX, ZOOM_MIN, frameGeometry, readStoredZoom, zoomIn, zoomLabel, zoomOut, zoomStorageKey } from '@/lib/sheet-zoom';

/** How a batched row is getting on, in words rather than a spinner. */
const BATCH_LABEL: Record<string, string> = {
  queued: 'Waiting…',
  working: 'Preparing…',
  done: '✓ Written into the sheet',
  failed: '✗ Not done',
  needs_transcript: 'Needs a pasted transcript',
};
const BATCH_COLOUR: Record<string, string> = {
  queued: 'rgba(0,0,0,0.5)',
  working: '#1d4ed8',
  done: '#1d6f42',
  failed: '#d70015',
  needs_transcript: '#8a6d00',
};

/**
 * The most videos one press may start.
 *
 * The Prepare endpoint is rate-limited to thirty an hour, and each video may
 * take two requests, so fifteen is the point past which the batch would begin
 * refusing its own later rows — a worse experience than being told the cap up
 * front.
 */
const BATCH_MAX = 60;

/**
 * How many prepare in parallel.
 *
 * Not "all of them". Semrush's unit-floor guard caches the balance per serverless
 * instance, so callers in a wide burst each measure the same pre-spend headroom and the
 * floor can be overshot by the size of the burst — real money, not a warning. Four is
 * comfortably inside that and still four times faster than one at a time.
 */
const BATCH_CONCURRENCY = 4;

export type Tab = 'calendar' | 'videos' | 'images';

type CalendarEntry = { tab: string; row: number; headerRow: number; columns: Record<string, string>; date: string | null; type: string; pillar: string; owner: string; cta: string; caption: string; fileName: string; graphicsLink: string; status: string; networks: string[] };
type VideoEntry = { tab: string; row: number; headerRow: number; columns: Record<string, string>; creator: string; month: string; type: string; title: string; copy: string; videoLink: string; youtubeLink?: string; format: string; networks: string[]; thumbnailTitle: string; coverLink: string; notes: string; keywords?: string; ref?: string; aiStatus?: string };
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
  // Open in Google's own editor, not the read-only preview.
  //
  // The preview renders the values but not the GRID — no column letters, no
  // row numbers — and those are the coordinates every conversation about this
  // sheet uses ("column E", "row 190"). Starting read-only meant pressing a
  // button before the sheet could be read the way people actually talk about
  // it. The toggle stays, for the case where the embed comes up blank.
  const [tryEditor, setTryEditor] = useState(true);

  // The frame takes every wheel event under the cursor, and it is as tall as
  // the window — so scrolling the PAGE with the mouse anywhere over it scrolled
  // the SHEET instead. Shielded by an overlay until clicked into, shielded
  // again when the mouse leaves: the page scrolls when you mean the page, the
  // sheet when you are in the sheet — and while the sheet has the mouse the
  // page is locked, so nothing the sheet cannot use leaks out to it. Verified
  // in headless Chromium against a same-origin frame: unarmed wheel scrolls the
  // page only; armed wheel scrolls the frame only, even at the frame's end;
  // leaving or Esc hands the wheel back. See lib/sheet-zoom.ts.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setArmed(false); };
    window.addEventListener('keydown', onKey);
    // While the sheet has the mouse, the PAGE does not scroll at all. Without
    // this, a wheel the sheet cannot use (its grid at an edge, a horizontal
    // flick) chains out of the frame and moves the page under it — which is
    // "it still keeps scrolling everywhere". The lock is the same one a
    // modal uses: hide the document's scrollbar and pad by its width so the
    // layout does not jump. Undone the moment the sheet lets go.
    const root = document.documentElement;
    const gutter = window.innerWidth - root.clientWidth;
    const prevOverflow = root.style.overflow;
    const prevPadding = root.style.paddingRight;
    root.style.overflow = 'hidden';
    if (gutter > 0) root.style.paddingRight = gutter + 'px';
    return () => {
      window.removeEventListener('keydown', onKey);
      root.style.overflow = prevOverflow;
      root.style.paddingRight = prevPadding;
    };
  }, [armed]);

  // The magnifier. Remembered per sheet, read after mount so the server and
  // the first client render agree.
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    try { setZoom(readStoredZoom(window.localStorage.getItem(zoomStorageKey(id)))); } catch { /* not essential */ }
  }, [id]);
  function applyZoom(next: number) {
    setZoom(next);
    try { window.localStorage.setItem(zoomStorageKey(id), String(next)); } catch { /* not essential */ }
  }
  const geometry = frameGeometry(zoom, height);
  const zoomBtn: React.CSSProperties = { ...ghost, padding: '4px 9px', minWidth: 30, fontVariantNumeric: 'tabular-nums' };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '10px 14px', borderBottom: '1px solid rgba(0,0,0,0.08)', fontSize: 12, flexWrap: 'wrap' }}>
        <span style={{ opacity: .7 }}>
          {title} — {tryEditor ? 'Google’s editor, embedded — column letters and row numbers as they are in the sheet. If this panel is blank, switch to the read-only view.' : 'the live sheet, read-only. Edit with the fields beside it, or open it in Google.'}
        </span>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }} aria-label="Zoom">
            <span aria-hidden="true" style={{ opacity: .6, marginRight: 2 }}>{'\u{1F50D}'}</span>
            <button type="button" style={zoomBtn} onClick={() => applyZoom(zoomOut(zoom))} disabled={zoom <= ZOOM_MIN} title="Zoom out" aria-label="Zoom out">−</button>
            <button type="button" style={zoomBtn} onClick={() => applyZoom(1)} title="Reset to 100%" aria-label={'Zoom ' + zoomLabel(zoom) + ', reset to 100%'}>{zoomLabel(zoom)}</button>
            <button type="button" style={zoomBtn} onClick={() => applyZoom(zoomIn(zoom))} disabled={zoom >= ZOOM_MAX} title="Zoom in" aria-label="Zoom in">+</button>
          </span>
          <button type="button" style={ghost} onClick={() => setTryEditor(!tryEditor)}>
            {tryEditor ? 'Read-only view' : 'Edit here'}
          </button>
          <a href={sheetOpen(id)} target="_blank" rel="noreferrer" style={{ ...ghost, textDecoration: 'none' }}>Open in Google Sheets ↗</a>
          {/* The other half of the row's life.
              This sheet says what is PLANNED; Metricool's planner says what
              actually went out and what is still waiting for approval. Checking
              the second meant leaving the page and finding the brand by hand,
              so the two now sit next to each other. The link is built by
              lib/metricool-links.ts rather than written here — it has to carry
              both the brand and the user, and the copy that did not is the one
              that opened Metricool's own error page. */}
          <a
            href={metricoolPlannerUrl()}
            target="_blank"
            rel="noopener noreferrer"
            style={{ ...ghost, textDecoration: 'none' }}
            title="What has been posted and what is waiting for approval, on Metricool's calendar"
          >
            {'\u{1F4C5}'} Metricool planner ↗
          </a>
        </span>
      </div>
      <div
        style={{ position: 'relative', height, overflow: 'hidden' }}
        onMouseLeave={() => setArmed(false)}
      >
        <iframe
          key={tryEditor ? 'edit' : 'preview'}
          title={title + ' (Google Sheets)'}
          src={tryEditor ? sheetEditEmbed(id) : sheetEmbed(id)}
          style={{
            width: geometry.widthPercent + '%',
            height: geometry.height,
            border: 0,
            display: 'block',
            transform: geometry.transform,
            transformOrigin: '0 0',
            // NOT pointer-events. The first version of this toggled the frame's
            // pointer-events none→auto on arming, and Chromium then never
            // delivered another wheel event to the frame — every scroll went to
            // the page, which is "it still keeps scrolling everywhere". The
            // overlay button below is the only shield: present while inert,
            // gone while armed; the frame itself is never touched.
          }}
        />
        {!armed && (
          <button
            type="button"
            onClick={() => setArmed(true)}
            title="Click to scroll and work inside the sheet"
            aria-label="Click to scroll and work inside the sheet"
            style={{ position: 'absolute', inset: 0, background: 'transparent', border: 0, cursor: 'pointer', padding: 0 }}
          >
            <span style={{ position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)', background: 'rgba(28,28,30,0.82)', color: '#fff', fontSize: 12, padding: '6px 12px', borderRadius: 999, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
              Click to scroll inside the sheet
            </span>
          </button>
        )}
        {armed && (
          <span style={{ position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)', background: 'rgba(0,113,227,0.9)', color: '#fff', fontSize: 12, padding: '6px 12px', borderRadius: 999, whiteSpace: 'nowrap', pointerEvents: 'none' }}>
            Sheet active — move the mouse out (or press Esc) to scroll the page
          </span>
        )}
      </div>
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
  /**
   * Source video id → the URL of its shareable copy.
   *
   * "Use in post" handed over the caption and an empty media slot, then pasted
   * `Watch: <Drive link>` onto the text — a link the clinic's Drive keeps
   * private, so a reader clicking it got a permission wall. The copy that IS
   * fetchable already exists for any prepared row; this is the lookup that
   * finds it. Empty until it loads, and empty is handled: the button then says
   * what to press to make one.
   */
  const [shareable, setShareable] = useState<Record<string, string>>({});
  /** Which row is having its shareable copy made right now, so its button can say so. */
  const [attaching, setAttaching] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  /**
   * Every finished row's full result, and which one the panel is showing.
   *
   * runPrepare has always returned the whole response; prepareSelected read
   * `sheet?.error` out of it and dropped the rest, so a row that prepared
   * perfectly reported "✓ Written into the sheet" and threw away the
   * transcript, the keyword line, the REF, the Metricool state and both
   * drafts. Keeping it costs one assignment.
   */
  const [results, setResults] = useState<Record<string, Prepared>>({});
  const [shown, setShown] = useState<string | null>(null);

  /** Take the person to the panel — only ever because they asked, or because a run FINISHED. */
  function showResult(key: string) {
    setShown(key);
    setTimeout(() => document.getElementById('video-prepare')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  }

  // No prepareUrl/prepareRow any more.
  //
  // They existed so the row button could load a link into the panel above and
  // scroll there. Now the row prepares itself, nothing writes them, and keeping
  // them would leave two pieces of permanently-undefined state feeding a panel.
  //
  // Removing sheetRow also closes a real bug rather than merely tidying: the
  // panel held onto the row it was last given while letting the URL box be
  // retyped, so preparing row 183 and then pasting row 181's link wrote 181's
  // copy into 183. With no row supplied, /api/videos/prepare falls back to
  // findRowByLink(), which matches on the parsed Drive file id — the link now
  // always decides its own row.

  useEffect(() => {
    fetch('/api/sources?kind=status').then((r) => (r.ok ? r.json() : null)).then((j) => j && setStatus(j)).catch(() => undefined);
  }, []);

  useEffect(() => {
    load(tab, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Which videos already have a copy a network can fetch. Read once; a failure
  // costs the video on a hand-off, never the hand-off itself.
  useEffect(() => {
    let alive = true;
    void fetchShareableVideos().then(({ videos: found }) => {
      if (!alive) return;
      const byId: Record<string, string> = {};
      for (const v of found) byId[v.videoId] = v.url;
      setShareable(byId);
    });
    return () => { alive = false; };
  }, []);

  /**
   * WHICH DRAFT BELONGS TO WHICH ROW.
   *
   * video_runs has recorded this since the pipeline was built — spreadsheet,
   * tab, row and the draft each was prepared into — and this screen never read
   * it. So "Use in post" handed over the sheet's own copy column, which is a
   * different text from the one the dashboard wrote, and the post that reached
   * Metricool was not the post that was prepared.
   */
  const [preparedRows, setPreparedRows] = useState<Record<string, PreparedRow>>({});
  useEffect(() => {
    let alive = true;
    fetch('/api/videos/runs?limit=200')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j?.ok) return;
        // The rule — newest run wins — lives in lib/prepared-rows.ts with its
        // tests, because "which draft is this row's" is the question that was
        // being answered wrongly.
        setPreparedRows(preparedByRow(Array.isArray(j.rows) ? j.rows : []));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  /** The fetchable copy of this row's video, if one has been made. */
  function shareableFor(v: VideoEntry): string {
    const id = parseDriveFileId(firstLink(v));
    return (id && shareable[id]) || '';
  }

  /**
   * Send this row's caption AND its video to the composer.
   *
   * The video is the point of the row, so it is never quietly left behind: if
   * no shareable copy exists yet, one is made here and remembered, and the
   * button says "Attaching the video…" while that happens. A row with no Drive
   * video at all still hands over its caption — that is a text post, not a
   * failure.
   */
  async function sendToComposer(v: VideoEntry, youtubeUrl: string) {
    const link = firstLink(v);
    let media = shareableFor(v);
    if (!media && parseDriveFileId(link)) {
      setAttaching(rowKey(v));
      setErr(null);
      const out = await ensureVideoAttachable(link, v.title || 'video');
      setAttaching(null);
      if (out.error) { setErr(out.error); return; }
      media = out.url;
      const id = parseDriveFileId(link);
      if (id && media) setShareable((prev) => ({ ...prev, [id]: media }));
    }
    // THE TEXT THAT WAS PREPARED, not the sheet's own column.
    //
    // "The text that needs to be used has to be the one that was prepared."
    // This row may have been through Prepare — the copy written from the
    // transcript, with its AVISO, its verified citation and its title — and
    // that draft is what must reach the composer. The sheet's copy column is
    // the fallback for a row nobody has prepared, which is what it always was
    // for; using it for a prepared row is how a post arrived carrying words
    // that belonged to a different row.
    let text = '';
    let title = '';
    let draftId = '';
    const prepared = preparedRows[rowKeyOf(v.tab, v.row)];
    if (prepared?.draftId) {
      try {
        const r = await fetch('/api/drafts?id=' + encodeURIComponent(prepared.draftId));
        const j = r.ok ? await r.json() : null;
        const pack = (j?.draft?.pack || {}) as Record<string, unknown>;
        // tiktok is the caption the reel goes out with; linkedin is the long
        // form. Either is the prepared text; the sheet's column is neither.
        const body = [pack.tiktok, pack.linkedin, pack.instagram].find((x) => typeof x === 'string' && x.trim());
        if (typeof body === 'string' && body.trim()) {
          text = body;
          title = typeof pack.title === 'string' ? pack.title : '';
          draftId = prepared.draftId;
        }
      } catch {
        // A draft that cannot be read is not a reason to refuse the hand-off;
        // the sheet's copy still goes over, exactly as it did before.
      }
    }
    // A YouTube source is public and genuinely worth linking; a private Drive
    // link in the body is not, and the video is attached natively now anyway.
    if (!text) text = [v.copy || v.title, media || !youtubeUrl ? '' : 'Watch: ' + youtubeUrl].filter(Boolean).join('\n\n');
    handoff(text, media, media ? v.title || 'Video' : '', { tab: v.tab, row: v.row, link, format: v.format || '' }, title, draftId);
  }

  /**
   * WHAT IS ACTUALLY WRONG WITH THIS ROW'S VIDEO.
   *
   * Six rounds of this failure were diagnosed by reading code, and every round
   * cost a send. The facts live in the deployment: the file's size, which copy
   * exists, which host serves it, and — the test nothing had ever run — whether
   * a fetcher pulling the WHOLE file gets the whole file. A browser plays these
   * links because a player asks for small pieces; Metricool does not.
   */
  const [diagnosing, setDiagnosing] = useState<string>('');
  const [diagnosis, setDiagnosis] = useState<{ row: string; findings: string[] } | null>(null);
  async function diagnose(v: VideoEntry) {
    const key = rowKey(v);
    if (diagnosing) return;
    setDiagnosing(key);
    setDiagnosis(null);
    try {
      const r = await fetch('/api/videos/diagnose?link=' + encodeURIComponent(firstLink(v)));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setErr(friendlyError(j, 'The video could not be checked just now.')); return; }
      setDiagnosis({ row: key, findings: Array.isArray(j?.findings) ? j.findings.map(String) : [] });
    } catch (e) {
      setErr(friendlyError(e, 'The video could not be checked just now.'));
    } finally {
      setDiagnosing('');
    }
  }

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
  /**
   * The link to prepare from. YouTube first — its caption track is free, exact
   * and instant — then the Drive .mp4, which is what almost every row actually
   * has and which speech-to-text can now read. Before Drive was supported this
   * returned '' for those rows and the Prepare button was simply not drawn,
   * which is why nearly every row had to be done by hand.
   */
  /**
   * Which rows are ticked, and how each is getting on.
   *
   * Keyed on tab:row rather than list position: the list re-sorts and
   * re-filters under the selection, and an index would silently come to mean a
   * different video — which for a button that spends money is not a cosmetic
   * bug.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [batch, setBatch] = useState<Record<string, { state: BatchState; note?: string }>>({});
  const [running, setRunning] = useState(false);
  /** What the finished run added up to, once it is over. */
  const [summary, setSummary] = useState<string | null>(null);
  /** Show only what is ticked — the way to review a basket built across many searches. */
  const [onlyPicked, setOnlyPicked] = useState(false);
  /**
   * Write the sheet, queue nothing.
   *
   * Remembered with the basket, which is the choice that was made: it starts wherever it
   * was left. The risk of a setting from last week governing today's run is real, so the
   * bar states plainly which mode it is in rather than relying on a tick being noticed.
   */
  const [sheetOnly, setSheetOnly] = useState(false);
  /** Set when Stop is pressed; the loop checks it between videos, never mid-video. */
  const stopRef = useRef(false);
  /**
   * "From row N to the end" — the way a whole section of the sheet is ticked
   * in one press. The row number is what people read off the sheet, so it is
   * typed, not searched; the tab defaults to the one with the most rows still
   * needing copy, which is the month being worked on.
   */
  const [fromRow, setFromRow] = useState('');
  /** Optional last row of the range; empty means to the end. */
  const [toRow, setToRow] = useState('');
  const [fromTab, setFromTab] = useState('');
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);

  const rowKey = (v: VideoEntry) => v.tab + ':' + v.row;

  /**
   * How the run is going, right now.
   *
   * summarise() counts what mapLimit RETURNED, which is correct but only exists once every
   * row has finished — so during the minutes a batch is running there was no aggregate
   * anywhere, only per-row cells scattered down a table below the fold. This is the same
   * tally, derived at render time, so the top of the page can show it while it happens.
   */
  const liveTally = useMemo(() => tally(Object.values(batch).map((b) => b.state)), [batch]);
  // WHY the ones that stopped, stopped. Every failed row already carries the
  // server's own sentence; until now it only reached the table far below.
  // With the row KEYS, so every reason and every count can name its rows.
  const batchEntries = useMemo(() => Object.entries(batch).map(([key, b]) => ({ key, ...b })), [batch]);
  const liveReasons = useMemo(() => reasons(batchEntries), [batchEntries]);
  const liveRows = useMemo(() => tallyRows(batchEntries), [batchEntries]);
  /** The finished run, with the rows behind every miss — read from the same map the chips use. */
  const liveSummary = useMemo(() => (batchEntries.length ? runSummary(batchEntries) : null), [batchEntries]);

  /**
   * The basket, kept across a reload.
   *
   * Building one means searching a row number, ticking it, searching the next — minutes
   * of work that a refresh, a closed laptop or a stray navigation would otherwise throw
   * away. The per-row outcomes ride along so a run interrupted half way still shows what
   * it managed.
   *
   * Only ever a convenience: every read and write is wrapped, because a private window or
   * a browser set to block site data throws on the accessor itself, and a page that
   * cannot remember a basket must still draw one.
   */
  const BASKET_KEY = 'chi.videos.basket';
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(BASKET_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { picked?: string[]; batch?: Record<string, { state: BatchState; note?: string }>; sheetOnly?: boolean; fromRow?: string; toRow?: string; fromTab?: string };
      if (Array.isArray(saved.picked) && saved.picked.length) setPicked(new Set(saved.picked));
      if (typeof saved.sheetOnly === 'boolean') setSheetOnly(saved.sheetOnly);
      if (typeof saved.fromRow === 'string') setFromRow(saved.fromRow);
      if (typeof saved.toRow === 'string') setToRow(saved.toRow);
      if (typeof saved.fromTab === 'string') setFromTab(saved.fromTab);
      if (saved.batch && typeof saved.batch === 'object') {
        // A row left mid-flight belongs to a page that is gone. Show it as unfinished
        // rather than as forever "Preparing…".
        const restored: Record<string, { state: BatchState; note?: string }> = {};
        for (const [k, v] of Object.entries(saved.batch)) {
          restored[k] = v.state === 'working' || v.state === 'queued'
            // Deliberately not "the transcript is kept": a page restored from storage has
            // no idea whether it was, and that guess is what had somebody pressing a
            // button that could never work.
            ? { state: 'failed', note: 'Interrupted — press Prepare again to finish this one.' }
            : v;
        }
        setBatch(restored);
      }
    } catch { /* no stored basket, or storage is unavailable */ }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(BASKET_KEY, JSON.stringify({ picked: Array.from(picked), batch, sheetOnly, fromRow, toRow, fromTab }));
    } catch { /* storage full or blocked; the basket simply will not survive a reload */ }
  }, [picked, batch, sheetOnly, fromRow, toRow, fromTab]);

  // The browser can put what was typed back into the boxes on a reload
  // WITHOUT telling React (form-state restoration), so the box reads "179"
  // while the state is still '' — and the button stays off with a hint that
  // says "type the first row" under a box that plainly has one. Adopt what
  // the boxes show, once, after mount; a stored basket value still wins.
  useEffect(() => {
    const shown = (el: HTMLInputElement | null) => String(el?.value || '').replace(/[^0-9]/g, '');
    const sync = () => {
      const f = shown(fromRef.current);
      const t = shown(toRef.current);
      if (f) setFromRow((cur) => cur || f);
      if (t) setToRow((cur) => cur || t);
    };
    sync();
    // The restoration can land AFTER mount; look again shortly, and on the
    // page being shown from the back/forward cache.
    const timer = window.setTimeout(sync, 800);
    window.addEventListener('pageshow', sync);
    return () => { window.clearTimeout(timer); window.removeEventListener('pageshow', sync); };
  }, []);

  function togglePick(v: VideoEntry) {
    const k = rowKey(v);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  }

  /**
   * Prepare the ticked rows, several at a time.
   *
   * They used to go one after another, on the reasoning that firing several at once would
   * have them "competing for the same 60-second functions". That was wrong: each request
   * is a separate serverless invocation with its own 60 seconds and they do not share
   * CPU. Thirty-three videos at a minute each is half an hour of watching a page for no
   * reason.
   *
   * What DOES break under concurrency is two things the rows must not each decide for
   * themselves, so the plan call settles both before any of them starts:
   *
   *   - the tab's AI columns, which two rows appending at once would duplicate;
   *   - the posting slots, which every row would otherwise choose by reading the same
   *     calendar and all land on one morning.
   *
   * Four at a time, not everything at once: Semrush's unit-floor guard caches its balance
   * per serverless instance, so a wide burst can overshoot the floor by its own size, and
   * that is real money.
   */
  async function prepareSelected(rows: VideoEntry[]) {
    if (!rows.length || running) return;

    // The same video ticked twice under two different searches must not be downloaded and
    // transcribed twice — it is the single most expensive thing this does.
    const seen = new Set<string>();
    const work = rows.filter((v) => {
      const id = parseDriveFileId(prepareLink(v)) || rowKey(v);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });

    setRunning(true);
    stopRef.current = false;
    setSummary(null);
    // No scrolling. This used to jump to the prepare panel because a person
    // pressed the button, saw nothing move, and concluded nothing had happened
    // — the panel sits above a seven-hundred-pixel embedded sheet, so from the
    // gallery it is always off-screen. But moving the viewport was the wrong
    // answer to "there is no feedback": every row below reports its own state
    // as it goes, so the news is already where the person is looking, and
    // being hauled to the top made working down a list impossible.
    setBatch(Object.fromEntries(work.map((v) => [rowKey(v), { state: 'queued' as const }])));

    // Settle the columns and the slots first, serially, server-side.
    //
    // A PRECONDITION, not a nicety — the first version read the slots, never read
    // columnErrors, and carried on through a 429 or a dropped connection, straight into
    // the duplicate-column race the call exists to prevent. mayStartBatch holds the rule.
    const planRows = work.map((v) => ({
      tab: v.tab,
      hasAiColumns: Boolean(v.columns?.keywords && v.columns?.ref && v.columns?.aiStatus),
    }));

    let slots: string[] = [];
    let failedTabs: string[] = [];
    let planError: string | null = null;
    try {
      const r = await fetch('/api/videos/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tabs: Array.from(new Set(work.map((v) => v.tab))), count: work.length }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) planError = String(j?.message || 'The dashboard could not prepare the sheet for this run.');
      else {
        slots = Array.isArray(j?.slots) ? j.slots : [];
        failedTabs = Array.isArray(j?.columnErrors) ? j.columnErrors : [];
      }
    } catch {
      planError = 'The dashboard could not be reached to prepare the sheet for this run.';
    }

    const may = mayStartBatch(planRows, failedTabs, planError);
    if (!may.ok) {
      setBatch({});
      setSummary(may.reason + ' Nothing was prepared — try again.');
      setRunning(false);
      return;
    }

    const outcomes = await mapLimit(work, BATCH_CONCURRENCY, async (v, i): Promise<BatchState> => {
      const k = rowKey(v);
      if (stopRef.current) {
        setBatch((b) => (b[k]?.state === 'queued' ? { ...b, [k]: { state: 'failed', note: 'Stopped before this one.' } } : b));
        return 'failed';
      }
      setBatch((b) => ({ ...b, [k]: { state: 'working' } }));
      const out = await runPrepare(
        { url: prepareLink(v), tab: v.tab, row: v.row, publicationDate: slots[i], skipMetricool: sheetOnly },
        (note) => setBatch((b) => ({ ...b, [k]: { state: 'working', note } })),
      );
      const state: BatchState = !out.ok
        ? (out.kind === 'needs_transcript' ? 'needs_transcript' : 'failed')
        : ((out.data as { sheet?: { error?: string } }).sheet?.error ? 'failed' : 'done');
      const note = !out.ok ? out.message : (out.data as { sheet?: { error?: string } }).sheet?.error;
      setBatch((b) => ({ ...b, [k]: note ? { state, note } : { state } }));
      // The panel above can show all of this; keep it rather than reading one
      // field and discarding the response.
      if (out.ok) setResults((r) => ({ ...r, [k]: out.data as unknown as Prepared }));
      return state;
    });

    setRunning(false);
    setSummary(null); // the live summary below reads the finished map, rows included

    // One row, pressed deliberately: take them to the finished result.
    //
    // This is the scroll coming back, minus what was wrong with it. The old
    // one fired the INSTANT the button was clicked and landed on an empty
    // form that had to be pressed again. This one fires when the work is done
    // and lands on the outcome. A batch never moves the page — each finished
    // row offers its own link instead.
    if (work.length === 1 && outcomes[0] === 'done') showResult(rowKey(work[0]));
    // Once, at the end. Reloading between videos would move the rows about
    // under the person watching them.
    await load('videos', true);
  }

  /**
   * "Attach videos": make sure every draft in the From–To range carries its
   * video. Per row, lib/attach-plan.ts decides which of three EXISTING paths
   * applies — attach to posts still waiting for the video (the PENDING chip's
   * action), queue copy already written (/api/videos/queue), or prepare a row
   * with no copy (the batch's own path). Rows whose posts already carry the
   * video are reported as done without a single call. Nothing is removed or
   * rewritten, and nothing publishes.
   */
  async function attachRange(keys: readonly string[]) {
    if (running || !videos) return;
    const byKey = new Map(videos.entries.map((v) => [rowKey(v), v] as const));
    const rows = keys.map((k) => byKey.get(k)).filter((v): v is VideoEntry => Boolean(v)).slice(0, BATCH_MAX);
    if (!rows.length) return;
    setRunning(true);
    stopRef.current = false;
    setSummary(null);
    setBatch(Object.fromEntries(rows.map((v) => [rowKey(v), { state: 'queued' as const }])));

    // What each row already has, from the publishing list — read once. A list
    // that cannot be read is a reason to stop, not to guess "no posts" and
    // queue duplicates of drafts that already exist.
    let grouped = new Map<string, { id: string; videoPending?: boolean | null }[]>();
    try {
      const r = await fetch('/api/posts');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setBatch({});
        setSummary('The publishing list could not be read, so nothing was attached — try again.');
        setRunning(false);
        return;
      }
      grouped = postsByRow(Array.isArray(j?.posts) ? j.posts : []);
    } catch {
      setBatch({});
      setSummary('The dashboard could not be reached to read the publishing list — try again.');
      setRunning(false);
      return;
    }
    const plans = rows.map((v) => ({ v, action: attachPlanFor({ link: prepareLink(v), copy: v.copy }, grouped.get(rowKey(v))) }));

    // Rows that will CREATE drafts need what the batch needs: the AI columns
    // settled once per tab, and one reserved slot each so they land on
    // distinct instants. mayStartBatch holds the rule.
    const creating = plans.filter((p) => p.action === 'queue' || p.action === 'prepare');
    const slotFor = new Map<string, string>();
    if (creating.length) {
      const planRows = creating.map((p) => ({ tab: p.v.tab, hasAiColumns: Boolean(p.v.columns?.keywords && p.v.columns?.ref && p.v.columns?.aiStatus) }));
      let slots: string[] = [];
      let failedTabs: string[] = [];
      let planError: string | null = null;
      try {
        const r = await fetch('/api/videos/batch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tabs: Array.from(new Set(creating.map((p) => p.v.tab))), count: creating.length }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) planError = String(j?.message || 'The dashboard could not prepare the sheet for this run.');
        else {
          slots = Array.isArray(j?.slots) ? j.slots : [];
          failedTabs = Array.isArray(j?.columnErrors) ? j.columnErrors : [];
        }
      } catch {
        planError = 'The dashboard could not be reached to prepare the sheet for this run.';
      }
      const may = mayStartBatch(planRows, failedTabs, planError);
      if (!may.ok) {
        setBatch({});
        setSummary(may.reason + ' Nothing was attached — try again.');
        setRunning(false);
        return;
      }
      creating.forEach((p, i) => { if (slots[i]) slotFor.set(rowKey(p.v), slots[i]); });
    }

    await mapLimit(plans, BATCH_CONCURRENCY, async (p): Promise<BatchState> => {
      const k = rowKey(p.v);
      const finish = (state: BatchState, note?: string): BatchState => {
        setBatch((b) => ({ ...b, [k]: note ? { state, note } : { state } }));
        return state;
      };
      if (stopRef.current) return finish('failed', 'Stopped before this one.');
      setBatch((b) => ({ ...b, [k]: { state: 'working' } }));
      try {
        if (p.action === 'done') return finish('done', 'Already has its video.');
        if (p.action === 'no_video') return finish('failed', 'No Drive or YouTube video on this row.');
        if (p.action === 'attach') {
          const pending = pendingPosts(grouped.get(k));
          let attached = 0;
          let lastError = '';
          for (const post of pending) {
            const r = await fetch('/api/posts', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: post.id, action: 'attach_video' }),
            });
            if (r.ok) attached++;
            else lastError = await friendlyErrorFromResponse(r, 'We could not attach the video to that post.');
          }
          if (attached === pending.length) return finish('done', 'Video attached to ' + attached + ' draft' + (attached === 1 ? '' : 's') + '.');
          return finish('failed', 'Attached to ' + attached + ' of ' + pending.length + ' — ' + lastError);
        }
        if (p.action === 'queue') {
          const r = await fetch('/api/videos/queue', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tab: p.v.tab, row: p.v.row, publicationDate: slotFor.get(k) }),
          });
          const j = await r.json().catch(() => ({}));
          // Already in the queue is not a failure: the drafts exist and wait for
          // approval. Said as such, so the run does not read as broken.
          if (j?.error === 'already_published') return finish('done', String(j?.message || 'Already published \u2014 left alone.'));
          if (r.status === 409 || j?.error === 'already_queued') return finish('done', String(j?.message || 'Already in the queue, waiting for your approval.'));
          if (!r.ok) return finish('failed', String(j?.message || 'The row could not be queued.'));
          const outs = (Array.isArray(j?.metricool) ? j.metricool : []) as { ok?: boolean; network?: string; message?: string; reason?: string }[];
          const sent = outs.filter((m) => m?.ok).length;
          const alreadyThere = outs.filter((m) => m?.reason === 'already_queued').length;
          const refused = outs.filter((m) => !m?.ok && m?.reason !== 'already_queued');
          if (!sent && alreadyThere && !refused.length) return finish('done', 'Already in the queue, waiting for your approval (' + alreadyThere + ' draft' + (alreadyThere === 1 ? '' : 's') + ').');
          return finish(
            refused.length && !sent ? 'failed' : 'done',
            'Queued with the video, copy unchanged · ' + sent + ' draft' + (sent === 1 ? '' : 's') +
              (refused.length ? ' · ' + refused.length + ' refused: ' + refused.map((m) => m.network + ' (' + m.message + ')').join('; ') : ''),
          );
        }
        // prepare: the existing path — writes the copy and queues it with the video.
        const out = await runPrepare(
          { url: prepareLink(p.v), tab: p.v.tab, row: p.v.row, publicationDate: slotFor.get(k), skipMetricool: false },
          (note) => setBatch((b) => ({ ...b, [k]: { state: 'working', note } })),
        );
        if (!out.ok) return finish(out.kind === 'needs_transcript' ? 'needs_transcript' : 'failed', out.message);
        const sheetError = (out.data as { sheet?: { error?: string } }).sheet?.error;
        setResults((r) => ({ ...r, [k]: out.data as unknown as Prepared }));
        return finish(sheetError ? 'failed' : 'done', sheetError || 'Prepared and queued with the video.');
      } catch (e) {
        return finish('failed', friendlyError(e, 'Something went wrong on this row.'));
      }
    });

    setRunning(false);
    setSummary(null); // the live summary below reads the finished map, rows included
    await load('videos', true);
  }

  /**
   * Take the person to a row in the Videos table — the thing a summary line
   * that names a row should do, instead of saying "see the table below".
   */
  function jumpToRow(key: string) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('video-row-' + key);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const before = el.style.background;
    el.style.transition = 'background 0.3s';
    el.style.background = '#fff3c4';
    window.setTimeout(() => { el.style.background = before; }, 1400);
  }

  function prepareLink(v: VideoEntry): string {
    const yt = youtubeOf(v);
    if (yt) return yt;
    const l = firstLink(v);
    return isDriveUrl(l) ? l : '';
  }
  /**
   * Prepare ONE row, where the person is already standing.
   *
   * This used to load the link into the panel at the top of the page and
   * scroll there — so the button did not prepare anything, it navigated, and
   * the viewport jumped a thousand pixels to a form the person then had to
   * press again.
   *
   * Running it through prepareSelected instead reuses the whole proven path:
   * the batch plan call that settles the AI columns and the posting slot, the
   * per-row `working` state with its live note, the outcome, the tally and the
   * single reload at the end. One row is a batch of one, and nothing about
   * that path assumed otherwise.
   */
  function prepare(v: VideoEntry) {
    if (!prepareLink(v)) return;
    void prepareSelected([v]);
  }

  function handoff(
    text: string,
    media: string,
    mediaLabel: string,
    from?: { tab: string; row: number; link: string; format?: string },
    title = '',
    draftId = '',
  ) {
    workspace.patch({
      handoffText: text, handoffTitle: title, handoffDraftId: draftId,
      handoffMedia: media, handoffMediaLabel: mediaLabel,
      // WHERE it came from, so the composer can send the row with the post.
      handoffTab: from?.tab || '', handoffRow: from?.row || 0, handoffLink: from?.link || '', handoffFormat: from?.format || '',
      handoffNonce: Date.now(),
    });
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
    // The row number is searchable too: it is the reference people read off the
    // sheet and off the annotation on a screenshot, so typing "190" should find
    // row 190 rather than every caption that happens to contain those digits.
    return list.filter((v) => String(v.row) === needle
      || [v.title, v.copy, v.type, v.creator, v.format, v.tab].join(' ').toLowerCase().includes(needle));
  }, [videos, q]);

  /** What the table actually shows: the search, narrowed to the basket when asked. */
  const shownVideos = useMemo(
    () => (onlyPicked ? filteredVideos.filter((v) => picked.has(v.tab + ':' + v.row)) : filteredVideos),
    [filteredVideos, onlyPicked, picked],
  );

  /**
   * The rows the batch button acts on: visible, ticked, and in the order they
   * appear on screen rather than the order they were clicked — a run that
   * jumps about the list is hard to follow.
   */
  /**
   * Everything ticked — from the WHOLE sheet, not the current search.
   *
   * This was derived from filteredVideos, and searching a row number is exactly how a
   * person builds a batch here: tick 85, search 96, tick that, and the first one silently
   * dropped out of both the count and the run. The tick was still held; only this
   * derivation threw it away.
   */
  const pickedRows = useMemo(
    () => (videos?.entries || []).filter((v) => picked.has(v.tab + ':' + v.row)),
    [videos, picked],
  );
  /** Visible rows that are actual work: a video to read, and no copy yet. */
  const readyToPrepare = useMemo(
    () => filteredVideos.filter((v) => prepareLink(v) && !String(v.copy || '').trim()),
    [filteredVideos],
  );
  /** Ticked rows that already have copy — preparing them cannot write anything. */
  const pickedWithCopy = pickedRows.filter((v) => String(v.copy || '').trim()).length;
  /**
   * The tabs that have work on them, most first — the choice offered beside
   * "From row", with the busiest tab as the default so the common case is
   * "type 179, press the button".
   */
  // Plain derivations, not memoised: a few hundred rows, and prepareLink is a
  // function of the component (memoising on it would recompute every render anyway).
  // Tabs that hold videos, busiest first — copy written or not, because the
  // "Attach videos" range works on both.
  const workCounts = new Map<string, number>();
  for (const v of videos?.entries || []) {
    if (prepareLink(v)) workCounts.set(v.tab, (workCounts.get(v.tab) || 0) + 1);
  }
  const tabsWithWork = Array.from(workCounts.entries()).sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const fromTabInUse = fromTab && tabsWithWork.includes(fromTab) ? fromTab : (tabsWithWork[0] || '');
  const rangeRows = (videos?.entries || []).map((v) => ({ tab: v.tab, row: v.row, link: prepareLink(v), copy: v.copy }));
  /** What "From row N [to M]" would tick for Prepare — rows still needing copy — decided in lib/rows-from.ts. */
  const fromRowKeys = rowsFrom(rangeRows, parseFromRow(fromRow), fromTabInUse, parseFromRow(toRow));
  /** Every row with a video in the From–To range, copy or not — what "Attach videos" works on. */
  const rangeKeys = rowsBetween(rangeRows, parseFromRow(fromRow), parseFromRow(toRow), fromTabInUse);
  /** Ticked but not on screen. Left unsaid, the count above looks like a bug. */
  const pickedOffScreen = pickedRows.length - filteredVideos.filter((v) => picked.has(v.tab + ':' + v.row)).length;

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
            <VideoRegister />
          <VideoPrepare result={shown ? results[shown] ?? null : null} batch={liveTally} batchReasons={liveReasons} batchRows={liveRows} batchRunning={running} onJump={jumpToRow} />
            <section style={{ ...card, padding: 0, overflow: 'hidden' }}>
              {ids && <SheetFrame id={ids.videos} title="Distribución RRSS CHI" height={sheetHeight - 60} />}
            </section>
            <section style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, fontSize: 15 }}>Videos {videos ? '(' + videos.entries.length + ')' : ''}</h2>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search row number, title, copy, creator…" style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)', fontSize: 13, minWidth: 240 }} />
                  <button type="button" style={ghost} disabled={running} onClick={() => load('videos', true)}>Refresh</button>
                </div>
              </div>

              {/*
                "From row N to the end": one press ticks a whole section of the
                sheet — every row at or after N that still needs copy — so a
                month's worth of videos can go into the batch without thirty
                searches. Adds to the basket; never clears what was ticked.
              */}
              {videos && tabsWithWork.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>From row</span>
                    <input
                      ref={fromRef}
                      value={fromRow}
                      onChange={(e) => setFromRow(e.target.value.replace(/[^0-9]/g, ''))}
                      onBlur={(e) => setFromRow(e.target.value.replace(/[^0-9]/g, ''))}
                      onFocus={(e) => setFromRow(e.target.value.replace(/[^0-9]/g, ''))}
                      autoComplete="off"
                      inputMode="numeric"
                      placeholder="179"
                      aria-label="First row to select"
                      disabled={running}
                      style={{ width: 64, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)', fontSize: 13 }}
                    />
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span>to</span>
                    <input
                      ref={toRef}
                      value={toRow}
                      onChange={(e) => setToRow(e.target.value.replace(/[^0-9]/g, ''))}
                      onBlur={(e) => setToRow(e.target.value.replace(/[^0-9]/g, ''))}
                      onFocus={(e) => setToRow(e.target.value.replace(/[^0-9]/g, ''))}
                      autoComplete="off"
                      inputMode="numeric"
                      placeholder="end"
                      aria-label="Last row to select (empty = to the end)"
                      disabled={running}
                      style={{ width: 64, padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)', fontSize: 13 }}
                    />
                  </label>
                  {tabsWithWork.length > 1 && (
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span>on</span>
                      <select value={fromTabInUse} onChange={(e) => setFromTab(e.target.value)} disabled={running} aria-label="Tab" style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid rgba(0,0,0,0.12)', fontSize: 13 }}>
                        {tabsWithWork.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </label>
                  )}
                  {/*
                    ONE button for the range. "Attach videos" already covers
                    what a separate "select to prepare" led to: per row,
                    lib/attach-plan.ts picks one of three existing paths —
                    prepare a row with no copy (the same Prepare as the ticked
                    batch), queue copy already written, or attach to posts
                    still waiting for the video — and rows that already carry
                    it are reported as done without a call. Ticking rows by
                    hand (the header checkbox, "Prepare N videos") is untouched.
                  */}
                  {/*
                    NEVER disabled on a value the page cannot trust. The browser
                    can put "179" back into the box after a reload without
                    telling React, so the state said "empty" while the screen
                    said 179 and the button sat grey under a hint asking for a
                    row that was plainly there. The press reads the boxes
                    themselves, adopts what they show, and runs on that.
                  */}
                  <button
                    type="button"
                    style={{ ...btn, opacity: videos && !running ? 1 : .6 }}
                    disabled={running || !videos}
                    onClick={() => {
                      const f = String(fromRef.current?.value ?? fromRow).replace(/[^0-9]/g, '');
                      const t = String(toRef.current?.value ?? toRow).replace(/[^0-9]/g, '');
                      if (f !== fromRow) setFromRow(f);
                      if (t !== toRow) setToRow(t);
                      const from = parseFromRow(f);
                      if (from == null) {
                        setSummary('Type the first row in the “From row” box, then press Attach videos.');
                        fromRef.current?.focus();
                        return;
                      }
                      const keys = rowsBetween(rangeRows, from, parseFromRow(t), fromTabInUse);
                      if (!keys.length) {
                        setSummary('No row with a video between ' + from + ' and ' + (parseFromRow(t) ?? 'the end') + (tabsWithWork.length > 1 ? ' on ' + fromTabInUse : '') + '.');
                        return;
                      }
                      void attachRange(keys);
                    }}
                    title="Every draft in this range ends up with its video: rows with no copy are prepared, rows with copy are queued with the video unchanged, drafts waiting for their video get it. Nothing publishes."
                  >
                    {running ? 'Working…' : parseFromRow(fromRow) == null || !rangeKeys.length
                      ? 'Attach videos'
                      : 'Attach videos · ' + Math.min(rangeKeys.length, BATCH_MAX) + ' row' + (Math.min(rangeKeys.length, BATCH_MAX) === 1 ? '' : 's')}
                  </button>
                  <span style={{ opacity: .6 }}>
                    {parseFromRow(fromRow) == null
                      ? 'Every row with a video from the first row (to the last, if you give one) gets its draft and its video; nothing publishes.'
                      : 'Rows ' + parseFromRow(fromRow) + ' to ' + (parseFromRow(toRow) ?? 'the end') + (tabsWithWork.length > 1 ? ' on ' + fromTabInUse : '') + ': ' +
                        rangeKeys.length + ' with a video' + (fromRowKeys.length ? ', ' + fromRowKeys.length + ' still without copy (prepared first)' : '') + '.'}
                    {rangeKeys.length > BATCH_MAX ? ' The first ' + BATCH_MAX + ' run now; press again for the rest.' : ''}
                  </span>
                </div>
              )}
              {/*
                Only when something is ticked. An empty toolbar sitting above
                the table every time would be a permanent reminder of a feature
                nobody is using right now.
              */}
              {pickedRows.length > 0 && (
                <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 10, background: '#eef3ff', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>
                    {pickedRows.length} selected
                    {pickedOffScreen > 0 && <span style={{ fontWeight: 400, opacity: .75 }}> · {pickedOffScreen} not in this view</span>}
                  </strong>
                  {/*
                    A basket built by searching one row number after another is invisible
                    by construction: every search hides what was ticked under the last
                    one. This is how you look at the whole of it before spending money on
                    it.
                  */}
                  {pickedRows.length > 0 && (
                    <button type="button" style={ghost} onClick={() => { setOnlyPicked(!onlyPicked); if (!onlyPicked) setQ(''); }}>
                      {onlyPicked ? 'Show all rows' : 'Show only selected'}
                    </button>
                  )}
                  <button
                    type="button"
                    style={{ ...btn, opacity: running ? .6 : 1 }}
                    disabled={running}
                    onClick={() => void prepareSelected(pickedRows.slice(0, BATCH_MAX))}
                  >
                    {running ? 'Preparing…' : 'Prepare ' + Math.min(pickedRows.length, BATCH_MAX) + ' video' + (Math.min(pickedRows.length, BATCH_MAX) === 1 ? '' : 's')}
                  </button>
                  {running && (
                    <button type="button" style={ghost} onClick={() => { stopRef.current = true; }}>
                      Stop after this one
                    </button>
                  )}
                  {!running && <button type="button" style={ghost} onClick={() => { setPicked(new Set()); setBatch({}); }}>Clear</button>}
                  {/*
                    Stated as a sentence, not a bare tick. This setting is remembered
                    between visits, so the one failure mode is a choice made last week
                    quietly governing this run — which a checkbox label does not prevent
                    and a plain statement of what will happen does.
                  */}
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: running ? 'default' : 'pointer' }}>
                    <input type="checkbox" disabled={running} checked={sheetOnly} onChange={(e) => setSheetOnly(e.target.checked)} />
                    <span style={sheetOnly ? { fontWeight: 600, color: '#1d6f42' } : undefined}>
                      {sheetOnly
                        ? 'Writing the sheet only — nothing will reach Metricool'
                        : 'Write the sheet only (no Metricool drafts)'}
                    </span>
                  </label>
                  <span style={{ fontSize: 11, opacity: .75 }}>
                    {BATCH_CONCURRENCY} at a time — about a minute each, so roughly {Math.max(1, Math.ceil(Math.min(pickedRows.length, BATCH_MAX) / BATCH_CONCURRENCY))} minute(s) for this lot.
                  </span>
                  {pickedRows.length > BATCH_MAX && (
                    <span style={{ fontSize: 11, color: '#8a6d00' }}>
                      The first {BATCH_MAX} only: past that the hourly limit starts refusing them. Run it again for the rest.
                    </span>
                  )}
                  {(summary || (!running && liveSummary)) && <span style={{ fontSize: 12, fontWeight: 600 }}>{summary || liveSummary}</span>}
                  {pickedWithCopy > 0 && (
                    <span style={{ fontSize: 11, color: '#8a6d00' }}>
                      {pickedWithCopy} of these already {pickedWithCopy === 1 ? 'has' : 'have'} copy. Copy already written is never overwritten, so {pickedWithCopy === 1 ? 'it' : 'they'} will cost a run and change nothing.
                    </span>
                  )}
                </div>
              )}
              {!videos ? <p style={{ fontSize: 13, opacity: .6 }}>Reading the sheet…</p>
                : shownVideos.length === 0 ? <p style={{ fontSize: 13, opacity: .6 }}>{onlyPicked ? 'Nothing selected in this view.' : 'No videos match.'}</p>
                : (
                  <div style={{ overflowX: 'auto', marginTop: 12 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ textAlign: 'left', opacity: .6 }}>
                          <th style={{ padding: '6px 8px', width: 28 }}>
                            {/*
                              Ticks the rows that are WORK — a link and no copy
                              yet. Ticking everything visible would include the
                              hundred rows a person already wrote, and preparing
                              those spends money to produce copy that is then
                              correctly refused, because a filled cell is never
                              overwritten.
                            */}
                            <input
                              type="checkbox"
                              aria-label="Select every row that still needs copy"
                              disabled={running}
                              checked={readyToPrepare.length > 0 && readyToPrepare.every((v) => picked.has(v.tab + ':' + v.row))}
                              onChange={(e) => setPicked((prev) => {
                                // Adds and removes only what is ON SCREEN. It used to
                                // replace the whole set, so ticking it after a search
                                // threw away every pick made under a previous one.
                                const next = new Set(prev);
                                for (const v of readyToPrepare) {
                                  const k = v.tab + ':' + v.row;
                                  if (e.target.checked) next.add(k); else next.delete(k);
                                }
                                return next;
                              })}
                            />
                          </th>
                          <th style={{ padding: '6px 8px' }}>Row · Title</th><th style={{ padding: '6px 8px' }}>Copy</th><th style={{ padding: '6px 8px' }}>Format</th><th style={{ padding: '6px 8px' }}>Networks</th><th style={{ padding: '6px 8px' }}>By</th><th style={{ padding: '6px 8px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownVideos.map((v, i) => (
                          <Fragment key={i}>
                          <tr id={'video-row-' + v.tab + ':' + v.row} style={{ borderTop: '1px solid rgba(0,0,0,0.08)', verticalAlign: 'top' }}>
                            <td style={{ padding: '8px' }}>
                              {prepareLink(v) && (
                                <input
                                  type="checkbox"
                                  aria-label={'Select row ' + v.row}
                                  disabled={running}
                                  checked={picked.has(v.tab + ':' + v.row)}
                                  onChange={() => togglePick(v)}
                                />
                              )}
                            </td>
                            <td style={{ padding: '8px' }}>
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                {/*
                                  The row's number IN THE SHEET. The dashboard's
                                  own ordering is not the sheet's, so "the third
                                  one down" meant two different rows depending on
                                  which window you were looking at. This is the
                                  reference both sides share.
                                */}
                                <span
                                  title={'Row ' + v.row + ' on the “' + v.tab + '” tab'}
                                  style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11, fontWeight: 700, color: '#1d4ed8', background: '#eef3ff', borderRadius: 6, padding: '1px 6px', whiteSpace: 'nowrap' }}
                                >{v.row}</span>
                                <span style={{ fontWeight: 600 }}>{v.title || v.type || '—'}</span>
                              </div>
                              <div style={{ opacity: .6 }}>{[v.type, v.month, v.tab].filter(Boolean).join(' · ')}</div>
                              {v.videoLink && <a href={v.videoLink.split(/\s+/).find((x) => /^https?:/.test(x)) || v.videoLink} target="_blank" rel="noreferrer">open video ↗</a>}
                            </td>
                            <td style={{ padding: '8px', maxWidth: 380 }}><div style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden', opacity: .85 }}>{v.copy || '—'}</div></td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{v.format || '—'}</td>
                            <td style={{ padding: '8px' }}><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{v.networks.map((n) => <span key={n} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 999, background: '#eef3ff', color: '#1d4ed8' }}>{n}</span>)}</div></td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>{v.creator || '—'}</td>
                            <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                              <div style={{ display: 'grid', gap: 6 }}>
                                {prepareLink(v) && (
                                  <button type="button" style={btn} onClick={() => prepare(v)} title="Transcript → keywords → LinkedIn + TikTok copy">Prepare</button>
                                )}
                                {Boolean(parseDriveFileId(firstLink(v))) && (
                                  <button
                                    type="button"
                                    style={{ ...ghost, fontSize: 11, padding: '4px 10px' }}
                                    disabled={Boolean(diagnosing)}
                                    onClick={() => void diagnose(v)}
                                    title="Checks the size, the copy, the host, and whether a whole-file pull actually works — the way Metricool fetches it"
                                  >{diagnosing === rowKey(v) ? 'Checking…' : 'Check the video'}</button>
                                )}
                                {/* The video comes WITH the copy when there is a fetchable version of it.
    Without one this used to append `Watch: <Drive link>` instead, which is
    private — so the post shipped a link most readers cannot open. Now it
    either attaches the video or says plainly what makes one. */}
{(() => {
  // "Use in post" used to hand over the caption and an EMPTY media slot on any
  // row that had never been prepared. From the outside that is a broken button:
  // the text arrives, the video does not, nothing says why. It now makes the
  // shareable copy on the spot — the label says so before you press it, and the
  // copy is made once per video and remembered.
  const ready = Boolean(shareableFor(v));
  const hasDriveVideo = Boolean(parseDriveFileId(firstLink(v)));
  const working = attaching === rowKey(v);
  const yt = youtubeOf(v);
  return (
    <button
      type="button"
      style={{ ...ghost, opacity: working ? .6 : 1 }}
      disabled={working}
      title={
        !hasDriveVideo ? 'This row has no Drive video, so the post goes out as text'
          : ready ? 'Brings the caption and the video into the composer'
          : 'Makes a shareable copy of the video, then brings both into the composer'
      }
      onClick={() => void sendToComposer(v, yt)}
    >{working ? 'Attaching the video…' : hasDriveVideo ? 'Use in post · with video' : 'Use in post'}</button>
  );
})()}
                                <button type="button" style={{ ...ghost, padding: '5px 10px' }} onClick={() => setEditing(editing === v.tab + ':' + v.row ? null : v.tab + ':' + v.row)}>
                                  {editing === v.tab + ':' + v.row ? 'Close' : 'Edit'}
                                </button>
                                {batch[v.tab + ':' + v.row] && (
                                  <span style={{ fontSize: 11, whiteSpace: 'normal', color: BATCH_COLOUR[batch[v.tab + ':' + v.row].state] }}>
                                    {BATCH_LABEL[batch[v.tab + ':' + v.row].state]}
                                    {batch[v.tab + ':' + v.row].note ? ' — ' + batch[v.tab + ':' + v.row].note : ''}
                                    {/* Stepping through a finished batch, one row at a time — the page
                                        moves because the person asked it to, not on its own. */}
                                    {results[v.tab + ':' + v.row] && (
                                      <>
                                        {' '}
                                        <button
                                          type="button"
                                          onClick={() => showResult(v.tab + ':' + v.row)}
                                          style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: '#0071e3', cursor: 'pointer', textDecoration: 'underline' }}
                                        >
                                          See full result ↑
                                        </button>
                                      </>
                                    )}
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                          {editing === v.tab + ':' + v.row && (
                            <tr>
                              <td colSpan={7} style={{ padding: '4px 8px 14px', background: 'rgba(0,0,0,0.02)' }}>
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
                          {diagnosis && diagnosis.row === rowKey(v) && (
                            <tr>
                              <td colSpan={7} style={{ padding: '10px 12px', background: '#fffbe6', borderTop: '1px solid rgba(0,0,0,0.08)' }}>
                                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>What this row&rsquo;s video actually does</div>
                                <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
                                  {diagnosis.findings.map((f, fi) => (
                                    <li key={fi} style={{ fontSize: 12, color: /TRUNCATES|REFUSED|FAILED|cannot/.test(f) ? '#8a2a00' : '#333' }}>{f}</li>
                                  ))}
                                </ul>
                                <button type="button" style={{ ...ghost, marginTop: 8, fontSize: 11, padding: '3px 9px' }} onClick={() => setDiagnosis(null)}>Close</button>
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
            {/*
              Every video that has drafts, one line each, with a batch Approve.
              The Prepare panel at the top shows ONE result; this, at the very
              bottom — below the sheet and the Videos table — is everything that
              was clicked, with its drafts, ready to release together.
            */}
            <PreparedBoard
              videoLinks={Object.fromEntries((videos?.entries || []).map((v) => [rowKey(v), prepareLink(v)]))}
              recentKeys={Object.keys(batch)}
            />
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
