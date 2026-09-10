'use client';

// Video Library → publish-ready: paste (or pick) a link — a YouTube video, or
// the Drive .mp4 the sheet holds — and one button runs transcript → keywords →
// copy. What comes back is editable here, then sent to Metricool as drafts for
// YouTube, LinkedIn and TikTok — each carrying the video itself, not a link to
// a private Drive file. Approve on the dashboard is still what publishes.
//
// The same work runs on its own when a new link appears in the sheet
// (lib/video-autopilot.ts); this is the manual door onto it, for a video
// somebody wants done now.

import { useEffect, useMemo, useState } from 'react';
import { friendlyErrorFromResponse } from '@/lib/friendly-error';
import { runPrepare } from '@/lib/prepare-request';
import { parseVideoUrl } from '@/lib/composer';
import { isDriveUrl } from '@/lib/drive-url';
import { fitsNetwork } from '@/lib/video-row';
import type { BatchReasons } from '@/lib/batch-plan';

export type Prepared = {
  draftId: string | null;
  title: string;
  videoId: string;
  transcript: { source: string; language: string | null; chars: number; preview: string };
  keywords: { primary?: string | null; keywords?: string[]; source?: string } | null;
  keywordLine?: string;
  ref?: string;
  hasKeywords?: boolean;
  compliance: { citation?: { status?: string; title?: string | null } } | null;
  linkedin: string;
  tiktok: string;
  /**
   * A world-readable copy of the video, made once per Drive file when the row
   * was completed. It is what the Send buttons attach: the source file in the
   * clinic's Drive is private, so a network handed that link gets nothing.
   * Null for a YouTube source, or when the row was prepared without a hand-off.
   */
  mediaUrl?: string | null;
  /** What was written back to the sheet, when Prepare was pressed on a row. */
  sheet?: { wrote?: Record<string, boolean>; metricool?: { network: string; ok: boolean; message?: string }[]; status?: string } | { error: string } | null;
};

type ClipOption = { label: string; url: string };

