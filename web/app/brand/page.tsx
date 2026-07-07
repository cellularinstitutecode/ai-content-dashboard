'use client';

import { useEffect, useState } from 'react';

type Brand = {
  name?: string;
  mission?: string;
  voice?: string;
  audience?: string;
  keywords?: string[];
  guidelines?: string;
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: 10, borderRadius: 6, background: '#0a0e1a',
  border: '1px solid #1f2937', color: '#e6edf3', marginTop: 6, boxSizing: 'border-box',
};

export default function BrandPage() {
  const [brand, setBrand] = useState<Brand>({});
  const [keywordsText, setKeywordsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch('/api/brand');
      if (r.ok) {
        const j = await r.json().catch(() => null);
        const b = (j && j.brand) || {};
        setBrand(b);
        setKeywordsText(Array.isArray(b.keywords) ? b.keywords.join(', ') : '');
      }
    } catch {} finally {
      setLoading(false);
    }
  }

  function update(field: keyof Brand, value: string) {
    setBrand((prev) => ({ ...prev, [field]: value }));
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
      setStatus('Saved');
    } catch (e: any) {
      setStatus('Error: ' + (e && e.message ? e.message : 'failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#0a0e1a', color: '#e6edf3', fontFamily: '-apple-system,Segoe UI,sans-serif' }}>
      <header style={{ padding: '20px 32px', borderBottom: '1px solid #1f2937', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Brand Brain</h1>
          <div style={{ fontSize: 13, opacity: .7 }}>Voice, audience and guidelines that steer every generation</div>
        </div>
        <a href="/" style={{ color: '#9ca3af', fontSize: 13, textDecoration: 'none', border: '1px solid #1f2937', padding: '6px 12px', borderRadius: 6 }}>Back to dashboard</a>
      </header>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: 24 }}>
        {loading ? (
          <div style={{ opacity: .6, fontSize: 14 }}>Loading brand profile...</div>
        ) : (
          <section style={{ background: '#0f172a', border: '1px solid #1f2937', borderRadius: 12, padding: 20, display: 'grid', gap: 16 }}>
            <label style={{ fontSize: 13 }}>Brand name
              <input style={inputStyle} value={brand.name || ''} onChange={(e) => update('name', e.target.value)} placeholder="Cellular Hope Institute" />
            </label>
            <label style={{ fontSize: 13 }}>Mission
              <textarea style={{ ...inputStyle, minHeight: 70 }} value={brand.mission || ''} onChange={(e) => update('mission', e.target.value)} placeholder="What the brand is here to do" />
            </label>
            <label style={{ fontSize: 13 }}>Voice & tone
              <textarea style={{ ...inputStyle, minHeight: 70 }} value={brand.voice || ''} onChange={(e) => update('voice', e.target.value)} placeholder="Warm, expert, encouraging..." />
            </label>
            <label style={{ fontSize: 13 }}>Target audience
              <textarea style={{ ...inputStyle, minHeight: 60 }} value={brand.audience || ''} onChange={(e) => update('audience', e.target.value)} placeholder="Who you are speaking to" />
            </label>
            <label style={{ fontSize: 13 }}>Keywords (comma separated)
              <input style={inputStyle} value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} placeholder="wellness, research, community" />
            </label>
            <label style={{ fontSize: 13 }}>Guidelines / do's and don'ts
              <textarea style={{ ...inputStyle, minHeight: 90 }} value={brand.guidelines || ''} onChange={(e) => update('guidelines', e.target.value)} placeholder="Avoid medical claims, always include a CTA..." />
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button onClick={save} disabled={saving} style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: '#1e3a8a', color: '#e6edf3', cursor: saving ? 'default' : 'pointer' }}>
                {saving ? 'Saving...' : 'Save brand brain'}
              </button>
              {status && <span style={{ fontSize: 13, color: status.startsWith('Error') ? '#f87171' : '#4ade80' }}>{status}</span>}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
