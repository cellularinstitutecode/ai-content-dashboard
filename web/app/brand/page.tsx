'use client';

import { useEffect, useState } from 'react';
import PageNav from '@/components/PageNav';
import { announce, onRefresh } from '@/components/refreshBus';
import { DEFAULT_VISUAL, normalizeVisual, textColorOn, type BrandVisual } from '@/lib/brand-visual';

type FontInventory = {
  fonts: { name: string; size: number | null; file: { family: string; role: string; weight: number; style: string } | null }[];
  headline: string | null;
  body: string | null;
  standInFaces: string[];
};

type Brand = {
  name?: string;
  mission?: string;
  voice?: string;
  audience?: string;
  keywords?: string[];
  guidelines?: string;
  aviso_publicidad?: string;
  visual?: BrandVisual;
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: 10, borderRadius: 6, background: '#f5f5f7',
  border: '1px solid rgba(0,0,0,0.1)', color: '#1d1d1f', marginTop: 6, boxSizing: 'border-box',
};

export default function BrandPage() {
  const [brand, setBrand] = useState<Brand>({});
  const [keywordsText, setKeywordsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Licensed typefaces, uploaded here into private storage (never the repo).
  const [fonts, setFonts] = useState<FontInventory | null>(null);
  const [fontBusy, setFontBusy] = useState(false);
  const [fontMsg, setFontMsg] = useState<string | null>(null);

  async function loadFonts() {
    try {
      const r = await fetch('/api/brand/fonts');
      if (r.ok) setFonts(await r.json());
    } catch {}
  }
  useEffect(() => { loadFonts(); }, []);

  async function uploadFonts(list: FileList | null) {
    if (!list || !list.length) return;
    setFontBusy(true); setFontMsg(null);
    try {
      const fd = new FormData();
      Array.from(list).forEach((f) => fd.append('files', f));
      const r = await fetch('/api/brand/fonts', { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      const refused = Array.isArray(j.refused) ? j.refused : [];
      const parts: string[] = [];
      if (Array.isArray(j.saved) && j.saved.length) parts.push('Stored ' + j.saved.join(', ') + '.');
      for (const x of refused) parts.push('Refused ' + x.reason);
      if (!parts.length) parts.push(j.message || 'Nothing was uploaded.');
      setFontMsg(parts.join(' '));
      if (j.fonts) setFonts(j);
      else await loadFonts();
    } catch {
      setFontMsg('The upload did not go through just now.');
    } finally {
      setFontBusy(false);
    }
  }

  async function removeFont(name: string) {
    if (!window.confirm('Remove ' + name + ' from the brand font store?')) return;
    setFontBusy(true); setFontMsg(null);
    try {
      const r = await fetch('/api/brand/fonts?name=' + encodeURIComponent(name), { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (j.fonts) setFonts(j); else await loadFonts();
    } catch {} finally { setFontBusy(false); }
  }

  useEffect(() => { load(); }, []);

  // The brand profile steers every generator on the dashboard, so a change
  // made in another tab or by the assistant refetches it here too.
  useEffect(() => onRefresh((scopes) => { if (scopes.includes('brand')) load(); }), []);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch('/api/brand');
      if (r.ok) {
        const j = await r.json().catch(() => null);
        const b = (j && j.brand) || {};
        // A profile saved before the visual identity existed shows the brand
        // guide's defaults, which is also what the image pipeline uses for it.
        setBrand({ ...b, visual: normalizeVisual(b.visual) });
        setKeywordsText(Array.isArray(b.keywords) ? b.keywords.join(', ') : '');
      }
    } catch {} finally {
      setLoading(false);
    }
  }

  function update(field: keyof Brand, value: string) {
    setBrand((prev) => ({ ...prev, [field]: value }));
  }
  const visual = brand.visual || DEFAULT_VISUAL;
  function updateVisual(patch: Partial<BrandVisual>) {
    setBrand((prev) => ({ ...prev, visual: { ...(prev.visual || DEFAULT_VISUAL), ...patch } }));
  }
  function updateColor(i: number, patch: Partial<BrandVisual['palette'][number]>) {
    const palette = visual.palette.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    updateVisual({ palette });
  }

  async function save() {
    setSaving(true); setStatus(null);
    try {
      const keywords = keywordsText.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await fetch('/api/brand', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...brand, keywords }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((data && data.error) || ('Save failed (' + r.status + ')'));
      setStatus(data && data.warning ? 'Saved — ' + data.warning : 'Saved');
      // Generators read the brand profile server-side on every call, so the
      // panels that show brand-derived output are told to refresh.
      announce('brand', 'insights');
    } catch (e: any) {
      setStatus('Error: ' + (e && e.message ? e.message : 'failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#f5f5f7', color: '#1d1d1f', fontFamily: '-apple-system,Segoe UI,sans-serif' }}>
      <header style={{ padding: '20px 32px', borderBottom: '1px solid rgba(0,0,0,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Brand Brain</h1>
          <div style={{ fontSize: 13, opacity: .7 }}>Voice, audience and guidelines that steer every generation</div>
        </div>
        <PageNav current="/brand" />
      </header>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: 24 }}>
        {loading ? (
          <div style={{ opacity: .6, fontSize: 14 }}>Loading brand profile...</div>
        ) : (
          <section style={{ background: '#ffffff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: 20, display: 'grid', gap: 16 }}>
            <label style={{ fontSize: 13 }}>Brand name
              <input style={inputStyle} value={brand.name || ''} onChange={(e) => update('name', e.target.value)} placeholder="Cellular Hope Institute" />
            </label>
            <label style={{ fontSize: 13 }}>Mission
              <textarea style={{ ...inputStyle, minHeight: 150, lineHeight: 1.5 }} value={brand.mission || ''} onChange={(e) => update('mission', e.target.value)} placeholder="What the brand is here to do" />
            </label>
            <label style={{ fontSize: 13 }}>Voice & tone
              <textarea style={{ ...inputStyle, minHeight: 150, lineHeight: 1.5 }} value={brand.voice || ''} onChange={(e) => update('voice', e.target.value)} placeholder="Warm, expert, encouraging..." />
            </label>
            <label style={{ fontSize: 13 }}>Target audience
              <textarea style={{ ...inputStyle, minHeight: 130, lineHeight: 1.5 }} value={brand.audience || ''} onChange={(e) => update('audience', e.target.value)} placeholder="Who you are speaking to" />
            </label>
            <label style={{ fontSize: 13 }}>Keywords (comma separated)
              <input style={inputStyle} value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} placeholder="wellness, research, community" />
            </label>
            <label style={{ fontSize: 13 }}>Guidelines / do&apos;s and don&apos;ts
              <textarea style={{ ...inputStyle, minHeight: 200, lineHeight: 1.5 }} value={brand.guidelines || ''} onChange={(e) => update('guidelines', e.target.value)} placeholder="Avoid medical claims, always include a CTA..." />
            </label>
            <label style={{ fontSize: 13 }}>Aviso de publicidad (COFEPRIS advertising permit number)
              <input style={inputStyle} value={brand.aviso_publicidad || ''} onChange={(e) => update('aviso_publicidad', e.target.value)} placeholder="2623022002A00090" />
              <span style={{ display: 'block', marginTop: 6, fontSize: 12, opacity: .7 }}>
                Added automatically as &quot;AVISO DE PUBLICIDAD: …&quot; on every Instagram and Facebook post. Those posts also need a REF line citing a scientific study — the app writes it and will not send a post without both.
              </span>
            </label>
            {/* Visual identity — what every generated image and brand card is painted with.
                Seeded from the brand guide; the image pipeline reads exactly these values. */}
            <div id="visual-identity" style={{ borderTop: '1px solid rgba(0,0,0,0.08)', paddingTop: 16, display: 'grid', gap: 14 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>Visual identity</div>
                <div style={{ fontSize: 12, opacity: .7, marginTop: 2 }}>
                  The palette, materials and camera every AI image is briefed with, and the colours brand cards are painted in. Pre-filled from the 2026 brand guide.
                </div>
              </div>
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 13 }}>Palette</div>
                <div style={{ display: 'flex', gap: 6 }} aria-label="palette preview">
                  {visual.palette.map((c, i) => (
                    <div key={i} title={c.name + ' ' + c.hex} style={{ flex: 1, height: 44, borderRadius: 8, background: c.hex, color: textColorOn(c.hex, visual.palette), fontSize: 10, display: 'flex', alignItems: 'flex-end', padding: 6, boxSizing: 'border-box', border: '1px solid rgba(0,0,0,0.08)' }}>
                      {c.hex}
                    </div>
                  ))}
                </div>
                {visual.palette.map((c, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 140px 120px', gap: 8 }}>
                    <input aria-label={'colour ' + (i + 1) + ' name'} style={{ ...inputStyle, marginTop: 0 }} value={c.name} onChange={(e) => updateColor(i, { name: e.target.value })} placeholder="Name" />
                    <input aria-label={'colour ' + (i + 1) + ' hex'} style={{ ...inputStyle, marginTop: 0, fontFamily: 'ui-monospace, monospace' }} value={c.hex} onChange={(e) => updateColor(i, { hex: e.target.value })} placeholder="#9F4D27" />
                    <select aria-label={'colour ' + (i + 1) + ' role'} style={{ ...inputStyle, marginTop: 0 }} value={c.role} onChange={(e) => updateColor(i, { role: e.target.value as BrandVisual['palette'][number]['role'] })}>
                      <option value="dark">Dark ground</option>
                      <option value="accent">Accent</option>
                      <option value="light">Light ground</option>
                    </select>
                  </div>
                ))}
              </div>
              <label style={{ fontSize: 13 }}>Materials &amp; light — the world a photograph should show
                <textarea style={{ ...inputStyle, minHeight: 90, lineHeight: 1.5 }} value={visual.materials} onChange={(e) => updateVisual({ materials: e.target.value })} />
              </label>
              <label style={{ fontSize: 13 }}>Photography direction — how the camera behaves
                <textarea style={{ ...inputStyle, minHeight: 90, lineHeight: 1.5 }} value={visual.photography} onChange={(e) => updateVisual({ photography: e.target.value })} />
              </label>
              <label style={{ fontSize: 13 }}>Never show (one per line)
                <textarea style={{ ...inputStyle, minHeight: 80, lineHeight: 1.5 }} value={visual.never.join('\n')} onChange={(e) => updateVisual({ never: e.target.value.split('\n') })} />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label style={{ fontSize: 13 }}>Headline typeface
                  <input style={inputStyle} value={visual.fonts.headline} onChange={(e) => updateVisual({ fonts: { ...visual.fonts, headline: e.target.value } })} placeholder="Canela" />
                </label>
                <label style={{ fontSize: 13 }}>Body typeface
                  <input style={inputStyle} value={visual.fonts.body} onChange={(e) => updateVisual({ fonts: { ...visual.fonts, body: e.target.value } })} placeholder="Nexa" />
                </label>
              </div>
              {/* Licensed typefaces: uploaded into private storage, read by the card compositor. */}
              <div id="brand-fonts" style={{ background: '#f5f5f7', borderRadius: 10, padding: 14, display: 'grid', gap: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Brand typeface files</div>
                <div style={{ fontSize: 12, opacity: .7 }}>
                  Upload the clinic&apos;s licensed <b>Canela</b> (headlines) and <b>Nexa</b> or <b>Rische</b> (body) files here — .otf, .ttf or .woff. They are kept in private storage, never in the code, and brand cards switch to them within a minute.
                  Trial and demo builds are refused: an evaluation licence does not cover production posts.
                </div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
                  <span data-testid="font-headline">Headline: <b>{fonts ? (fonts.headline || 'stand-in (Instrument Serif) — add Canela') : '…'}</b></span>
                  <span data-testid="font-body">Body: <b>{fonts ? (fonts.body || 'stand-in (Outfit) — add Nexa or Rische') : '…'}</b></span>
                </div>
                {fonts && fonts.fonts.length > 0 && (
                  <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                    {fonts.fonts.map((f) => (
                      <li key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                        <span style={{ fontFamily: 'ui-monospace, monospace' }}>{f.name}</span>
                        <span style={{ opacity: .6 }}>{f.file ? f.file.family + ' · ' + f.file.role + ' · ' + f.file.weight + (f.file.style === 'italic' ? ' italic' : '') : 'not a brand face'}</span>
                        <button type="button" onClick={() => void removeFont(f.name)} disabled={fontBusy} style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid rgba(215,0,21,0.3)', color: '#d70015', borderRadius: 999, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
                <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <input type="file" accept=".otf,.ttf,.woff,font/otf,font/ttf,font/woff" multiple disabled={fontBusy} onChange={(e) => { void uploadFonts(e.target.files); e.currentTarget.value = ''; }} aria-label="Upload brand font files" />
                  {fontBusy && <span style={{ opacity: .6 }}>Uploading…</span>}
                </label>
                {fontMsg && <div role="status" style={{ fontSize: 12, color: /Refused/.test(fontMsg) ? '#8a5a00' : '#248a3d' }}>{fontMsg}</div>}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button onClick={save} disabled={saving} style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: '#0071e3', color: '#fff', cursor: saving ? 'default' : 'pointer' }}>
                {saving ? 'Saving...' : 'Save brand brain'}
              </button>
              {status && <span style={{ fontSize: 13, color: status.startsWith('Error') ? '#d70015' : '#248a3d' }}>{status}</span>}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
