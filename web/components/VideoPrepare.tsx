'use client';

// Video Library → publish-ready: paste (or pick) a link — a YouTube video, or
// the Drive .mp4 the sheet holds — and one button runs transcript → keywords →
// copy. What comes back is editable here, then sent to Metricool as drafts for
// LinkedIn and TikTok. Approve on the dashboard is still what publishes.
//
// The same work runs on its own when a new link appears in the sheet
// (lib/video-autopilot.ts); this is the manual door onto it, for a video
// somebody wants done now.

import { useEffect, useMemo, useState } from 'react';
import { friendlyErrorFromResponse } from '@/lib/friendly-error';
import { parseVideoUrl } from '@/lib/composer';
import { isDriveUrl } from '@/lib/drive-url';
import { fitsNetwork } from '@/lib/video-row';

type Prepared = {
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
};

type ClipOption = { label: string; url: string };

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

export default function VideoPrepare({ initialUrl, blogId }: { initialUrl?: string; blogId?: string }) {
  const [url, setUrl] = useState(initialUrl || '');
  const [pasted, setPasted] = useState('');
  const [needPaste, setNeedPaste] = useState<string | null>(null);
  const [busy, setBusy] = useState<'prepare' | 'send' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [linkedin, setLinkedin] = useState('');
  const [tiktok, setTiktok] = useState('');
  const [clips, setClips] = useState<ClipOption[]>([]);
  const [clipUrl, setClipUrl] = useState('');
  const [when, setWhen] = useState(defaultWhen());
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => { if (initialUrl) { setUrl(initialUrl); setPrepared(null); setSent(null); setErr(null); } }, [initialUrl]);

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
    setBusy('prepare'); setErr(null); setSent(null); setNeedPaste(null);
    try {
      const r = await fetch('/api/videos/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, transcript: pasted || undefined }) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 422 && j?.error === 'no_transcript') { setNeedPaste(j.message || 'No captions on this video — paste the transcript.'); return; }
      if (!r.ok) { setErr(await friendlyErrorFromResponse(new Response(JSON.stringify(j), { status: r.status, headers: { 'content-type': 'application/json' } }), 'We could not prepare that video.')); return; }
      setPrepared(j); setLinkedin(j.linkedin || ''); setTiktok(j.tiktok || '');
    } catch {
      setErr('We could not prepare that video just now.');
    } finally {
      setBusy(null);
    }
  }

  async function send(network: 'linkedin' | 'tiktok') {
    const text = network === 'linkedin' ? linkedin : tiktok;
    if (!text.trim()) { setErr('Write the ' + network + ' copy first.'); return; }
    // Metricool would refuse it anyway, and the REF and AVISO lines are at the
    // end — so this is shortened by a person, never trimmed by the app.
    const fit = fitsNetwork(network, text);
    if (!fit.ok) { setErr('That copy is ' + fit.length + ' characters and ' + network + ' accepts ' + fit.limit + '. Shorten it first.'); return; }
    if (network === 'tiktok' && !clipUrl) { setErr('TikTok needs a vertical clip — pick one, or cut clips first under Draft → Long-form to Shorts.'); return; }
    setBusy('send'); setErr(null);
    try {
      const r = await fetch('/api/metricool/schedule', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network, text, publishAt: when, blogId, mediaUrl: network === 'tiktok' ? clipUrl : undefined, draftId: prepared?.draftId || undefined }),
      });
      if (!r.ok) { setErr(await friendlyErrorFromResponse(r, 'Metricool did not accept that post.')); return; }
      setSent((s) => (s ? s + ' · ' : '') + (network === 'linkedin' ? 'LinkedIn' : 'TikTok') + ' saved as a draft in your queue — press Approve there to publish.');
    } catch {
      setErr('We could not reach Metricool just now.');
    } finally {
      setBusy(null);
    }
  }

  const cite = prepared?.compliance?.citation;

  return (
    <section style={card} id="video-prepare">
      <h2 style={{ margin: 0, fontSize: 15 }}>Prepare a video for LinkedIn and TikTok</h2>
      <p style={{ fontSize: 12, opacity: .65, margin: '4px 0 12px' }}>Paste a YouTube or Google Drive link (or press Prepare on a row above). The dashboard pulls the transcript — captions on YouTube, speech-to-text on a Drive file — runs the keyword brief, writes the copy from what was actually said, and lets you edit before anything reaches Metricool.</p>
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
      {err && <div role="alert" style={{ color: '#d70015', fontSize: 12, marginTop: 8 }}>{err}</div>}

      {prepared && (
        <div style={{ marginTop: 16, display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
            <span style={{ background: '#eaf7ee', color: '#1f6b3a', borderRadius: 999, padding: '3px 9px' }}>✓ Transcript · {prepared.transcript.source === 'youtube' ? 'YouTube captions' : prepared.transcript.source === 'drive' ? 'transcribed from the video' : 'pasted'}{prepared.transcript.language ? ' · ' + prepared.transcript.language : ''} · {prepared.transcript.chars.toLocaleString()} chars</span>
            <span style={{ background: prepared.hasKeywords ? '#eaf7ee' : '#fff2f2', color: prepared.hasKeywords ? '#1f6b3a' : '#a1252b', borderRadius: 999, padding: '3px 9px' }}>{prepared.hasKeywords ? '✓ Keywords · ' + (prepared.keywords?.primary || '') : '⚠ NO keyword data — this copy was written without it'}</span>
            <span style={{ background: cite?.status === 'verified' ? '#eaf7ee' : '#fff8e6', color: cite?.status === 'verified' ? '#1f6b3a' : '#8a5a00', borderRadius: 999, padding: '3px 9px' }}>{cite?.status === 'verified' ? '✓ Citation verified' : 'Citation — check the REF line'}</span>
          </div>
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
            <label style={{ fontSize: 12 }}>Vertical clip for TikTok
              <select style={{ ...inputStyle, marginTop: 6 }} value={clipUrl} onChange={(e) => setClipUrl(e.target.value)}>
                <option value="">{clips.length ? 'Pick a clip…' : 'No clips yet — cut some under Draft → Long-form to Shorts'}</option>
                {clips.map((c) => <option key={c.url} value={c.url}>{c.label}</option>)}
              </select>
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button type="button" style={btn} disabled={busy === 'send'} onClick={() => void send('linkedin')}>Send LinkedIn to Metricool for review</button>
            <button type="button" style={btn} disabled={busy === 'send' || !clipUrl} title={clipUrl ? undefined : 'Pick a vertical clip first'} onClick={() => void send('tiktok')}>Send TikTok to Metricool for review</button>
            <a href="/draft#section-repurpose" style={{ ...ghost, textDecoration: 'none' }}>Cut clips from this video ↗</a>
          </div>
          {sent && <div role="status" style={{ fontSize: 12, color: '#1f6b3a' }}>{sent}</div>}
          <p style={{ fontSize: 11, opacity: .6, margin: 0 }}>Both land as drafts in your publishing queue. Nothing publishes until you press Approve. The copy is also saved under Recent Drafts.</p>
        </div>
      )}
    </section>
  );
}
