"use client";

import { useEffect, useRef, useState } from "react";

type Msg = { role: "assistant" | "user"; text: string; options?: string[] | null };

export default function DraftingAssistant() {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [session, setSession] = useState<any>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, open]);

  async function send(text: string) {
    if (busy) return;
    const clean = text.trim();
    if (clean) setMsgs((m) => [...m, { role: "user", text: clean }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, text: clean }),
      });
      const data = await res.json();
      if (data.error) {
        setMsgs((m) => [...m, { role: "assistant", text: "\u26a0\ufe0f " + data.error }]);
      } else {
        setSession(data.session);
        setMsgs((m) => [
          ...m,
          { role: "assistant", text: data.message, options: data.options },
        ]);
      }
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "assistant", text: "\u26a0\ufe0f " + (e?.message || "Network error") }]);
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
          <header className="flex items-center justify-between border-b border-black/5 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent/10 text-accent">\u2726</span>
              <div>
                <p className="text-sm font-semibold text-ink">Drafting Assistant</p>
                <p className="text-xs text-ink/50">Draft, review &amp; schedule</p>
              </div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close" className="rounded-full p-1 text-ink/40 hover:bg-black/5 hover:text-ink">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {msgs.map((m, i) => (
              <div key={i}>
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
            {busy && <div className="text-xs text-ink/40">Thinking\u2026</div>}
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
              placeholder="Type your message\u2026"
              className="flex-1 rounded-full bg-canvas px-4 py-2 text-sm text-ink outline-none ring-1 ring-black/5 focus:ring-accent/40"
            />
            <button type="submit" disabled={busy || !input.trim()} className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-white transition hover:scale-105 disabled:opacity-40">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></svg>
            </button>
          </form>
        </div>
      )}
    </>
  );
}
