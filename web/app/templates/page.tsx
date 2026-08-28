'use client';

import { useEffect, useRef, useState } from 'react';
import PageNav from '@/components/PageNav';
import { announce, onRefresh } from '@/components/refreshBus';
import { useWorkspace } from '@/components/workspace';

type Provider = 'instagram' | 'facebook' | 'linkedin' | 'blog';
type AiProvider = 'anthropic' | 'openai';

type StrategyMode = 'off' | 'fixed_topic' | 'pillars' | 'auto';

type Strategy = {
  mode: StrategyMode;
  topic?: string;
  pillars?: string[];
  goal?: 'rank' | 'traffic' | 'engagement' | 'authority';
  format?: 'social' | 'blog' | 'email' | 'video' | 'ad';
  lead_hours?: number;
};

type Template = {
  id?: string;
  name?: string;
  providers?: string[];
  text?: string;
  weekdays?: number[];
  time_of_day?: string;
  active?: boolean;
  strategy?: Strategy;
};

const MODE_LABELS: Record<StrategyMode, string> = {
  off: 'Static text (classic)',
  fixed_topic: 'Autopilot · fixed topic',
  pillars: 'Autopilot · rotate pillars',
  auto: 'Autopilot · full auto',
};

type CompareResults = {
  anthropic?: string;
  openai?: string;
  anthropicErr?: string;
  openaiErr?: string;
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PROVIDERS: Provider[] = ['instagram', 'facebook', 'linkedin', 'blog'];
const APPLY_WEEKS = 4;

const card: React.CSSProperties = {
  background: '#ffffff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 12, padding: 28,
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: 10, borderRadius: 6, background: '#f5f5f7',
  border: '1px solid rgba(0,0,0,0.1)', color: '#1d1d1f', marginTop: 8, boxSizing: 'border-box',
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
  return {
    name: '', providers: [], text: '', weekdays: [], time_of_day: '09:00', active: true,
    strategy: { mode: 'off', pillars: [], goal: 'rank', format: 'social', lead_hours: 24 },
  };
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && data.error) || 'Request failed (' + res.status + ')');
  }
  return data as T;
}

function draftedFromPack(pack: Record<string, string> | undefined): string {
  const p = pack || {};
  return p.instagram || p.facebook || p.linkedin || p.blog || '';
}