/** The three feeds a finished video goes to, matching lib/video-slot.ts's default. */
type VideoNetwork = 'youtube' | 'linkedin' | 'tiktok';
const VIDEO_NETWORKS: VideoNetwork[] = ['youtube', 'linkedin', 'tiktok'];
const LABEL: Record<VideoNetwork, string> = { youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok' };
/** Feeds that will not take a text-only post. LinkedIn will, so it is not here. */
const NEEDS_MEDIA = new Set<VideoNetwork>(['youtube', 'tiktok']);

const card: React.CSSProperties = { background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: 20 };
const inputStyle: React.CSSProperties = { width: '100%', padding: 9, borderRadius: 8, background: '#f5f5f7', border: '1px solid rgba(0,0,0,0.1)', color: '#1d1d1f', boxSizing: 'border-box', fontSize: 13 };
const btn: React.CSSProperties = { background: '#0071e3', color: '#fff', border: 'none', borderRadius: 999, padding: '8px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const ghost: React.CSSProperties = { ...btn, background: 'transparent', color: '#0071e3', border: '1px solid rgba(0,113,227,0.35)' };

/** Characters used against what the network accepts — red once it will be refused. */
function Counter({ network, text }: { network: string; text: string }) {
  const fit = fitsNetwork(network, text);
  return (
    <span style={{ fontWeight: 400, opacity: fit.ok ? .55 : 1, color: fit.ok ? undefined : '#d70015' }}>
      · {fit.length}/{fit.limit}{fit.ok ? '' : ' — too long to send'}
    </span>
  );
}

function defaultWhen(): string {
  const d = new Date(Date.now() + 24 * 3600e3);
  d.setMinutes(0, 0, 0); d.setHours(9);
  const pad = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

export type BatchTally = {
  total: number;
  done: number;
  failed: number;
  needsTranscript: number;
  pending: number;
};

export default function VideoPrepare({ initialUrl, blogId, sheetRow, result, batch, batchReasons, batchRunning }: {
  initialUrl?: string;
  blogId?: string;
  /**
   * A result produced somewhere ELSE — a row in the gallery below preparing
   * itself — for this panel to display.
   *
   * The gallery's Prepare button used to load a link up here and scroll, so
   * the panel did the work and showed the outcome. It now runs the work on the
   * row instead, and without this the whole outcome (transcript, keywords,
   * REF, sheet status, both drafts, the Metricool buttons) was replaced by a
   * one-line label. The response shapes already agree — runPrepare returns
   * exactly what this panel sets its own state from — so the result only ever
   * needed handing over.
   */
  result?: Prepared | null;
  /** The row this was pressed from, so the copy goes back where the link was. */
  sheetRow?: { tab: string; row: number };
  /**
   * How a batch running further down the page is getting on.
   *
   * It is reported HERE because this panel is where a person watches a Prepare happen, and
   * the batch bar is about a thousand pixels below it, past an embedded sheet — far enough
   * that somebody ran a batch, saw nothing change, and thought it had not started.
   */
  batch?: BatchTally | null;
  /**
   * Why the rows that did not finish did not finish.
   *
   * The counts alone sent people to the table below to find out — which is a
   * thousand pixels down, past an embedded spreadsheet. A summary that knows
   * the answer should say it.
   */
  batchReasons?: BatchReasons | null;
  batchRunning?: boolean;
}) {
  const [url, setUrl] = useState(initialUrl || '');
  const [pasted, setPasted] = useState('');
  const [needPaste, setNeedPaste] = useState<string | null>(null);
  const [busy, setBusy] = useState<'prepare' | 'send' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Progress, not failure: the transcript landed and the copy is being written. */
  const [note, setNote] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [linkedin, setLinkedin] = useState('');
  const [tiktok, setTiktok] = useState('');
  const [clips, setClips] = useState<ClipOption[]>([]);
  const [clipUrl, setClipUrl] = useState('');
  const [when, setWhen] = useState(defaultWhen());
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => { if (initialUrl) { setUrl(initialUrl); setPrepared(null); setSent(null); setErr(null); } }, [initialUrl]);

  // Show a result prepared elsewhere — a row in the gallery below.
  //
  // Adjusted during render rather than in an effect. This is the pattern React
  // documents for "reset state when a prop changes": an effect would render
  // once with the previous result, then set state, then render again, and the
  // person would see the last video's copy flash before this one's. Comparing
  // against the result already shown makes it a single render, and it is why
  // `shownResult` exists rather than a `useEffect` dependency array.
  const [shownResult, setShownResult] = useState<Prepared | null>(null);
  if (result && result !== shownResult) {
    setShownResult(result);
    setPrepared(result);
    setLinkedin(result.linkedin || '');
    setTiktok(result.tiktok || '');
    setSent(null);
    setErr(null);
  }

  const parsed = useMemo(() => parseVideoUrl(url), [url]);
  // A Drive .mp4 is transcribed by speech-to-text; a YouTube link uses its own
  // caption track. Both are prepared here — the sheet holds Drive links.
  const drive = useMemo(() => isDriveUrl(url), [url]);
  const urlOk = (parsed.ok && parsed.source === 'YouTube') || drive;

  // Vertical clips already cut from this video (Long-form to Shorts) — the
  // only thing TikTok can take.
  useEffect(() => {
    if (!prepared) return;
    let alive = true;
    fetch('/api/drafts?limit=100').then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!alive) return;
      const rows: any[] = Array.isArray(j?.drafts) ? j.drafts : Array.isArray(j) ? j : [];
      const opts: ClipOption[] = [];
      for (const d of rows) {
        const p = d?.pack;
        if (!p || p.kind !== 'clip' || !Array.isArray(p.clips)) continue;
        const sameVideo = typeof p.video === 'string' && p.video.includes(prepared.videoId);
        for (const c of p.clips) {
          const u = String(c?.export || c?.preview || '');
          if (!u) continue;
          opts.push({ label: (sameVideo ? '★ ' : '') + String(c?.title || 'Clip') + (d?.topic ? ' — ' + String(d.topic).slice(0, 40) : ''), url: u });
        }
      }
      opts.sort((a, b) => (b.label.startsWith('★') ? 1 : 0) - (a.label.startsWith('★') ? 1 : 0));
      setClips(opts);
      if (opts[0]?.label.startsWith('★')) setClipUrl(opts[0].url);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [prepared]);

  async function prepare() {
    if (!urlOk) { setErr('Paste a YouTube or Google Drive video link first.'); return; }
    setBusy('prepare'); setErr(null); setSent(null); setNeedPaste(null); setNote(null);
    const out = await runPrepare(
      { url, tab: sheetRow?.tab, row: sheetRow?.row, transcript: pasted || undefined },
      setNote,
    );
    setBusy(null); setNote(null);
    if (!out.ok) {
      if (out.kind === 'needs_transcript') setNeedPaste(out.message); else setErr(out.message);
      return;
    }
    const j = out.data as unknown as Prepared;
    setPrepared(j); setLinkedin(j.linkedin || ''); setTiktok(j.tiktok || '');
  }

  // The video goes with the copy, to every network.
  //
  // Only TikTok used to carry it, and only from a hand-cut clip — so a LinkedIn
  // draft went out as text and YouTube had no button at all. The clip picker is
  // now an OVERRIDE: pick one and that is what is sent; leave it empty and the
  // public copy the row already made is sent instead.
  const media = clipUrl || prepared?.mediaUrl || '';

  async function send(network: VideoNetwork) {
    // YouTube carries the long-form wording; TikTok the short caption.
    const text = network === 'tiktok' ? tiktok : linkedin;
    if (!text.trim()) { setErr('Write the ' + LABEL[network] + ' copy first.'); return; }
    // Metricool would refuse it anyway, and the REF and AVISO lines are at the
    // end — so this is shortened by a person, never trimmed by the app.
    const fit = fitsNetwork(network, text);
    if (!fit.ok) { setErr('That copy is ' + fit.length + ' characters and ' + LABEL[network] + ' accepts ' + fit.limit + '. Shorten it first.'); return; }
    // A video feed with no video is a draft that fails at Metricool rather than
    // here, which is a worse place to find out.
    if (NEEDS_MEDIA.has(network) && !media) {
      setErr(LABEL[network] + ' needs the video. Prepare the row first so the shareable copy is made, or pick a vertical clip below.');
      return;
    }
    setBusy('send'); setErr(null);
    try {
      const r = await fetch('/api/metricool/schedule', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network, text, publishAt: when, blogId, mediaUrl: media || undefined, draftId: prepared?.draftId || undefined }),
      });
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'Metricool did not accept that post.')); return; }
      setSent((s) => (s ? s + ' · ' : '') + LABEL[network] + ' saved as a draft in your queue — press Approve there to publish.');
    } catch {
      setErr('We could not reach Metricool just now.');
    } finally {
      setBusy(null);
    }
  }

  const cite = prepared?.compliance?.citation;

  return (
    <section style={card} id="video-prepare">
      <h2 style={{ margin: 0, fontSize: 15 }}>Prepare a video for YouTube, LinkedIn and TikTok</h2>
      {/*
        This used to end "…and lets you edit before anything reaches Metricool", which is
        not what happens. A link that matches a row in the sheet — which a pasted one now
        does, by file id — goes through completeRow: the copy is written into column E and
        the drafts are created BEFORE these boxes render. The panel below then says so, two
        lines after the promise that it hadn't. Editing here changes what you send with the
        buttons at the bottom; it does not change a draft already queued.
      */}
      <p style={{ fontSize: 12, opacity: .65, margin: '4px 0 12px' }}>Paste a YouTube or Google Drive link (or press Prepare on a row above). The dashboard pulls the transcript — captions on YouTube, speech-to-text on a Drive file — runs the keyword brief, and writes the copy from what was actually said. <strong>If the link matches a row in the sheet, the copy is written into that row and a Metricool draft is created straight away</strong> — the panel below says exactly what happened. Nothing publishes: a draft waits in Metricool until someone approves it.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input id="video-url" style={{ ...inputStyle, flex: 1, minWidth: 260 }} value={url} onChange={(e) => { setUrl(e.target.value); setPrepared(null); setSent(null); }} placeholder="https://www.youtube.com/watch?v=… or https://drive.google.com/file/d/…" />
        <button type="button" style={btn} disabled={busy === 'prepare' || !urlOk} onClick={() => void prepare()}>{busy === 'prepare' ? 'Preparing…' : 'Prepare'}</button>
      </div>
      {url && !urlOk && <div style={{ fontSize: 12, color: '#d70015', marginTop: 6 }}>Paste a YouTube link or a Google Drive video link.</div>}
      {needPaste && (
        <div role="alert" style={{ marginTop: 10, background: '#fff8e6', border: '1px solid #f0c36d', borderRadius: 10, padding: 12, fontSize: 12 }}>
          <div style={{ fontWeight: 600 }}>{needPaste}</div>
          <textarea style={{ ...inputStyle, marginTop: 8, minHeight: 120 }} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="Paste the transcript here, then press Prepare again." />
        </div>
      )}
      {batch && batch.total > 0 && (
        <div role="status" style={{ marginTop: 10, padding: '9px 11px', borderRadius: 10, background: batchRunning ? '#eef3ff' : '#f6f7f9', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11 }}>
          <strong style={{ fontSize: 12 }}>
            {batchRunning ? 'Preparing ' + batch.total + ' videos…' : 'Last run · ' + batch.total + ' videos'}
          </strong>
          {/* The same pills, and the same three colours, the single-run badges below use. */}
          {batch.done > 0 && <span style={{ background: '#eaf7ee', color: '#1f6b3a', borderRadius: 999, padding: '3px 9px' }}>✓ {batch.done} written into the sheet</span>}
          {batch.pending > 0 && <span style={{ background: '#eef3ff', color: '#1d4ed8', borderRadius: 999, padding: '3px 9px' }}>{batch.pending} to go</span>}
          {batch.needsTranscript > 0 && <span style={{ background: '#fff8e6', color: '#8a5a00', borderRadius: 999, padding: '3px 9px' }}>{batch.needsTranscript} need a transcript</span>}
          {batch.failed > 0 && <span style={{ background: '#fff2f2', color: '#a1252b', borderRadius: 999, padding: '3px 9px' }}>✗ {batch.failed} not done</span>}
          {!batchReasons?.shown.length && (
            <span style={{ opacity: .7 }}>Row-by-row detail is in the Videos table below.</span>
          )}
        </div>
      )}
      {batch && batch.total > 0 && Boolean(batchReasons?.shown.length) && (
        <div style={{ marginTop: 6, display: 'grid', gap: 4, fontSize: 12, color: '#a1252b' }}>
          {batchReasons!.shown.map((r) => (<span key={r}>· {r}</span>))}
          {batchReasons!.more > 0 && (
            <span style={{ opacity: .7, color: '#555' }}>
              and {batchReasons!.more} other {batchReasons!.more === 1 ? 'reason' : 'reasons'} — the rest is in the Videos table below.
            </span>
          )}
        </div>
      )}
      {err && <div role="alert" style={{ color: '#d70015', fontSize: 12, marginTop: 8 }}>{err}</div>}
      {note && <div role="status" style={{ color: '#1d6f42', fontSize: 12, marginTop: 8 }}>{note}</div>}

      {prepared && (
        <div style={{ marginTop: 16, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
            <span style={{ background: '#eaf7ee', color: '#1f6b3a', borderRadius: 999, padding: '3px 9px' }}>✓ Transcript · {prepared.transcript.source === 'youtube' ? 'YouTube captions' : prepared.transcript.source === 'drive' ? 'transcribed from the video' : 'pasted'}{prepared.transcript.language ? ' · ' + prepared.transcript.language : ''} · {prepared.transcript.chars.toLocaleString()} chars</span>
            <span style={{ background: prepared.hasKeywords ? '#eaf7ee' : '#fff2f2', color: prepared.hasKeywords ? '#1f6b3a' : '#a1252b', borderRadius: 999, padding: '3px 9px' }}>{prepared.hasKeywords ? '✓ Keywords · ' + (prepared.keywords?.primary || '') : '⚠ NO keyword data — this copy was written without it'}</span>
            <span style={{ background: cite?.status === 'verified' ? '#eaf7ee' : '#fff8e6', color: cite?.status === 'verified' ? '#1f6b3a' : '#8a5a00', borderRadius: 999, padding: '3px 9px' }}>{cite?.status === 'verified' ? '✓ Citation verified' : 'Citation — check the REF line'}</span>
          </div>
          {prepared.sheet && 'error' in (prepared.sheet as object) && (
            <div role="alert" style={{ fontSize: 12, background: '#fff2f2', border: '1px solid #f2c2c2', borderRadius: 10, padding: 10, color: '#a1252b' }}>
              The copy is written and saved as a draft, but the sheet row could not be updated: {(prepared.sheet as { error: string }).error}
            </div>
          )}
          {prepared.sheet && !('error' in (prepared.sheet as object)) && (
            <div style={{ fontSize: 12, background: '#eaf7ee', border: '1px solid #bfe3cb', borderRadius: 10, padding: 10, color: '#1f6b3a' }}>
              ✓ Written into the sheet ({(prepared.sheet as { status?: string }).status || 'ready'}).{' '}
              {(() => {
                const posted = ((prepared.sheet as { metricool?: { network: string; ok: boolean; message?: string }[] }).metricool || []);
                const ok = posted.filter((p) => p.ok).map((p) => p.network);
                const bad = posted.filter((p) => !p.ok);
                return (
                  <>
                    {ok.length ? 'Drafts waiting in Metricool for ' + ok.join(', ') + '. ' : 'No Metricool draft was created. '}
                    {bad.map((b) => <span key={b.network} style={{ display: 'block', color: '#8a5a00' }}>{b.network}: {b.message}</span>)}
                  </>
                );
              })()}
            </div>
          )}
          {(prepared.keywordLine || prepared.ref) && (
            <div style={{ fontSize: 12, background: '#f7f7f9', border: '1px solid rgba(0,0,0,0.06)', borderRadius: 10, padding: 10, display: 'grid', gap: 6 }}>
              {prepared.keywordLine && <div><strong>Keywords</strong> <span style={{ opacity: .8 }}>{prepared.keywordLine}</span></div>}
              {prepared.ref && <div><strong>REF</strong> <span style={{ opacity: .8 }}>{prepared.ref}</span></div>}
              <div style={{ opacity: .55 }}>These are what the sweep writes into the sheet’s KEYWORDS and REF columns.</div>
            </div>
          )}
          <details style={{ fontSize: 12 }}>
            <summary style={{ cursor: 'pointer', opacity: .7 }}>Transcript preview — “{prepared.title}”</summary>
            <p style={{ opacity: .75, whiteSpace: 'pre-wrap', marginTop: 6 }}>{prepared.transcript.preview}…</p>
          </details>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
            <label style={{ fontSize: 12, fontWeight: 600 }}>LinkedIn post <Counter network="linkedin" text={linkedin} />
              <textarea id="video-linkedin" style={{ ...inputStyle, marginTop: 6, minHeight: 220, fontWeight: 400, lineHeight: 1.45 }} value={linkedin} onChange={(e) => setLinkedin(e.target.value)} />
            </label>
            <label style={{ fontSize: 12, fontWeight: 600 }}>TikTok caption <Counter network="tiktok" text={tiktok} />
              <textarea id="video-tiktok" style={{ ...inputStyle, marginTop: 6, minHeight: 220, fontWeight: 400, lineHeight: 1.45 }} value={tiktok} onChange={(e) => setTiktok(e.target.value)} />
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12, alignItems: 'end' }}>
            <label style={{ fontSize: 12 }}>When (clinic time)
              <input type="datetime-local" style={{ ...inputStyle, marginTop: 6 }} value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
            <label style={{ fontSize: 12 }}>Vertical clip (optional — overrides the video)
              <select style={{ ...inputStyle, marginTop: 6 }} value={clipUrl} onChange={(e) => setClipUrl(e.target.value)}>
                <option value="">{clips.length ? 'Pick a clip…' : 'No clips yet — cut some under Draft → Long-form to Shorts'}</option>
                {clips.map((c) => <option key={c.url} value={c.url}>{c.label}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {VIDEO_NETWORKS.map((n) => {
              const blocked = NEEDS_MEDIA.has(n) && !media;
              return (
                <button
                  key={n}
                  type="button"
                  style={btn}
                  disabled={busy === 'send' || blocked}
                  title={blocked ? 'Prepare the row first, or pick a vertical clip — ' + LABEL[n] + ' needs the video' : undefined}
                  onClick={() => void send(n)}
                >
                  Send {LABEL[n]} to Metricool for review
                </button>
              );
            })}
            <a href="/draft#section-repurpose" style={{ ...ghost, textDecoration: 'none' }}>Cut clips from this video ↗</a>
          </div>
          {sent && <div role="status" style={{ fontSize: 12, color: '#1f6b3a' }}>{sent}</div>}
          <p style={{ fontSize: 11, opacity: .6, margin: 0 }}>
            All three land as drafts in your publishing queue, each carrying the video{media ? '' : ' once the row has been prepared'}. Nothing publishes until you press Approve. The copy is also saved under Recent Drafts.
          </p>
        </div>
      )}
    </section>
  );
}
