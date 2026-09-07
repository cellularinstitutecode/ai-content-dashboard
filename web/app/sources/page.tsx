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

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import PageNav from '@/components/PageNav';
import { useWorkspace } from '@/components/workspace';
import { friendlyErrorFromResponse } from '@/lib/friendly-error';

type Tab = 'calendar' | 'videos' | 'images';

type CalendarEntry = { tab: string; date: string | null; type: string; caption: string; fileName: string; graphicsLink: string; status: string; networks: string[] };
type VideoEntry = { tab: string; creator: string; month: string; type: string; title: string; copy: string; videoLink: string; format: string; networks: string[]; thumbnailTitle: string; coverLink: string; notes: string };
type DriveImage = { id: string; name: string; mimeType: string; modifiedTime: string; size: number | null; viewUrl: string; thumbUrl: string };
type Status = { configured: boolean; serviceAccount: string | null; ids: { calendar: string; videos: string; images: string } };

const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: 'calendar', label: 'Social Calendar (Meriz)', blurb: 'The month-by-month post calendar. Edit it here exactly as in Google Sheets; the dashboard reads what is planned.' },
  { id: 'videos', label: 'Video Library (Rodrigo)', blurb: 'Every produced video with its copy, link and formats. Press "Use in post" to drop one into the Publishing composer.' },
  { id: 'images', label: 'Image Library', blurb: 'The team\'s photo and render folder. Press "Use as hero image" to attach a real clinic photo to a post.' },
];

const card: React.CSSProperties = { background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: 20 };
const btn: React.CSSProperties = { background: '#0071e3', color: '#fff', border: 'none', borderRadius: 999, padding: '7px 13px', cursor: 'pointer', fontSize: 12, fontWeight: 600 };
const ghost: React.CSSProperties = { ...btn, background: 'transparent', color: '#0071e3', border: '1px solid rgba(0,113,227,0.35)' };

function sheetEmbed(id: string): string {
  // widget=true / rm=minimal hide Google's own chrome; editors still edit in place.
  return 'https://docs.google.com/spreadsheets/d/' + id + '/edit?widget=true&headers=false&rm=minimal';
}
function sheetOpen(id: string): string {
  return 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
}

// The embedded editor with an escape hatch: browsers that block third-party
// cookies show the sheet signed-out inside the frame, and "Open in Google
// Sheets" is one click away either way.
function SheetFrame({ id, title, height }: { id: string; title: string; height: number }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid rgba(0,0,0,0.08)', fontSize: 12 }}>
        <span style={{ opacity: .7 }}>{title} — editing here is editing the real sheet.</span>
        <a href={sheetOpen(id)} target="_blank" rel="noreferrer" style={{ ...ghost, textDecoration: 'none' }}>Open in Google Sheets ↗</a>
      </div>
      <iframe title={title + ' (Google Sheets)'} src={sheetEmbed(id)} style={{ width: '100%', height, border: 0, display: 'block' }} />
    </div>
  );
}