async function callGenerate(topic: string, provider: AiProvider): Promise<string> {
  const data = await api<{ pack?: Record<string, string> }>('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic,
      provider,
      model: provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o',
      type: 'social',
    }),
  });
  return draftedFromPack(data.pack);
}

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [draft, setDraft] = useState<Template>(emptyDraft());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [aiTopic, setAiTopic] = useState('');
  const [aiProvider, setAiProvider] = useState<AiProvider>('anthropic');
  const [aiBusy, setAiBusy] = useState(false);
  const [compareBusy, setCompareBusy] = useState(false);
  const [compareResults, setCompareResults] = useState<CompareResults | null>(null);
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const workspace = useWorkspace();
  const loadSeq = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Templates drive the Autopilot queue, so a change made anywhere else on the
  // dashboard (or by the engine itself) refetches this list.
  useEffect(() => onRefresh((scopes) => {
    if (scopes.includes('templates') || scopes.includes('autopilot')) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  // The topic the user is working on follows them here from the generator and
  // from Semrush, instead of having to be retyped.
  useEffect(() => {
    if (workspace.topic && !aiTopic) setAiTopic(workspace.topic);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.topic]);

  async function load(signal?: AbortSignal) {
    const seq = ++loadSeq.current;
    setLoading(true);
    setErr(null);
    try {
      const j = await api<{ templates?: Template[] }>('/api/templates', { signal });
      if (seq !== loadSeq.current) return; // stale response, ignore
      setTemplates(Array.isArray(j.templates) ? j.templates : []);
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') return;
      if (seq === loadSeq.current) setErr(errMsg(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  async function draftWithAI() {
    if (!aiTopic.trim()) { setErr('Enter a topic for the AI to draft from.'); return; }
    setErr(null);
    setAiBusy(true);
    try {
      const drafted = await callGenerate(aiTopic, aiProvider);
      setDraft((prev) => ({ ...prev, text: drafted }));
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setAiBusy(false);
    }
  }

  async function draftWithBoth() {
    if (!aiTopic.trim()) { setErr('Enter a topic for the AI to draft from.'); return; }
    setErr(null);
    setCompareBusy(true);
    setCompareResults(null);
    const [a, o] = await Promise.allSettled([
      callGenerate(aiTopic, 'anthropic'),
      callGenerate(aiTopic, 'openai'),
    ]);
    setCompareResults({
      anthropic: a.status === 'fulfilled' ? a.value : undefined,
      anthropicErr: a.status === 'rejected' ? errMsg(a.reason) : undefined,
      openai: o.status === 'fulfilled' ? o.value : undefined,
      openaiErr: o.status === 'rejected' ? errMsg(o.reason) : undefined,
    });
    setCompareBusy(false);
  }

  async function save() {
    if (!draft.name?.trim()) { setErr('Give the template a name before saving.'); return; }
    setSaving(true);
    setStatus(null);
    setErr(null);
    try {
      await api('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      setDraft(emptyDraft());
      setStatus('Template saved.');
      await load();
      announce('templates', 'autopilot');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id?: string) {
    if (!id) return;
    const t = templates.find((x) => x.id === id);
    const label = t?.name ? '"' + t.name + '"' : 'this template';
    if (!window.confirm('Delete ' + label + '? This cannot be undone.')) return;
    setErr(null);
    setRemovingId(id);
    try {
      await api('/api/templates?id=' + encodeURIComponent(id), { method: 'DELETE' });
      await load();
      announce('templates', 'autopilot');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setRemovingId(null);
    }
  }

  async function apply(id?: string) {
    if (!id) return;
    if (applyingId) return;                       // one apply at a time: a double click used to double-book the calendar
    if (!window.confirm(
      'Send this template\'s posts for the next ' + APPLY_WEEKS + ' weeks to Metricool?\n\n' +
      'They are created as drafts for review — nothing publishes until you approve it in Metricool. ' +
      'You can delete any of them from the publishing queue.'
    )) return;
    setStatus(null);
    setErr(null);
    setApplyingId(id);
    try {
      const j = await api<{ created?: number; skipped?: number; failed?: number; message?: string }>('/api/templates/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, weeks: APPLY_WEEKS }),
      });
      // The route now says exactly what happened - how many reached Metricool,
      // how many were already there, how many failed. It used to report
      // "Scheduled N posts" for rows that were never sent anywhere at all.
      setStatus(j.message || ('Sent ' + (j.created || 0) + ' posts to Metricool for review.'));
      // The biggest mutation in the app: it creates weeks of posts. Every
      // panel that shows posts, counts or the Autopilot queue hears about it.
      announce('posts', 'stats', 'autopilot', 'insights');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setApplyingId(null);
    }
  }

  return (
    <main style={{ minHeight: '100vh', background: '#f5f5f7', color: '#1d1d1f', fontFamily: '-apple-system,Segoe UI,sans-serif' }}>
      <header style={{ padding: '20px 32px', borderBottom: '1px solid rgba(0,0,0,0.1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Schedule Templates</h1>
          <div style={{ fontSize: 13, opacity: .6, marginTop: 4 }}>Reusable weekly posting cadences. Apply one to generate upcoming scheduled posts.</div>
        </div>
        <PageNav current="/templates" />
      </header>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: 24, display: 'grid', gap: 24 }}>
        {err && <div role="alert" aria-live="assertive" style={{ color: '#d70015', fontSize: 14 }}>Error: {err}</div>}
        {status && <div role="status" aria-live="polite" style={{ color: '#248a3d', fontSize: 14 }}>{status}</div>}

        <section style={card}>
          <h2 style={{ marginTop: 0, marginBottom: 20, fontSize: 17 }}>New template</h2>

          <label style={{ fontSize: 13, opacity: .8 }}>Name
            <input style={inputStyle} value={draft.name || ''} onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))} placeholder="e.g. Weekly product tips" />
          </label>

          <div style={{ marginTop: 22, fontSize: 13, opacity: .8 }} id="providers-label">Providers</div>
          <div role="group" aria-labelledby="providers-label" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {PROVIDERS.map((p) => {
              const selected = (draft.providers || []).includes(p);
              return (
                <button key={p} type="button" aria-pressed={selected}
                  onClick={() => setDraft((prev) => ({ ...prev, providers: toggle(prev.providers || [], p) }))}
                  style={{ ...ghost, background: selected ? '#0071e3' : '#f5f5f7', color: selected ? '#fff' : '#1d1d1f' }}>
                  {p}
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 22, fontSize: 13, opacity: .8 }} id="weekdays-label">Days of week</div>
          <div role="group" aria-labelledby="weekdays-label" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
            {DOW.map((d, i) => {
              const selected = (draft.weekdays || []).includes(i);
              return (
                <button key={d} type="button" aria-pressed={selected} aria-label={d}
                  onClick={() => setDraft((prev) => ({ ...prev, weekdays: toggle(prev.weekdays || [], i) }))}
                  style={{ ...ghost, background: selected ? '#0071e3' : '#f5f5f7', color: selected ? '#fff' : '#1d1d1f' }}>
                  {d}
                </button>
              );
            })}
          </div>

          <label style={{ display: 'block', marginTop: 22, fontSize: 13, opacity: .8 }}>Time of day
            <input type="time" style={{ ...inputStyle, width: 160 }} value={draft.time_of_day || '09:00'} onChange={(e) => setDraft((prev) => ({ ...prev, time_of_day: e.target.value }))} />
          </label>

          {/* Autopilot: how the engine treats each occurrence of this template. */}
          <div style={{ marginTop: 22, padding: 16, borderRadius: 10, background: '#f0f6ff', border: '1px solid #cfe3ff' }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Autopilot</div>
            <div style={{ fontSize: 12, opacity: .7, marginTop: 2 }}>
              In Autopilot modes each scheduled slot gets a FRESH post: the engine researches keywords
              and rankings, picks a distinct angle every week, drafts, scores, and waits for your approval
              on the dashboard. It never publishes by itself.
            </div>
            <label style={{ display: 'block', marginTop: 12, fontSize: 13, opacity: .8 }}>Mode
              <select
                style={{ ...inputStyle, width: 260 }}
                value={draft.strategy?.mode || 'off'}
                onChange={(e) => setDraft((prev) => ({
                  ...prev,
                  strategy: { ...(prev.strategy || { mode: 'off' }), mode: e.target.value as StrategyMode },
                }))}
              >
                {(Object.keys(MODE_LABELS) as StrategyMode[]).map((m) => (
                  <option key={m} value={m}>{MODE_LABELS[m]}</option>
                ))}
              </select>
            </label>
            {draft.strategy?.mode === 'fixed_topic' && (
              <label style={{ display: 'block', marginTop: 12, fontSize: 13, opacity: .8 }}>Topic
                <input
                  style={inputStyle}
                  value={draft.strategy?.topic || ''}
                  placeholder="e.g. stem cell therapy for knees"
                  onChange={(e) => setDraft((prev) => ({
                    ...prev,
                    strategy: { ...(prev.strategy || { mode: 'fixed_topic' }), topic: e.target.value },
                  }))}
                />
              </label>
            )}
            {(draft.strategy?.mode === 'pillars' || draft.strategy?.mode === 'auto') && (
              <label style={{ display: 'block', marginTop: 12, fontSize: 13, opacity: .8 }}>Content pillars (one per line — occurrences rotate through them)
                <textarea
                  style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }}
                  value={(draft.strategy?.pillars || []).join('\n')}
                  placeholder={'stem cell therapy for knees\nexosome therapy\nanti-aging treatments'}
                  onChange={(e) => setDraft((prev) => ({
                    ...prev,
                    strategy: {
                      ...(prev.strategy || { mode: 'pillars' }),
                      pillars: e.target.value.split('\n').map((l) => l.trim()).filter(Boolean),
                    },
                  }))}
                />
              </label>
            )}
            {draft.strategy?.mode !== 'off' && (
              <div style={{ display: 'flex', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
                <label style={{ fontSize: 13, opacity: .8 }}>Goal
                  <select
                    style={{ ...inputStyle, width: 160 }}
                    value={draft.strategy?.goal || 'rank'}
                    onChange={(e) => setDraft((prev) => ({
                      ...prev,
                      strategy: { ...(prev.strategy || { mode: 'auto' }), goal: e.target.value as Strategy['goal'] },
                    }))}
                  >
                    <option value="rank">Rank in search</option>
                    <option value="traffic">Drive clicks</option>
                    <option value="engagement">Engagement</option>
                    <option value="authority">Authority</option>
                  </select>
                </label>
                <label style={{ fontSize: 13, opacity: .8 }}>Format
                  <select
                    style={{ ...inputStyle, width: 150 }}
                    value={draft.strategy?.format || 'social'}
                    onChange={(e) => setDraft((prev) => ({
                      ...prev,
                      strategy: { ...(prev.strategy || { mode: 'auto' }), format: e.target.value as Strategy['format'] },
                    }))}
                  >
                    <option value="social">Social post</option>
                    <option value="blog">Blog article</option>
                    <option value="email">Email</option>
                    <option value="video">Video script</option>
                    <option value="ad">Ad copy</option>
                  </select>
                </label>
                <label style={{ fontSize: 13, opacity: .8 }}>Prepare drafts (hours before slot)
                  <input
                    type="number" min={1} max={96}
                    style={{ ...inputStyle, width: 120 }}
                    value={draft.strategy?.lead_hours ?? 24}
                    onChange={(e) => setDraft((prev) => ({
                      ...prev,
                      strategy: { ...(prev.strategy || { mode: 'auto' }), lead_hours: parseInt(e.target.value, 10) || 24 },
                    }))}
                  />
                </label>
              </div>
            )}
          </div>

          <div style={{ marginTop: 22, fontSize: 13, opacity: .8 }}>Draft with AI</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
            <label style={{ fontSize: 13, opacity: .8 }} htmlFor="ai-provider">Model</label>
            <select id="ai-provider" value={aiProvider} onChange={(e) => setAiProvider(e.target.value as AiProvider)}
              style={{ ...inputStyle, width: 140, marginTop: 0 }}>
              <option value="anthropic">Claude</option>
              <option value="openai">GPT</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <label htmlFor="ai-topic" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Topic</label>
            <input id="ai-topic" style={{ ...inputStyle, flex: 1, marginTop: 0 }} value={aiTopic}
              onChange={(e) => setAiTopic(e.target.value)}
              placeholder="What should this post be about?" />
            <button type="button" onClick={draftWithAI} disabled={aiBusy}
              style={{ ...btn, whiteSpace: 'nowrap', opacity: aiBusy ? 0.6 : 1 }}>
              {aiBusy ? 'Drafting…' : 'Draft with AI'}
            </button>
            <button type="button" onClick={draftWithBoth} disabled={compareBusy}
              style={{ ...ghost, whiteSpace: 'nowrap', opacity: compareBusy ? 0.6 : 1 }}>
              {compareBusy ? 'Comparing…' : 'Compare both'}
            </button>
          </div>

          {compareResults && (
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {(['anthropic', 'openai'] as const).map((key) => {
                const isErr = key === 'anthropic' ? compareResults.anthropicErr : compareResults.openaiErr;
                const value = key === 'anthropic' ? compareResults.anthropic : compareResults.openai;
                return (
                  <div key={key} style={{ background: '#fff', border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, padding: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{key === 'anthropic' ? 'Claude' : 'GPT'}</div>
                    <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: 8, color: isErr ? '#d70015' : '#1d1d1f' }}>
                      {isErr || value || 'No content.'}
                    </div>
                    {value && (
                      <button type="button" style={btn} onClick={() => setDraft((prev) => ({ ...prev, text: value }))}>Use this draft</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <label style={{ display: 'block', marginTop: 22, fontSize: 13, opacity: .8 }}>Post text
            <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }} value={draft.text || ''} onChange={(e) => setDraft((prev) => ({ ...prev, text: e.target.value }))} placeholder="What should each scheduled post say?" />
          </label>

          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button style={{ ...btn, opacity: saving ? 0.6 : 1 }} onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save template'}</button>
            <button style={ghost} type="button" onClick={() => setDraft(emptyDraft())}>Clear</button>
          </div>
        </section>

        <section>
          <h2 style={{ fontSize: 16 }}>Your templates</h2>
          {loading && <div style={{ opacity: .6, fontSize: 14 }}>Loading…</div>}
          {!loading && templates.length === 0 && (
            <div style={{ opacity: .6, fontSize: 14 }}>No templates yet. Create one above.</div>
          )}
          <div style={{ display: 'grid', gap: 12 }}>
            {templates.map((t) => (
              <div key={t.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, marginBottom: 4 }}>{t.name || 'Untitled template'}</div>
                  <div style={{ fontSize: 12, opacity: .7 }}>
                    {(t.weekdays || []).map((w) => DOW[w]).join(', ') || 'no days'} at {t.time_of_day || '09:00'} · {(t.providers || []).join(', ') || 'no providers'}
                  </div>
                  {t.strategy && t.strategy.mode !== 'off' && (
                    <div style={{ display: 'inline-block', marginTop: 6, fontSize: 11, fontWeight: 600, color: '#0b57d0', background: '#e8f0fe', borderRadius: 999, padding: '3px 10px' }}>
                      {MODE_LABELS[t.strategy.mode] || 'Autopilot'} · {t.strategy.goal || 'rank'} · fresh post per slot
                    </div>
                  )}
                  {t.text && <div style={{ fontSize: 13, opacity: .85, marginTop: 6, whiteSpace: 'pre-wrap' }}>{t.text}</div>}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button
                    style={{ ...btn, opacity: applyingId === t.id ? 0.6 : 1 }}
                    onClick={() => apply(t.id)}
                    disabled={applyingId === t.id || removingId === t.id}
                  >
                    {applyingId === t.id ? 'Scheduling…' : 'Apply'}
                  </button>
                  <button
                    style={{ ...ghost, opacity: removingId === t.id ? 0.6 : 1 }}
                    onClick={() => remove(t.id)}
                    disabled={removingId === t.id || applyingId === t.id}
                  >
                    {removingId === t.id ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
