'use client';
import { useEffect, useState } from 'react';

const CHANNELS = ['instagram','facebook','linkedin','blog'] as const;
type Channel = typeof CHANNELS[number];
type Provider = 'anthropic' | 'openai';

interface Pack { instagram?: string; facebook?: string; linkedin?: string; blog?: string; }
interface Draft { id: string; topic: string; updated_at: string; pack: Pack; provider?: Provider; }

export default function Dashboard() {
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState('Professional, educational, friendly');
  const [goal, setGoal] = useState('Awareness');
  const [cta, setCta] = useState('Book your consultation today');
  const [selected, setSelected] = useState<Channel[]>(['instagram','facebook','linkedin','blog']);
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [usedProvider, setUsedProvider] = useState<Provider | null>(null);
  const [pack, setPack] = useState<Pack | null>(null);
  const [loading, setLoading] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [opusUrl, setOpusUrl] = useState('');
  const [opusBusy, setOpusBusy] = useState(false);
  const [opusResult, setOpusResult] = useState<string>('');
  const [toast, setToast] = useState('');

  useEffect(() => { fetchDrafts(); }, []);
  function showToast(t: string) { setToast(t); setTimeout(()=>setToast(''), 2500); }

  async function fetchDrafts() {
    try {
      const r = await fetch('/api/drafts');
      const j = await r.json();
      if (j.drafts) setDrafts(j.drafts);
    } catch {}
  }

  async function generate() {
    if (!topic) { showToast('Add a topic first'); return; }
    setLoading(true); setPack(null); setUsedProvider(null);
    try {
      const r = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic, audience, tone, channels: selected, provider }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setPack(j.pack); setUsedProvider(j.provider);
      await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic, pack: j.pack, provider: j.provider }),
      });
      fetchDrafts();
      showToast(`Generated with ${j.provider === 'anthropic' ? 'Claude' : 'OpenAI'}`);
    } catch (e: any) {
      showToast(e.message || 'Generation failed');
    } finally { setLoading(false); }
  }

  async function scheduleToMetricool(channel: Channel) {
    if (!pack?.[channel]) return;
    const text = pack[channel]!;
    const providers = [{ network: channel === 'blog' ? 'blog' : channel }];
    const publicationDate = new Date(Date.now() + 60*60*1000).toISOString();
    try {
      const r = await fetch('/api/metricool/schedule', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, providers, publicationDate, draftTopic: topic }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'metricool failed');
      showToast(`Scheduled ${channel} → Metricool`);
    } catch (e: any) { showToast(e.message); }
  }

  async function sendToOpus() {
    if (!opusUrl) { showToast('Paste a video URL'); return; }
    setOpusBusy(true); setOpusResult('');
    try {
      const r = await fetch('/api/opus/clip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoUrl: opusUrl }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'opus failed');
      setOpusResult(JSON.stringify(j, null, 2));
      showToast('Sent to OpusClip');
    } catch (e: any) { showToast(e.message); }
    finally { setOpusBusy(false); }
  }

  function toggleChannel(c: Channel) {
    setSelected(s => s.includes(c) ? s.filter(x=>x!==c) : [...s, c]);
  }

  return (
    <div className="min-h-screen bg-[#050914] text-white glow">
      <div className="mx-auto max-w-7xl p-6 md:p-10 relative z-10">
        <header className="flex items-center justify-between mb-8">
          <div>
            <h1 className="display text-3xl md:text-4xl font-bold">AI Content Dashboard</h1>
            <p className="text-white/60 text-sm mt-1">Cellular Hope Institute · Multi-channel social pack → Metricool</p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="px-2 py-1 rounded bg-white/5 border border-white/10">Claude + OpenAI</span>
            <span className="px-2 py-1 rounded bg-white/5 border border-white/10">Metricool</span>
            <span className="px-2 py-1 rounded bg-white/5 border border-white/10">OpusClip</span>
          </div>
        </header>

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[['Drafts', drafts.length],['Approved','—'],['Scheduled','—'],['Published','—']].map(([k,v]) => (
            <div key={k as string} className="p-5 rounded-2xl bg-[#0b1424] border border-white/5">
              <div className="text-xs text-white/50 uppercase tracking-wide">{k}</div>
              <div className="text-3xl font-bold mt-2 display">{v}</div>
            </div>
          ))}
        </div>

        {/* Video Generator (OpusClip) */}
        <section className="p-5 md:p-6 rounded-2xl bg-[#0b1424] border border-white/5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="display text-xl font-semibold">🎬 Video Generator (OpusClip)</h2>
            <a href="https://clip.opus.pro/dashboard" target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline">Open OpusClip ↗</a>
          </div>
          <div className="flex flex-col md:flex-row gap-2">
            <input value={opusUrl} onChange={e=>setOpusUrl(e.target.value)} placeholder="Paste long-form video URL (YouTube, Vimeo, MP4)" className="flex-1 px-4 py-3 rounded-xl bg-[#07111f] border border-white/10 focus:outline-none focus:border-blue-500/50" />
            <button onClick={sendToOpus} disabled={opusBusy} className="px-5 py-3 rounded-xl bg-pink-600 hover:bg-pink-700 disabled:opacity-50 font-medium">{opusBusy?'Sending…':'✨ Send to OpusClip'}</button>
          </div>
          {opusResult && <pre className="mt-3 p-3 rounded bg-black/40 text-xs overflow-auto max-h-48">{opusResult}</pre>}
        </section>

        {/* Content Generator */}
        <section className="p-5 md:p-6 rounded-2xl bg-[#0b1424] border border-white/5 mb-6">
          <h2 className="display text-xl font-semibold mb-4">✨ Content Generator</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-white/50 uppercase">Topic</label>
              <input value={topic} onChange={e=>setTopic(e.target.value)} placeholder="e.g. Exosome therapy benefits" className="w-full mt-1 px-4 py-3 rounded-xl bg-[#07111f] border border-white/10" />
            </div>
            <div>
              <label className="text-xs text-white/50 uppercase">Target audience</label>
              <input value={audience} onChange={e=>setAudience(e.target.value)} placeholder="e.g. Aesthetic patients" className="w-full mt-1 px-4 py-3 rounded-xl bg-[#07111f] border border-white/10" />
            </div>
            <div>
              <label className="text-xs text-white/50 uppercase">Tone</label>
              <input value={tone} onChange={e=>setTone(e.target.value)} className="w-full mt-1 px-4 py-3 rounded-xl bg-[#07111f] border border-white/10" />
            </div>
            <div>
              <label className="text-xs text-white/50 uppercase">CTA</label>
              <input value={cta} onChange={e=>setCta(e.target.value)} className="w-full mt-1 px-4 py-3 rounded-xl bg-[#07111f] border border-white/10" />
            </div>
          </div>

          <div className="mt-4">
            <div className="text-xs text-white/50 uppercase mb-2">Channels (post pack)</div>
            <div className="flex flex-wrap gap-2">
              {CHANNELS.map(c => (
                <button key={c} onClick={()=>toggleChannel(c)}
                  className={`px-4 py-2 rounded-xl border text-sm capitalize ${selected.includes(c) ? 'bg-blue-600 border-blue-500' : 'bg-[#07111f] border-white/10 text-white/70'}`}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5 flex flex-col md:flex-row md:items-center gap-3 md:justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/50 uppercase mr-1">AI</span>
              <button onClick={()=>setProvider('anthropic')}
                className={`px-4 py-2 rounded-xl border text-sm ${provider==='anthropic' ? 'bg-orange-600 border-orange-500' : 'bg-[#07111f] border-white/10 text-white/70'}`}>
                🧠 Claude
              </button>
              <button onClick={()=>setProvider('openai')}
                className={`px-4 py-2 rounded-xl border text-sm ${provider==='openai' ? 'bg-emerald-600 border-emerald-500' : 'bg-[#07111f] border-white/10 text-white/70'}`}>
                ⚪ OpenAI
              </button>
            </div>
            <button onClick={generate} disabled={loading} className="px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 font-medium">
              {loading ? 'Generating…' : '⚡ Generate Pack'}
            </button>
          </div>
        </section>

        {/* Generated Pack */}
        {pack && (
          <section className="p-5 md:p-6 rounded-2xl bg-[#0b1424] border border-white/5 mb-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="display text-xl font-semibold">📝 Generated Pack</h2>
              {usedProvider && (
                <span className="text-xs px-2 py-1 rounded bg-white/5 border border-white/10">
                  via {usedProvider === 'anthropic' ? 'Claude' : 'OpenAI'}
                </span>
              )}
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              {CHANNELS.map(c => pack[c] && (
                <div key={c} className="p-4 rounded-xl bg-[#07111f] border border-white/10">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-xs uppercase text-white/60">{c}</div>
                    <button onClick={()=>scheduleToMetricool(c)} className="text-xs px-3 py-1 rounded bg-blue-600/80 hover:bg-blue-600">Schedule in Metricool</button>
                  </div>
                  <pre className="text-sm whitespace-pre-wrap text-white/90">{pack[c]}</pre>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Recent Drafts */}
        <section className="p-5 md:p-6 rounded-2xl bg-[#0b1424] border border-white/5 mb-6">
          <h2 className="display text-xl font-semibold mb-3">📄 Recent Drafts</h2>
          {drafts.length === 0 && <div className="text-white/50 text-sm">No drafts yet. Generate one above.</div>}
          <ul className="divide-y divide-white/5">
            {drafts.slice(0, 10).map(d => (
              <li key={d.id} className="py-3 flex items-center justify-between">
                <div>
                  <div className="font-medium">{d.topic}</div>
                  <div className="text-xs text-white/40">{new Date(d.updated_at).toLocaleString()}{d.provider ? ` · ${d.provider === 'anthropic' ? 'Claude' : 'OpenAI'}` : ''}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {toast && <div className="fixed bottom-6 right-6 px-4 py-3 rounded-xl bg-black/80 border border-white/10 text-sm">{toast}</div>}
      </div>
    </div>
  );
}