export default function SourcesPage() {
  const router = useRouter();
  const workspace = useWorkspace();
  const [tab, setTab] = useState<Tab>('calendar');
  const [status, setStatus] = useState<Status | null>(null);
  const [calendar, setCalendar] = useState<{ entries: CalendarEntry[]; tabs: string[] } | null>(null);
  const [videos, setVideos] = useState<{ entries: VideoEntry[]; tabs: string[] } | null>(null);
  const [images, setImages] = useState<DriveImage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem('chi:sources:tab') as Tab | null;
      if (saved && TABS.some((t) => t.id === saved)) setTab(saved);
    } catch { /* private mode */ }
    fetch('/api/sources?kind=status').then((r) => (r.ok ? r.json() : null)).then((j) => j && setStatus(j)).catch(() => undefined);
  }, []);

  useEffect(() => {
    try { window.sessionStorage.setItem('chi:sources:tab', tab); } catch { /* private mode */ }
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

  function handoff(text: string, media: string, mediaLabel: string) {
    workspace.patch({ handoffText: text, handoffMedia: media, handoffMediaLabel: mediaLabel, handoffNonce: Date.now() });
    router.push('/#section-publish');
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
          <h1 style={{ margin: 0, fontSize: 22 }}>Sources</h1>
          <div style={{ fontSize: 13, opacity: .6, marginTop: 4 }}>The team&apos;s planning documents, live inside the dashboard. You edit them here; the dashboard reads them.</div>
        </div>
        <PageNav current="/sources" />
      </header>

      <div style={{ maxWidth: 1200, margin: '0 auto', padding: 24, display: 'grid', gap: 20 }}>
        <nav aria-label="Source" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {TABS.map((t) => (
            <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={t.id === tab ? 'page' : undefined}
              style={{ ...(t.id === tab ? btn : ghost), fontSize: 13, padding: '8px 14px' }}>
              {t.label}
            </button>
          ))}
        </nav>

        <p style={{ margin: 0, fontSize: 13, opacity: .7 }}>{active.blurb}</p>

        {status && !status.configured && (
          <div role="alert" style={{ ...card, borderColor: '#f0c36d', background: '#fff8e6', fontSize: 13 }}>
            Google access is not set up yet — the documents still open below, but the dashboard cannot read them. Ask whoever set this up to add the Google service account.
          </div>
        )}
        {err && <div role="alert" style={{ color: '#d70015', fontSize: 13 }}>{err}</div>}

        {tab === 'calendar' && (
          <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'minmax(0, 1fr) 340px' }} className="sources-grid">
            <section style={{ ...card, padding: 0, overflow: 'hidden', minHeight: 640 }}>
              {ids && <SheetFrame id={ids.calendar} title="Cellular Institute Social Media Calendar" height={720} />}
            </section>
            <aside style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
              <section style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h2 style={{ margin: 0, fontSize: 15 }}>Coming up</h2>
                  <button type="button" style={ghost} onClick={() => load('calendar', true)}>Refresh</button>
                </div>
                {!calendar ? <p style={{ fontSize: 13, opacity: .6 }}>Reading the sheet…</p>
                  : upcoming.length === 0 ? <p style={{ fontSize: 13, opacity: .6 }}>Nothing dated from today onward yet.</p>
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
                            {e.graphicsLink && <a href={e.graphicsLink} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>graphic ↗</a>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
              </section>
              {calendar && recent.length > 0 && (
                <section style={card}>
                  <h2 style={{ margin: 0, fontSize: 15 }}>Recently posted</h2>
                  <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'grid', gap: 8, fontSize: 12 }}>
                    {recent.map((e, i) => (
                      <li key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, opacity: .8 }}>
                        <span style={{ display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{e.caption || e.fileName}</span>
                        <span style={{ whiteSpace: 'nowrap', opacity: .6 }}>{e.date || e.tab}</span>
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
                          <tr key={i} style={{ borderTop: '1px solid rgba(0,0,0,0.08)', verticalAlign: 'top' }}>
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
                              <button type="button" style={btn} onClick={() => handoff([v.copy || v.title, v.videoLink ? 'Watch: ' + (v.videoLink.split(/\s+/).find((x) => /^https?:/.test(x)) || v.videoLink) : ''].filter(Boolean).join('\n\n'), '', '')}>Use in post</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </section>
            <section style={{ ...card, padding: 0, overflow: 'hidden' }}>
              {ids && <SheetFrame id={ids.videos} title="Distribución RRSS CHI" height={600} />}
            </section>
          </div>
        )}

        {tab === 'images' && (
          <section style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, fontSize: 15 }}>Images {images ? '(' + images.length + ')' : ''}</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                {ids && <a href={'https://drive.google.com/drive/folders/' + ids.images} target="_blank" rel="noreferrer" style={{ ...ghost, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Open folder in Drive ↗</a>}
                <button type="button" style={ghost} onClick={() => load('images', true)}>Refresh</button>
              </div>
            </div>
            <p style={{ fontSize: 12, opacity: .65, marginTop: 8 }}>Upload new photos in the Drive folder; they appear here. &quot;Use as hero image&quot; copies the photo into the dashboard so Metricool can publish it — the photo itself stays in Drive.</p>
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
