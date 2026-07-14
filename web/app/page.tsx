'use client';

import { useEffect, useState } from 'react';

type Provider = 'anthropic' | 'openai';
type ContentType = 'social' | 'blog' | 'email' | 'video' | 'ad';

const PROVIDERS: { id: Provider; label: string; models: { id: string; label: string }[] }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)', models: [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ]},
  { id: 'openai', label: 'OpenAI', models: [
    { id: 'gpt-4o', label: 'GPT-4o' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
    { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
  ]},
];

const CONTENT_TYPES: { id: ContentType; label: string; hint: string }[] = [
  { id: 'social', label: 'Social Post', hint: 'Short caption with hashtags for Instagram/X/LinkedIn/Facebook.' },
  { id: 'blog',   label: 'Blog Article', hint: 'Long-form SEO-friendly article with H2/H3 structure.' },
  { id: 'email',  label: 'Email Campaign', hint: 'Subject line + preview text + body for newsletter.' },
  { id: 'video',  label: 'Video Script', hint: 'Hook + scenes + CTA for short-form video (Reels/TikTok/Shorts).' },
  { id: 'ad',     label: 'Ad Copy', hint: 'Headline variations + body + CTA for Meta/Google Ads.' },
];

// Best-effort extraction of a few headline numbers from the Metricool analytics
// response. The upstream shape varies, so we scan known keys and only surface
// whatever we actually find (fails silently to an empty list).
function metricoolMetrics(a: any): { label: string; value: any }[] {
  if (!a || typeof a !== 'object') return [];
  const found: { label: string; value: any }[] = [];
  const seen = new Set<string>();
  const wanted: [string, RegExp][] = [
    ['Followers', /followers|fans|subscribers/i],
    ['Reach', /reach/i],
    ['Impressions', /impressions|views/i],
    ['Engagement', /engagement|interactions/i],
  ];
  const walk = (obj: any, depth: number) => {
    if (!obj || depth > 4 || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === 'number' && isFinite(v)) {
        for (const [label, re] of wanted) {
          if (!seen.has(label) && re.test(k)) { found.push({ label, value: v }); seen.add(label); }
        }
      } else if (v && typeof v === 'object') {
        walk(v, depth + 1);
      }
    }
  };
  walk(a, 0);
  return found.slice(0, 4);
}

function toArray(x: any): any[] {
  if (Array.isArray(x)) return x;
  if (x && Array.isArray(x.data)) return x.data;
  if (x && Array.isArray(x.drafts)) return x.drafts;
  if (x && Array.isArray(x.rows)) return x.rows;
  if (x && Array.isArray(x.items)) return x.items;
  return [];
}

export default function Dashboard() {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState<string>('claude-sonnet-4-5');
  const [type, setType] = useState<ContentType>('social');
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [mLoading, setMLoading] = useState(false);
  const [mAnalytics, setMAnalytics] = useState<any>(null);
  const [mNetwork, setMNetwork] = useState('facebook');
  const [mText, setMText] = useState('');
  const [mDate, setMDate] = useState('');
  const [mStatus, setMStatus] = useState<string | null>(null);

  const [opUrl, setOpUrl] = useState('');
  const [opStatus, setOpStatus] = useState<string | null>(null);

  const [drafts, setDrafts] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);

  useEffect(() => {
    const first = PROVIDERS.find(p => p.id === provider)!;
    if (!first.models.some(m => m.id === model)) setModel(first.models[0].id);
  }, [provider]);

  useEffect(() => { refreshDrafts(); refreshStats(); }, []);

  async function refreshStats() {
    try {
      const r = await fetch('/api/stats');
      if (!r.ok) return;
      const j = await r.json().catch(() => null);
      if (j) setStats(j);
    } catch {}
  }

  async function refreshDrafts() {
    try {
      const r = await fetch('/api/drafts');
      if (!r.ok) return;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return;
      const j = await r.json().catch(() => null);
      setDrafts(toArray(j));
    } catch {}
  }
