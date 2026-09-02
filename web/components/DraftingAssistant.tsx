"use client";

import { useEffect, useRef, useState } from "react";
import { useVoiceAssistant } from "@/components/useVoiceAssistant";
import { useLiveContent } from "@/components/LiveContentProvider";
import { PanelLoader } from '@/components/LoadingScreen';

type Msg = { id: string; role: "assistant" | "user"; text: string; options?: string[] | null };
let __msgSeq = 0;
const uid = () => `m_${Date.now().toString(36)}_${(__msgSeq++).toString(36)}`;

export default function DraftingAssistant() {
  const { applyAssistantResult, setStatus } = useLiveContent();
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
  // This widget used to carry its own copy of the dashboard's Content
  // Generator — the same model buttons, format pills, idea box and Generate
  // button, a second time, in a 380px panel. Two places to do the identical
  // job, with no hint that they were the same, is the single most-cited
  // confusion in the audit. The chat itself already drafts, saves, researches
  // and schedules through its tools ("Draft an Instagram post … and save it"),
  // so the form was pure duplication. It is gone; the panel on the dashboard
  // is the one generator, and this is the one conversation.
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
          <PanelLoader scope="assistant" rounded="rounded-2xl" />
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
            {voice.active && (<div className="flex items-center gap-2 text-xs text-red-500"><span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /><span>Listening… speak your request.</span></div>)}
            {voice.connecting && (<div className="flex items-center gap-2 text-xs text-amber-600"><span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" /><span>Connecting… allow microphone access if your browser prompts you.</span></div>)}
            {voice.error && (<div className="rounded-md bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-700 ring-1 ring-red-200">{voice.error}</div>)}
            {busy && (<div className="flex items-center gap-2 text-xs text-ink/50"><span className="flex gap-1"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" /></span><span>Working on it… longer formats like a full blog can take up to a minute.</span></div>)}
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
