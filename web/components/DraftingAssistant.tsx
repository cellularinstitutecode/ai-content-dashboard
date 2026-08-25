"use client";

import { useEffect, useRef, useState } from "react";
import { useVoiceAssistant } from "@/components/useVoiceAssistant";
import { useLiveContent } from "@/components/LiveContentProvider";
import { announce } from "@/components/refreshBus";
import { useWorkspace } from "@/components/workspace";

type Msg = { id: string; role: "assistant" | "user"; text: string; options?: string[] | null };
let __msgSeq = 0;
const uid = () => `m_${Date.now().toString(36)}_${(__msgSeq++).toString(36)}`;

export default function DraftingAssistant() {
  const { applyAssistantResult, setStatus, setOutput } = useLiveContent();
  const workspace = useWorkspace();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [session, setSession] = useState<any>(null);
  const [input, setInput] = useState("");
  const voice = useVoiceAssistant(() => session, (data, command) => {
    if (command && command.trim()) setMsgs((m) => [...m, { id: uid(), role: "user", text: "\uD83C\uDF99\uFE0F " + command.trim() }]);
    if (data && data.session) setSession(data.session);
    if (data && data.message) setMsgs((m) => [...m, { id: uid(), role: "assistant", text: data.message, options: Array.isArray(data.options) ? data.options : null }]);
    applyAssistantResult(data);
  });
  const [busy, setBusy] = useState(false);
  const [genProvider, setGenProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [genModel, setGenModel] = useState('claude-sonnet-4-5');
  const [genFormat, setGenFormat] = useState('social');
  const [genIdea, setGenIdea] = useState('');
  // The assistant works on the same topic as the rest of the dashboard.
  useEffect(() => {
    const incoming = (workspace.topic || '').trim();
    if (incoming && incoming !== genIdea.trim()) setGenIdea(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.topic]);
  const [genOutput, setGenOutput] = useState('');
  const [genBusy, setGenBusy] = useState(false);
  const [genErr, setGenErr] = useState('');
  const [genKeywords, setGenKeywords] = useState<{ primary: string | null; keywords: string[]; source: string } | null>(null);

  const GEN_MODELS: Record<'anthropic' | 'openai', { value: string; label: string }[]> = {
    anthropic: [
      { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
      { value: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
    openai: [
      { value: 'gpt-4o', label: 'GPT-4o' },
      { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    ],
  };
  const GEN_FORMATS: { value: string; label: string }[] = [
    { value: 'social', label: 'Social Post' },
    { value: 'blog', label: 'Blog Article' },
    { value: 'email', label: 'Email Campaign' },
    { value: 'video', label: 'Video Script' },
    { value: 'ad', label: 'Ad Copy' },
  ];

  function pickProvider(p: 'anthropic' | 'openai') {
    setGenProvider(p);
    setGenModel(GEN_MODELS[p][0].value);
  }

  async function runGenerate() {
    if (!genIdea.trim()) { setGenErr('Describe your idea first.'); return; }
    setGenErr('');
    setGenBusy(true);
    setGenOutput('');
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: genIdea, provider: genProvider, model: genModel, type: genFormat }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to generate');
      const pack = data?.pack || {};
      const out = pack.instagram || pack.facebook || pack.linkedin || pack.blog || '';
      setGenOutput(out || 'No content returned.');
      // The chat path already routes through the shared Output pane; the
      // Generate tab used to keep its result trapped inside this widget.
      if (out) setOutput(out);
      workspace.setTopic(genIdea, { source: 'assistant' });
      // Surface the automatic Semrush keyword research that shaped this draft.
      const sem = pack._semrush || null;
      setGenKeywords(sem ? { primary: sem.primary ?? null, keywords: Array.isArray(sem.keywords) ? sem.keywords : [], source: String(sem.source || 'none') } : null);
      // Persist to Recent Drafts so nothing generated here is lost (parity with
      // the main dashboard + chat flows). Stamp the chosen format on the pack so
      // the renderer can label it faithfully (email/video/ad).
      try {
        await fetch('/api/drafts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: genIdea, pack: { ...pack, format: genFormat }, provider: genProvider }),
        });
        // Interconnection: the new draft should appear in Recent Drafts, the
        // stat cards and the Image Studio immediately, not after a reload.
        announce('drafts', 'stats');
      } catch {}
    } catch (e: any) {
      setGenErr(e?.message || 'Failed to generate');
    } finally {
      setGenBusy(false);
    }
  }
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, open]);

  async function send(text: string) {
    if (busy) return;
    const clean = text.trim();
        if (clean) setMsgs((m) => [...m, { id: uid(), role: "user", text: clean }]);
    setInput("");
    setBusy(true);
    try {
      setStatus("thinking");
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, text: clean }),
      });
      const _raw = await res.text();
      let data: any = null;
      try { data = _raw ? JSON.parse(_raw) : null; } catch { data = null; }
      if (!data) {
        const _timedOut = res.status === 504 || /FUNCTION_INVOCATION_TIMEOUT/i.test(_raw);
        throw new Error(
          _timedOut
            ? "That request took too long and timed out. Long formats like a full blog article can exceed the limit — try a shorter format (for example a social post or an outline), then expand it."
            : "The assistant returned an unexpected response (status " + res.status + "). Please try again."
        );
      }
      applyAssistantResult(data);
      if (data.error) {
        setMsgs((m) => [...m, { id: uid(), role: "assistant", text: "\u26a0\ufe0f " + data.error }]);
      } else {
        setSession(data.session);
        setMsgs((m) => [
          ...m,
          { id: uid(), role: "assistant", text: data.message, options: Array.isArray(data.options) ? data.options : null },
        ]);
      }
    } catch (e: any) {
      setMsgs((m) => [...m, { id: uid(), role: "assistant", text: "\u26a0\ufe0f " + (e?.message || "Network error") }]);
    } finally {
      setBusy(false);
    }
  }

  function start() {
    setOpen(true);
    if (msgs.length === 0) send("");
  }

  return (
    <>
      {!open && (
        <button
          onClick={start}
          aria-label="Open drafting assistant"
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg transition hover:scale-105 active:scale-95"
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      )}

      {open && (
        <div className="fixed bottom-6 right-6 z-50 flex h-[560px] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl ring-1 ring-black/10">
          <header className="flex items-center justify-between gap-2 border-b border-black/5 px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M12 2.5l1.9 5.1a4 4 0 0 0 2.5 2.5l5.1 1.9-5.1 1.9a4 4 0 0 0-2.5 2.5L12 21.5l-1.9-5.1a4 4 0 0 0-2.5-2.5L2.5 12l5.1-1.9a4 4 0 0 0 2.5-2.5L12 2.5z" />
                </svg>
              </span>
              <div className="min-w-0 leading-tight">
                <p className="truncate text-sm font-semibold text-ink">Drafting Assistant</p>
                <p className="truncate text-xs text-ink/50">Draft, review &amp; schedule</p>
              </div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close" className="shrink-0 rounded-full p-1 text-ink/40 hover:bg-black/5 hover:text-ink">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {/* Content Generator — first thing shown in the assistant */}
            <div className="rounded-2xl bg-canvas p-3 ring-1 ring-black/10">
              <p className="text-sm font-semibold text-ink">Content Generator</p>
              <p className="mb-3 text-xs text-ink/50">Pick a model and format, describe your idea, and generate a ready-to-post pack.</p>
            
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink/40">Model</label>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {(["anthropic", "openai"] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => pickProvider(p)}
                    className={"rounded-full px-3 py-1.5 text-xs font-medium transition ring-1 ring-black/10 " + (genProvider === p ? "bg-ink text-white" : "bg-surface text-ink hover:bg-black/5")}
                  >
                    {p === "anthropic" ? "Claude (Anthropic)" : "OpenAI"}
                  </button>
                ))}
                <select
                  value={genModel}
                  onChange={(e) => setGenModel(e.target.value)}
                  className="rounded-full bg-surface px-3 py-1.5 text-xs text-ink outline-none ring-1 ring-black/10 focus:ring-accent/40"
                >
                  {GEN_MODELS[genProvider].map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
            
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink/40">Format</label>
              <div className="mb-3 flex flex-wrap gap-2">
                {GEN_FORMATS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    onClick={() => setGenFormat(f.value)}
                    className={"rounded-full px-3 py-1.5 text-xs font-medium transition ring-1 ring-black/10 " + (genFormat === f.value ? "bg-accent text-white" : "bg-surface text-ink hover:bg-black/5")}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink/40">Your idea</label>
              <textarea
                value={genIdea}
                onChange={(e) => setGenIdea(e.target.value)}
                rows={3}
                placeholder="e.g. 3 Instagram captions about exosome therapy benefits for athletes"
                className="mb-3 w-full resize-none rounded-xl bg-surface px-3 py-2 text-sm text-ink outline-none ring-1 ring-black/10 focus:ring-accent/40"
              />
            
              <button
                type="button"
                onClick={runGenerate}
                disabled={genBusy || !genIdea.trim()}
                className="w-full rounded-full bg-accent px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {genBusy ? "Generating…" : "Generate"}
              </button>
            
              {genErr && <p className="mt-2 text-xs text-red-600">{genErr}</p>}
            
              {genOutput && (
                <div className="mt-3">
                  <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink/40">Output</p>
                  {genKeywords && genKeywords.source === 'semrush' && (
                    <div className="mb-1.5 flex flex-wrap items-center gap-1">
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">🔑 Semrush ✓</span>
                      {genKeywords.keywords.slice(0, 4).map((k, ki) => (
                        <span key={k + ki} className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-800 ring-1 ring-emerald-200">{k}</span>
                      ))}
                    </div>
                  )}
                  {genKeywords && genKeywords.source !== 'semrush' && (
                    <p className="mb-1.5 text-[10px] text-ink/40">Generated without live Semrush keyword data.</p>
                  )}
                  <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl bg-surface px-3 py-2 text-sm leading-relaxed text-ink ring-1 ring-black/10">{genOutput}</div>
                  <button
                    type="button"
                    onClick={() => setInput(genOutput)}
                    className="mt-2 rounded-full border border-accent/30 bg-accent/5 px-3 py-1 text-xs font-medium text-accent transition hover:bg-accent/10"
                  >
                    Use in chat
                  </button>
                </div>
              )}
            </div>
            
{msgs.every((m) => m.role !== "user") && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-ink/40">Try asking</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    "Draft an Instagram post about our stem cell therapy and save it",
                    "Turn this YouTube video into clips: ",
                    "Research trending topics about regenerative medicine",
                    "Write a blog article about exosome therapy",
                  ].map((q) => (
                    <button key={q} type="button" disabled={busy} onClick={() => send(q)}
                      className="rounded-full border border-accent/30 bg-accent/5 px-3 py-1 text-left text-xs font-medium text-accent transition hover:bg-accent/10 disabled:opacity-50">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
                        {msgs.map((m) => (
                              <div key={m.id}>
                <div className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div className={(m.role === "user" ? "bg-accent text-white" : "bg-canvas text-ink") + " max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed"}>
                    {m.text}
                  </div>
                </div>
                {m.role === "assistant" && m.options && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {m.options.map((o) => (
                      <button key={o} onClick={() => send(o)} disabled={busy} className="rounded-full border border-accent/30 bg-accent/5 px-3 py-1 text-xs font-medium text-accent transition hover:bg-accent/10 disabled:opacity-50">
                        {o}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {voice.active && (<div className="flex items-center gap-2 text-xs text-red-500"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /><span>Listening\u2026 speak your request.</span></div>)}
            {voice.connecting && (<div className="flex items-center gap-2 text-xs text-amber-600"><span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" /><span>Connecting\u2026 allow microphone access if your browser prompts you.</span></div>)}
            {voice.error && (<div className="rounded-md bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 ring-1 ring-red-200">{voice.error}</div>)}
            {busy && (<div className="flex items-center gap-2 text-xs text-ink/50"><span className="flex gap-1"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" /></span><span>Working on it\u2026 longer formats like a full blog can take up to a minute.</span></div>)}
            <div ref={endRef} />
          </div>

          <form
                      onSubmit={(e) => {
                                    e.preventDefault();
                                    if (input.trim()) send(input);
                      }}
                      className="flex items-center gap-2 border-t border-black/5 px-3 py-3"
                    >
                    <input
                                  value={input}
                                  onChange={(e) => setInput(e.target.value)}
                                  placeholder="Type your message…"
                                  className="min-w-0 flex-1 rounded-full bg-canvas px-4 py-2 text-sm text-ink outline-none ring-1 ring-black/5 focus:ring-accent/40"
                                />
          <button
                                  type="button"
                                  onClick={() => { if (voice.active) { voice.stop(); } else if (!voice.connecting) { voice.start(); } }}
                                  disabled={busy || voice.connecting}
                                  aria-label={voice.active ? "Stop voice" : voice.connecting ? "Connecting" : "Start voice"}
                                  className={"flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium transition hover:scale-105 disabled:opacity-40 " + (voice.active ? "bg-red-500 text-white animate-pulse" : voice.connecting ? "bg-amber-400 text-white animate-pulse" : "bg-canvas text-ink ring-1 ring-black/5")}
                                >
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="22" /></svg>
                                  <span>{voice.active ? "Stop" : voice.connecting ? "Connecting\u2026" : "Voice"}</span>
                                </button>
          <button type="submit" disabled={busy || !input.trim()} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white transition hover:scale-105 disabled:opacity-40"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg></button>
          </form>
        </div>
      )}
    </>
  );
}