async function generate() {
    setLoading(true); setErr(null); setOutput('');
    try {
      const r = await fetch('/api/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: prompt, provider, model, type }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || ('Generation failed ('+r.status+')'));
      const pack = data.pack || {};
      setOutput([
        'INSTAGRAM', pack.instagram || '', '',
        'FACEBOOK', pack.facebook || '', '',
        'LINKEDIN', pack.linkedin || '', '',
        'BLOG', pack.blog || ''
      ].join('\n'));
      refreshDrafts();
    } catch (e: any) { setErr(e?.message || 'Generation failed'); } finally { setLoading(false); }
  }

  async function loadAnalytics() {
    setMLoading(true); setMStatus(null);
    try {
      const r = await fetch('/api/metricool?blogId=4308292');
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || ('Metricool fetch failed ('+r.status+')'));
      setMAnalytics(data);
    } catch (e: any) { setMStatus('Error: ' + (e?.message || 'failed')); } finally { setMLoading(false); }
  }

  async function schedulePost() {
    setMStatus(null);
    try {
      const r = await fetch('/api/metricool/schedule', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ network: mNetwork, text: mText, publishAt: mDate, blogId: 4308292 }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || ('Schedule failed ('+r.status+')'));
      setMStatus('Scheduled ' + (data.id ? '(id: ' + data.id + ')' : ''));
    } catch (e: any) { setMStatus('Error: ' + (e?.message || 'failed')); }
  }

  async function clipVideo() {
    setOpStatus(null);
    try {
      const r = await fetch('/api/opus/clip', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoUrl: opUrl }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.error || ('OpusClip failed ('+r.status+')'));
      setOpStatus('Clip job started ' + ((data && data.project && (data.project.projectId || data.project.id)) || ''));
    } catch (e: any) { setOpStatus('Error: ' + (e?.message || 'failed')); }
  }

  const currentModels = PROVIDERS.find(p => p.id === provider)!.models;
  const safeDrafts = Array.isArray(drafts) ? drafts : [];

  return (
    <main style={{ minHeight:'100vh', background:'#0a0e1a', color:'#e6edf3', fontFamily:'-apple-system,Segoe UI,sans-serif' }}>
      <header style={{ padding:'20px 32px', borderBottom:'1px solid #1f2937', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <div>
          <h1 style={{ margin:0, fontSize:22 }}>AI Content Dashboard</h1>
          <div style={{ fontSize:13, opacity:.7 }}>Cellular Hope Institute - marketing command center</div>
        </div>
        <nav style={{ display:'flex', gap:12, alignItems:'center' }}>
          <a href='/calendar' style={{ color:'#9ca3af', fontSize:13, textDecoration:'none' }}>Calendar</a>
          <a href='/brand' style={{ color:'#9ca3af', fontSize:13, textDecoration:'none' }}>Brand Brain</a>
          <a href='/templates' style={{ color:'#9ca3af', fontSize:13, textDecoration:'none' }}>Templates</a>
          <a href='/sign-out' style={{ color:'#9ca3af', fontSize:13, textDecoration:'none', border:'1px solid #1f2937', padding:'6px 12px', borderRadius:6 }}>Sign out</a>
        </nav>
      </header>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, padding:24, maxWidth:1400, margin:'0 auto' }}>

        <section style={{ gridColumn:'1 / -1', display:'grid', gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))', gap:12 }}>
          {[
            { label:'Drafts', value: stats ? stats.drafts : '-' },
            { label:'Scheduled posts', value: stats ? stats.scheduledPosts : '-' },
            { label:'Upcoming', value: stats ? stats.upcomingPosts : '-' },
            { label:'Clip jobs', value: stats ? stats.clips : '-' },
            ...metricoolMetrics(mAnalytics),
          ].map((s) => (
            <div key={s.label} style={{ background:'#0f172a', border:'1px solid #1f2937', borderRadius:12, padding:'16px 18px' }}>
              <div style={{ fontSize:26, fontWeight:600 }}>{s.value}</div>
              <div style={{ fontSize:12, opacity:.65, marginTop:2 }}>{s.label}</div>
            </div>
          ))}
        </section>

        <section style={{ background:'#0f172a', border:'1px solid #1f2937', borderRadius:12, padding:20, gridColumn:'1 / -1' }}>
          <h2 style={{ marginTop:0, fontSize:16 }}>1. Content Generator</h2>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:12 }}>
            {PROVIDERS.map(p => (
              <button key={p.id} onClick={()=>setProvider(p.id)} style={{ padding:'8px 14px', borderRadius:8, border:'1px solid '+(provider===p.id?'#3b82f6':'#1f2937'), background:provider===p.id?'#1e3a8a':'#0a0e1a', color:'#e6edf3', cursor:'pointer' }}>{p.label}</button>
            ))}
            <select value={model} onChange={e=>setModel(e.target.value)} style={{ padding:'8px 12px', borderRadius:8, background:'#0a0e1a', border:'1px solid #1f2937', color:'#e6edf3' }}>
              {currentModels.map(m=> <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:12 }}>
            {CONTENT_TYPES.map(c => (
              <button key={c.id} onClick={()=>setType(c.id)} style={{ padding:'6px 12px', borderRadius:6, border:'1px solid '+(type===c.id?'#10b981':'#1f2937'), background:type===c.id?'#064e3b':'#0a0e1a', color:'#e6edf3', cursor:'pointer', fontSize:13 }}>{c.label}</button>
            ))}
          </div>
          <div style={{ fontSize:12, opacity:.7, marginBottom:8 }}>{CONTENT_TYPES.find(c=>c.id===type)?.hint}</div>
          <textarea value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder='What should we create? e.g. 3 Instagram captions about exosome therapy benefits for athletes' rows={4} style={{ width:'100%', padding:12, borderRadius:8, background:'#0a0e1a', border:'1px solid #1f2937', color:'#e6edf3', fontFamily:'inherit', resize:'vertical' }} />
          <button onClick={generate} disabled={loading||!prompt.trim()} style={{ marginTop:10, padding:'10px 20px', borderRadius:8, background:loading?'#374151':'#3b82f6', color:'#fff', border:0, cursor:loading?'wait':'pointer', fontWeight:600 }}>{loading?'Generating...':'Generate with '+(provider==='anthropic'?'Claude':'OpenAI')}</button>
          {err && <div style={{ marginTop:10, padding:10, background:'#7f1d1d', borderRadius:6, fontSize:13 }}>{err}</div>}
          {output && <button onClick={()=>{navigator.clipboard.writeText(output).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1500);}).catch(()=>setErr('Could not copy to clipboard'));}} style={{ marginTop:12, marginRight:8, padding:'6px 12px', borderRadius:6, border:'1px solid #1f2937', background:'#10b981', color:'#fff', cursor:'pointer' }}>{copied?'Copied!':'Copy output'}</button>}
          {output && <pre style={{ marginTop:12, padding:14, background:'#0a0e1a', border:'1px solid #1f2937', borderRadius:8, whiteSpace:'pre-wrap', wordBreak:'break-word', fontFamily:'inherit', fontSize:14, lineHeight:1.6 }}>{output}</pre>}
        </section>

        <section style={{ background:'#0f172a', border:'1px solid #1f2937', borderRadius:12, padding:20 }}>
          <h2 style={{ marginTop:0, fontSize:16 }}>2. Metricool - Analytics and Scheduling</h2>
          <div style={{ fontSize:12, opacity:.7, marginBottom:10 }}>Brand: Cellular Hope Institute - blogId 4308292</div>
          <button onClick={loadAnalytics} disabled={mLoading} style={{ padding:'8px 14px', borderRadius:6, background:'#0a0e1a', border:'1px solid #1f2937', color:'#e6edf3', cursor:'pointer', marginBottom:10 }}>{mLoading?'Loading...':'Load latest analytics'}</button>
          {mAnalytics && <pre style={{ padding:10, background:'#0a0e1a', border:'1px solid #1f2937', borderRadius:6, fontSize:12, maxHeight:160, overflow:'auto' }}>{JSON.stringify(mAnalytics, null, 2)}</pre>}
          <div style={{ marginTop:12, borderTop:'1px solid #1f2937', paddingTop:12 }}>
            <div style={{ fontSize:13, marginBottom:8, fontWeight:600 }}>Schedule a post</div>
            <select value={mNetwork} onChange={e=>setMNetwork(e.target.value)} style={{ padding:'6px 10px', borderRadius:6, background:'#0a0e1a', border:'1px solid #1f2937', color:'#e6edf3', marginRight:8 }}>
              <option value='facebook'>Facebook</option><option value='instagram'>Instagram</option><option value='twitter'>X / Twitter</option><option value='linkedin'>LinkedIn</option><option value='tiktok'>TikTok</option><option value='youtube'>YouTube</option><option value='threads'>Threads</option>
            </select>
            <input type='datetime-local' value={mDate} onChange={e=>setMDate(e.target.value)} style={{ padding:'6px 10px', borderRadius:6, background:'#0a0e1a', border:'1px solid #1f2937', color:'#e6edf3' }} />
            <textarea value={mText} onChange={e=>setMText(e.target.value)} placeholder='Post text...' rows={3} style={{ width:'100%', marginTop:8, padding:10, borderRadius:6, background:'#0a0e1a', border:'1px solid #1f2937', color:'#e6edf3', fontFamily:'inherit' }} />
            <button onClick={schedulePost} disabled={!mText.trim()||!mDate} style={{ marginTop:8, padding:'8px 14px', borderRadius:6, background:'#10b981', color:'#fff', border:0, cursor:'pointer' }}>Schedule via Metricool</button>
            {mStatus && <div style={{ marginTop:8, fontSize:13, color: mStatus.startsWith('Error')?'#f87171':'#34d399' }}>{mStatus}</div>}
          </div>
        </section>

        <section style={{ background:'#0f172a', border:'1px solid #1f2937', borderRadius:12, padding:20 }}>
          <h2 style={{ marginTop:0, fontSize:16 }}>3. OpusClip - Long-form to Shorts</h2>
          <div style={{ fontSize:12, opacity:.7, marginBottom:10 }}>Paste a YouTube/Vimeo URL to auto-generate clips.</div>
          <input value={opUrl} onChange={e=>setOpUrl(e.target.value)} placeholder='https://youtube.com/watch?v=...' style={{ width:'100%', padding:10, borderRadius:6, background:'#0a0e1a', border:'1px solid #1f2937', color:'#e6edf3' }} />
          <button onClick={clipVideo} disabled={!opUrl.trim()} style={{ marginTop:10, padding:'8px 14px', borderRadius:6, background:'#8b5cf6', color:'#fff', border:0, cursor:'pointer' }}>Generate clips</button>
          {opStatus && <div style={{ marginTop:8, fontSize:13, color: opStatus.startsWith('Error')?'#f87171':'#a78bfa' }}>{opStatus}</div>}
        </section>

        <section style={{ background:'#0f172a', border:'1px solid #1f2937', borderRadius:12, padding:20, gridColumn:'1 / -1' }}>
          <h2 style={{ marginTop:0, fontSize:16 }}>4. Recent Drafts</h2>
          {safeDrafts.length===0 ? <div style={{ fontSize:13, opacity:.6 }}>No drafts yet. Generate something above.</div> : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:12 }}>
              {safeDrafts.slice(0,12).map((d:any,i:number)=>(
                <div key={(d && d.id) || i} style={{ padding:12, background:'#0a0e1a', border:'1px solid #1f2937', borderRadius:8 }}>
                  <div style={{ fontSize:11, opacity:.6, marginBottom:4 }}>{(d && d.provider)||'-'} - {(d && d.topic)||'-'}</div>
                  <div style={{ fontSize:13, maxHeight:80, overflow:'hidden' }}>{String((d && d.pack && (d.pack.instagram || d.pack.blog || d.pack.facebook || d.pack.linkedin)) || (d && (d.text||d.output)) || '').substring(0,200)}...</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
