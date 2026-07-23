'use client';

import { useEffect, useState } from 'react';

type Template = {
  id?: string;
  name?: string;
  providers?: string[];
  text?: string;
  weekdays?: number[];
  time_of_day?: string;
  active?: boolean;
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PROVIDERS = ['instagram', 'facebook', 'linkedin', 'blog'];

const card: React.CSSProperties = {
  background: '#ffffff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 10, padding: 16,
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: 10, borderRadius: 6, background: '#f5f5f7',
  border: '1px solid rgba(0,0,0,0.1)', color: '#1d1d1f', marginTop: 6, boxSizing: 'border-box',
};
const btn: React.CSSProperties = {
  background: '#0071e3', color: '#fff', border: 'none', borderRadius: 6,
  padding: '8px 14px', cursor: 'pointer', fontSize: 13,
};
const ghost: React.CSSProperties = {
  background: '#ffffff', color: '#1d1d1f', border: '1px solid rgba(0,0,0,0.1)',
  borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 13,
};

function emptyDraft(): Template {
  return { name: '', providers: [], text: '', weekdays: [], time_of_day: '09:00', active: true };
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [draft, setDraft] = useState<Template>(emptyDraft());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [aiTopic, setAiTopic] = useState('');
  const [aiProvider, setAiProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [aiBusy, setAiBusy] = useState(false);

  async function draftWithAI() {
    if (!aiTopic.trim()) { setErr('Enter a topic for the AI to draft from.'); return; }
    setErr(''); setAiBusy(true);
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: aiTopic, provider: aiProvider, model: aiProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o', type: 'social' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to draft');
      const pack = data?.pack || {};
      const drafted = pack.instagram || pack.facebook || pack.linkedin || pack.blog || '';
      setDraft((prev: any) => ({ ...prev, text: drafted }));
    } catch (e: any) {
      setErr(e?.message || 'Failed to draft with AI');
    } finally {
      setAiBusy(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch('/api/templates');
      if (!r.ok) throw new Error('Failed to load templates (' + r.status + ')');
      const j = await r.json().catch(() => null);
      setTemplates(Array.isArray(j && j.templates) ? j.templates : []);
    } catch (e: any) {
      setErr(e && e.message ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  function toggle(list: any[], value: any): any[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  }

  async function save() {
    setSaving(true);
    setStatus(null);
    setErr(null);
    try {
      const r = await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!r.ok) throw new Error('Save failed (' + r.status + ')');
      setDraft(emptyDraft());
      setStatus('Template saved.');
      await load();
    } catch (e: any) {
      setErr(e && e.message ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id?: string) {
    if (!id) return;
    setErr(null);
    try {
      const r = await fetch('/api/templates?id=' + encodeURIComponent(id), { method: 'DELETE' });
      if (!r.ok) throw new Error('Delete failed (' + r.status + ')');
      await load();
    } catch (e: any) {
      setErr(e && e.message ? e.message : 'Delete failed');
    }
  }

  async function apply(id?: string) {
    if (!id) return;
    setStatus(null);
    setErr(null);
    try {
      const r = await fetch('/api/templates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, weeks: 4 }),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error((j && j.error) || 'Apply failed (' + r.status + ')');
      setStatus('Scheduled ' + ((j && j.created) || 0) + ' posts for the next 4 weeks.');
    } catch (e: any) {
      setErr(e && e.message ? e.message : 'Apply failed');
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#f5f5f7', color: '#1d1d1f', fontFamily: '-apple-system,Segoe UI,sans-serif' }}>
      <header style={{ padding: '20px 32px', borderBottom: '1px solid rgba(0,0,0,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Schedule Templates</h1>
          <div style={{ fontSize: 13, opacity: .6, marginTop: 4 }}>Reusable weekly posting cadences. Apply one to generate upcoming scheduled posts.</div>
        </div>
        <a href="/" style={{ color: '#6e6e73', fontSize: 13, textDecoration: 'none', border: '1px solid rgba(0,0,0,0.1)', padding: '6px 12px', borderRadius: 6 }}>Back to dashboard</a>
      </header>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: 24, display: 'grid', gap: 24 }}>
        {err && <div style={{ color: '#d70015', fontSize: 14 }}>Error: {err}</div>}
        {status && <div style={{ color: '#248a3d', fontSize: 14 }}>{status}</div>}

        <section style={card}>
          <h2 style={{ marginTop: 0, fontSize: 16 }}>New template</h2>

          <label style={{ fontSize: 13, opacity: .8 }}>Name
            <input style={inputStyle} value={draft.name || ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Weekly product tips" />
          </label>

          <div style={{ marginTop: 14, fontSize: 13, opacity: .8 }}>Providers</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {PROVIDERS.map((p) => (
              <button key={p} type="button"
                onClick={() => setDraft({ ...draft, providers: toggle(draft.providers || [], p) })}
                style={{ ...ghost, background: (draft.providers || []).includes(p) ? '#0071e3' : '#f5f5f7', color: (draft.providers || []).includes(p) ? '#fff' : '#1d1d1f', border: '1px solid rgba(0,0,0,0.1)' }}>
                {p}
              </button>
            ))}
          </div>

          <div style={{ marginTop: 14, fontSize: 13, opacity: .8 }}>Post on</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {DOW.map((d, i) => (
              <button key={d} type="button"
                onClick={() => setDraft({ ...draft, weekdays: toggle(draft.weekdays || [], i) })}
                style={{ ...ghost, minWidth: 46, textAlign: 'center', background: (draft.weekdays || []).includes(i) ? '#0071e3' : '#f5f5f7', color: (draft.weekdays || []).includes(i) ? '#fff' : '#1d1d1f' }}>
                {d}
              </button>
            ))}
          </div>

          <label style={{ display: 'block', marginTop: 14, fontSize: 13, opacity: .8 }}>Time of day
            <input style={{ ...inputStyle, width: 140 }} type="time" value={draft.time_of_day || '09:00'} onChange={(e) => setDraft({ ...draft, time_of_day: e.target.value })} />
          </label>

          <div style={{ marginTop: 18, marginBottom: 6, padding: 14, borderRadius: 12, background: '#f5f5f7', border: '1px solid rgba(0,0,0,0.06)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 2l1.9 5.4L19 9.3l-4.6 2.3L12 17l-2.4-5.4L5 9.3l5.1-1.9L12 2z" fill="#0071e3"/>
              </svg>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#1d1d1f' }}>Draft with AI</span>
              <span style={{ fontSize: 12, color: '#6e6e73' }}>Let Claude or GPT write the post for you.</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              {([['anthropic', 'Claude'], ['openai', 'OpenAI']] as const).map(([val, label]) => (
                <button key={val} type="button" onClick={() => setAiProvider(val)}
                  style={{ ...ghost, background: aiProvider === val ? '#0071e3' : '#ffffff', color: aiProvider === val ? '#fff' : '#1d1d1f' }}>
                  {label}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input style={{ ...inputStyle, flex: 1 }} value={aiTopic}
                onChange={(e) => setAiTopic(e.target.value)}
                placeholder="What should this post be about?" />
              <button type="button" onClick={draftWithAI} disabled={aiBusy}
                style={{ ...btn, whiteSpace: 'nowrap', opacity: aiBusy ? 0.6 : 1 }}>
                {aiBusy ? 'Drafting…' : 'Draft with AI'}
              </button>
            </div>
          </div>

          <label style={{ display: 'block', marginTop: 14, fontSize: 13, opacity: .8 }}>Post text
            <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={draft.text || ''} onChange={(e) => setDraft({ ...draft, text: e.target.value })} placeholder="What should each scheduled post say?" />
          </label>

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button style={btn} onClick={save} disabled={saving}>{saving ? 'Savingâ¦' : 'Save template'}</button>
            <button style={ghost} type="button" onClick={() => setDraft(emptyDraft())}>Clear</button>
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 16 }}>Your templates</h2>
          {loading && <div style={{ opacity: .6, fontSize: 14 }}>Loadingâ¦</div>}
          {!loading && templates.length === 0 && (
            <div style={{ opacity: .6, fontSize: 14 }}>No templates yet. Create one above.</div>
          )}
          <div style={{ display: 'grid', gap: 12 }}>
            {templates.map((t) => (
              <div key={t.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, marginBottom: 4 }}>{t.name || 'Untitled template'}</div>
                  <div style={{ fontSize: 12, opacity: .7 }}>
                    {(t.weekdays || []).map((w) => DOW[w]).join(', ') || 'no days'} at {t.time_of_day || '09:00'} Â· {(t.providers || []).join(', ') || 'no providers'}
                  </div>
                  {t.text && <div style={{ fontSize: 13, opacity: .85, marginTop: 6, whiteSpace: 'pre-wrap' }}>{t.text}</div>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button style={btn} onClick={() => apply(t.id)}>Apply (4 wks)</button>
                  <button style={ghost} onClick={() => setDraft(t)}>Edit</button>
                  <button style={{ ...ghost, color: '#d70015' }} onClick={() => remove(t.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
