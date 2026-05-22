'use client';
import { useEffect, useState } from 'react';

const CHANNELS = ['instagram','facebook','linkedin','blog'] as const;
type Channel = typeof CHANNELS[number];

interface Pack { instagram?: string; facebook?: string; linkedin?: string; blog?: string; }
interface Draft { id: string; topic: string; updated_at: string; pack: Pack; }

export default function Dashboard() {
  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState('Professional, educational, friendly');
  const [goal, setGoal] = useState('Awareness');
  const [cta, setCta] = useState('Book your consultation today');
  const [selected, setSelected] = useState<Channel[]>(['instagram','facebook','linkedin','blog']);
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
      const r = await fetch('/api/drafts'); const j = await r.json();
      if (j.drafts) setDrafts(j.drafts);
    } catch {}
  }

  function toggleChannel(c: Channel) {
    setSelected(s => s.includes(c) ? s.filter(x=>x!==c) : [...s, c]);
  }

  async function generate() {
    if (!topic.trim()) { showToast('Enter a topic'); return; }
    setLoading(true); setPack(null);
    try {
      const r = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, audience, tone, goal, cta, channels: selected })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setPack(j.pack);
      // Save as draft
      await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, audience, tone, goal, cta, channels: selected, pack: j.pack })
      });
      fetchDrafts();
      showToast('Pack generated and saved');
    } catch (e: any) {
      showToast(e.message);
    } finally { setLoading(false); }
  }

  async function sendToMetricool(channel: Channel) {
    if (!pack || !pack[channel]) return;
    const providerMap: Record<Channel,string> = { instagram:'instagram', facebook:'facebook', linkedin:'linkedin', blog:'blog' };
    const when = new Date(Date.now() + 10*60*1000).toISOString();
    const r = await fetch('/api/metricool/schedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: pack[channel], providers: [providerMap[channel]], publicationDate: when, autoPublish: false })
    });
    const j = await r.json();
    showToast(r.ok ? channel + ' scheduled in Metricool' : 'Error: ' + (j.error||'unknown'));
  }

  async function sendToOpus() {
    if (!opusUrl.trim()) { showToast('Paste a video URL'); return; }
    setOpusBusy(true);
    try {
      const r = await fetch('/api/opus/clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: opusUrl })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'failed');
      setOpusResult('Project: ' + (j.project?.projectId || j.project?.id || 'submitted'));
      showToast('OpusClip processing started');
    } catch (e: any) { showToast(e.message); }
    finally { setOpusBusy(false); }
  }

  return (
    <div className="min-h-screen flex text-slate-200">
      <aside className="w-60 border-r border-white/10 p-4 hidden md:block">
        <div className="text-xl font-display font-bold mb-6">AI Content<br/><span className="text-blue-400 text-sm">Dashboard</span></div>
        <nav className="space-y-1 text-sm">
          {['Dashboard','Brand Brain','Content Generator','Drafts','Calendar','Settings'].map(n => (
            <a key={n} href="#" className="block px-3 py-2 rounded-lg hover:bg-white/5">{n}</a>
          ))}
        </nav>
      </aside>

      <main className="flex-1 p-6 max-w-7xl">
        <header className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-display font-bold">AI Content Dashboard</h1>
            <p className="text-slate-400 text-sm">Generate a multi-channel post pack, then send it to Metricool.</p>
          </div>
          <input className="bg-panel border border-white/10 rounded-lg px-3 py-1.5 text-sm w-64" placeholder="Search anything…" />
        </header>

        <section className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
          {['Drafts','Approved','Scheduled','Published'].map(label => (
            <div key={label} className="rounded-2xl bg-panel border border-white/10 p-6">
              <div className="text-sm text-slate-400">{label}</div>
              <div className="text-3xl font-display mt-2">—</div>
              <div className="text-xs text-blue-400 mt-2">Live counters via Metricool</div>
            </div>
          ))}
        </section>

        <section className="rounded-2xl bg-panel border border-white/10 p-6 mb-6">
          <h2 className="font-semibold mb-3">🎬 Video Generator (OpusClip)</h2>
          <input value={opusUrl} onChange={e=>setOpusUrl(e.target.value)} placeholder="Paste long-form video URL (YouTube, Vimeo, MP4…)" className="w-full bg-panel-2 border border-white/10 rounded-lg px-3 py-2 mb-3" />
          <button onClick={sendToOpus} disabled={opusBusy} className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:opacity-50">{opusBusy ? 'Submitting…' : 'Send to OpusClip'}</button>
          {opusResult && <div className="mt-3 text-sm text-slate-400">{opusResult}</div>}
        </section>

        <section className="rounded-2xl bg-panel border border-white/10 p-6 mb-6">
          <h2 className="font-semibold mb-3">＋ Content Generator</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <input value={topic} onChange={e=>setTopic(e.target.value)} placeholder="Topic (e.g. Exosome therapy benefits)" className="bg-panel-2 border border-white/10 rounded-lg px-3 py-2" />
            <input value={audience} onChange={e=>setAudience(e.target.value)} placeholder="Target audience" className="bg-panel-2 border border-white/10 rounded-lg px-3 py-2" />
            <input value={tone} onChange={e=>setTone(e.target.value)} placeholder="Tone" className="bg-panel-2 border border-white/10 rounded-lg px-3 py-2" />
            <input value={cta} onChange={e=>setCta(e.target.value)} placeholder="CTA" className="bg-panel-2 border border-white/10 rounded-lg px-3 py-2" />
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            {CHANNELS.map(c => (
              <button key={c} onClick={()=>toggleChannel(c)} className={'rounded-xl border px-4 py-2 text-sm '+(selected.includes(c)?'border-blue-500/60 bg-blue-500/10':'border-white/10 bg-panel-2')}>{c[0].toUpperCase()+c.slice(1)}</button>
            ))}
          </div>
          <button onClick={generate} disabled={loading} className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:opacity-50">{loading?'Generating…':'✨ Generate Post Pack'}</button>
        </section>

        {pack && (
          <section className="rounded-2xl bg-panel border border-white/10 p-6 mb-6">
            <h2 className="font-semibold mb-3">Generated Pack</h2>
            <div className="grid gap-4">
              {CHANNELS.filter(c=>pack[c]).map(c => (
                <div key={c} className="bg-panel-2 border border-white/10 rounded-xl p-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs uppercase tracking-wider text-blue-400">{c}</span>
                    <button onClick={()=>sendToMetricool(c)} className="text-xs px-3 py-1 rounded-md bg-blue-500/20 border border-blue-500/40 hover:bg-blue-500/30">Schedule in Metricool</button>
                  </div>
                  <pre className="whitespace-pre-wrap text-sm text-slate-200">{pack[c]}</pre>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="rounded-2xl bg-panel border border-white/10 p-6">
          <div className="flex justify-between items-center mb-3">
            <h2 className="font-semibold">Recent Drafts</h2>
            <span className="text-xs text-slate-500">{drafts.length} saved</span>
          </div>
          {drafts.length === 0 ? <div className="text-sm text-slate-500">No drafts yet. Generate one above.</div> : (
            <ul className="divide-y divide-white/5">
              {drafts.slice(0,8).map(d => (
                <li key={d.id} className="py-2 flex justify-between text-sm">
                  <span className="truncate max-w-md">{d.topic}</span>
                  <span className="text-slate-500">{new Date(d.updated_at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {toast && <div className="fixed bottom-6 right-6 bg-panel border border-white/10 px-4 py-2 rounded-lg text-sm shadow-xl">{toast}</div>}
      </main>
    </div>
  );
}
