"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useVoiceAssistant } from "@/components/useVoiceAssistant";
import { useLiveContent } from "@/components/LiveContentProvider";
import { PanelLoader } from '@/components/LoadingScreen';
import { OPENING_LINE, pageContext, splitNextStep } from '@/lib/assistant-standby';
import { clearFocus, getFocus, isPointing, resolveFocus, setFocus, setPointing, subscribeFocus, type AiFocus } from '@/components/aiFocus';

// The conversation survives a page change and a reload: the panel used to
// be remounted empty by every full navigation (the nav links were plain
// anchors), cutting off whatever was being said. State lives in
// sessionStorage for the tab's lifetime; a new tab starts fresh.
const STORE_KEY = 'assistant:panel:v1';
type Stored = { open: boolean; msgs: Msg[]; session: unknown; input: string };
function readStore(): Stored | null {
  try { const raw = window.sessionStorage.getItem(STORE_KEY); return raw ? (JSON.parse(raw) as Stored) : null; } catch { return null; }
}
function writeStore(s: Stored) {
  try { window.sessionStorage.setItem(STORE_KEY, JSON.stringify({ ...s, msgs: s.msgs.slice(-60) })); } catch { /* private mode, full storage: the panel still works for this page */ }
}

type Msg = { id: string; role: "assistant" | "user"; text: string; options?: string[] | null; image?: { url: string; alt?: string | null } | null; /** The trail of what was done to answer, kept with the answer as a guide. */ steps?: string[] | null };
let __msgSeq = 0;
const uid = () => `m_${Date.now().toString(36)}_${(__msgSeq++).toString(36)}`;

export default function DraftingAssistant() {
  const { applyAssistantResult, setStatus } = useLiveContent();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [session, setSession] = useState<any>(null);
  const [input, setInput] = useState("");
  const [restored, setRestored] = useState(false);
  const pathname = usePathname();
  const here = pageContext(pathname);
  // Restore once, on mount; then keep the store current.
  useEffect(() => {
    const s = readStore();
    if (s) { setOpen(Boolean(s.open)); setMsgs(Array.isArray(s.msgs) ? s.msgs : []); setSession(s.session ?? null); setInput(String(s.input || '')); }
    setRestored(true);
  }, []);
  useEffect(() => { if (restored) writeStore({ open, msgs, session, input }); }, [restored, open, msgs, session, input]);
  const voice = useVoiceAssistant(() => session, (data, command) => {
    if (command && command.trim()) setMsgs((m) => [...m, { id: uid(), role: "user", text: "\uD83C\uDF99\uFE0F " + command.trim() }]);
    if (data && data.session) setSession(data.session);
    if (data && data.message) setMsgs((m) => [...m, { id: uid(), role: "assistant", text: data.message, options: Array.isArray(data.options) ? data.options : null }]);
    applyAssistantResult(data);
  });
  const [busy, setBusy] = useState(false);
  // WHAT THE USER IS POINTING AT (components/aiFocus.ts). With the panel open,
  // Alt-click anywhere — or "Point at something", then a click — picks the
  // card under the pointer, outlines it in blue, and it goes with the next
  // message. The click itself is swallowed, so pointing at a button does not
  // press it.
  const [focus, setFocusState] = useState<AiFocus | null>(null);
  const [pointing, setPointingState] = useState(false);
  useEffect(() => subscribeFocus(() => { setFocusState(getFocus()); setPointingState(isPointing()); }), []);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!(e.altKey || isPointing())) return;
      const target = e.target as Element | null;
      if (target?.closest?.('[data-ai-panel]')) return; // the panel itself is never the subject
      const hit = resolveFocus(target);
      e.preventDefault(); e.stopPropagation();
      if (hit) setFocus(hit.focus, hit.el); else setPointing(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (isPointing()) setPointing(false); else if (getFocus()) clearFocus(); } };
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey); };
  }, [open]);
  useEffect(() => {
    if (pointing) document.documentElement.setAttribute('data-ai-pointing', '1'); else document.documentElement.removeAttribute('data-ai-pointing');
    return () => document.documentElement.removeAttribute('data-ai-pointing');
  }, [pointing]);
  /** What the assistant is doing right now, as the route reports it (in blue, as it goes). */
  const [steps, setSteps] = useState<string[]>([]);
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
    setSteps([]);
    const trail: string[] = [];
    try {
      setStatus("thinking");
      const res = await fetch("/api/assistant", {
        method: "POST",
        // Newline-delimited JSON: each step as it starts, the answer last.
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        // Where the user is goes with every message, so the answer is about
        // the screen in front of them (lib/assistant-standby.ts pageContext).
        body: JSON.stringify({ session, text: clean, page: pathname, focus: getFocus() }),
      });
      let _raw = "";
      let data: any = null;
      if ((res.headers.get("content-type") || "").includes("application/x-ndjson") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const take = (line: string) => {
          if (!line.trim()) return;
          let evt: any = null;
          try { evt = JSON.parse(line); } catch { return; }
          if (evt && typeof evt.step === "string") { trail.push(evt.step); setSteps([...trail]); }
          else if (evt && evt.done) data = evt.done;
          else if (evt && evt.error) data = { error: String(evt.error) };
        };
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n");
          while (nl >= 0) { take(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1); nl = buffer.indexOf("\n"); }
        }
        take(buffer);
      } else {
        _raw = await res.text();
        try { data = _raw ? JSON.parse(_raw) : null; } catch { data = null; }
      }
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
        const image = data.options && !Array.isArray(data.options) && data.options.image?.url ? data.options.image : null;
        // A trailing "Next: …" line is the assistant a step ahead: shown as a
        // chip to press, never taken by itself.
        const { text: shown, next } = splitNextStep(String(data.message || ''));
        const chips = Array.isArray(data.options) ? data.options : [];
        setMsgs((m) => [
          ...m,
          { id: uid(), role: "assistant", text: shown, options: next ? [next, ...chips] : (chips.length ? chips : null), image, steps: trail.length ? [...trail] : null },
        ]);
      }
    } catch (e: any) {
      setMsgs((m) => [...m, { id: uid(), role: "assistant", text: "\u26a0\ufe0f " + (e?.message || "Network error") }]);
    } finally {
      setBusy(false);
      setSteps([]);
    }
  }

  function start() {
    setOpen(true);
    // One line of its own, no request: the assistant waits for a command. It
    // used to open by asking the server for a status report and an offer to
    // retry whatever was stuck (lib/assistant-standby.ts).
    if (msgs.length === 0) setMsgs([{ id: uid(), role: "assistant", text: OPENING_LINE, options: here.chips }]);
  }
  const onStandby = Boolean(session?.standby);

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
        <div className={"fixed bottom-6 right-6 z-50 flex h-[560px] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl transition-shadow " +
          // Outlined in blue while a turn is in flight; quiet otherwise.
          (busy ? "ring-2 ring-accent shadow-[0_0_0_6px_rgba(0,113,227,0.18)]" : onStandby ? "ring-1 ring-amber-300" : "ring-1 ring-black/10")} data-ai-panel="1">
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
                <p className="flex items-center gap-1.5 truncate text-xs text-ink/50">
                  <span className={"inline-block h-1.5 w-1.5 shrink-0 rounded-full " + (busy ? "animate-pulse bg-accent" : onStandby ? "bg-amber-400" : "bg-emerald-500")} aria-hidden />
                  {busy ? "Working…" : onStandby ? "On standby — say “resume”" : "Watching " + here.label + " · standing by"}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPointing(!pointing)}
              title={pointing ? "Click anything on the page to point the assistant at it (Esc to stop)" : "Point at something on the page, so “this” means it. Alt-click does the same any time."}
              aria-pressed={pointing}
              className={"shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition " + (pointing ? "bg-accent text-white ring-accent" : focus ? "bg-accent/10 text-accent ring-accent/30" : "text-ink/60 ring-black/10 hover:bg-black/5")}
            >
              {pointing ? "Click it…" : "Point at something"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => send(onStandby ? "resume" : "standby")}
              title={onStandby ? "Put the assistant back to work" : "Park the assistant: it keeps watching, and does nothing until you say resume"}
              className={"shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition disabled:opacity-40 " + (onStandby ? "bg-amber-50 text-amber-700 ring-amber-200 hover:bg-amber-100" : "text-ink/60 ring-black/10 hover:bg-black/5")}
            >
              {onStandby ? "Resume" : "Standby"}
            </button>
            <button onClick={() => setOpen(false)} aria-label="Close" className="shrink-0 rounded-full p-1 text-ink/40 hover:bg-black/5 hover:text-ink">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </header>

          {focus && (
            // The subject, in blue, until it is cleared or another is pointed at.
            <div className="flex items-center gap-2 border-b border-accent/20 bg-accent/5 px-4 py-2 text-[12px] text-accent" role="status">
              <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-hidden />
              <span className="min-w-0 truncate"><span className="font-semibold">Pointing at:</span> {focus.label || focus.kind}</span>
              <span className="flex-1" />
              <button type="button" onClick={clearFocus} aria-label="Stop pointing at this" className="shrink-0 rounded-full px-1.5 text-accent/70 hover:bg-accent/10">×</button>
            </div>
          )}
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                        {msgs.map((m) => (
                              <div key={m.id}>
                {m.role === "assistant" && m.steps && m.steps.length > 0 && (
                  // The guide: what was done to get this answer, kept with it.
                  <ol className="mb-1.5 ml-1 space-y-0.5 border-l-2 border-accent/40 pl-2.5 text-[11px] leading-snug text-accent/80">
                    {m.steps.map((s, i) => <li key={i}>{s}</li>)}
                  </ol>
                )}
                <div className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div className={(m.role === "user" ? "bg-accent text-white" : "bg-canvas text-ink") + " max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed"}>
                    {m.text}
                  </div>
                </div>
                {m.role === "assistant" && m.image?.url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.image.url} alt={m.image.alt || "Generated picture"} className="mt-2 max-h-56 w-full rounded-xl object-cover ring-1 ring-black/10" />
                )}
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
            {busy && (
              // The trail, live and in blue: each step as it starts, the current one pulsing.
              <div className="rounded-xl border border-accent/30 bg-accent/5 px-3 py-2 text-xs text-accent" role="status" aria-live="polite">
                <ol className="space-y-1">
                  {steps.map((s, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className={"h-1.5 w-1.5 shrink-0 rounded-full bg-accent " + (i === steps.length - 1 ? "animate-pulse" : "opacity-50")} />
                      <span className={i === steps.length - 1 ? "font-medium" : "opacity-70"}>{s}</span>
                    </li>
                  ))}
                  {steps.length === 0 && (
                    <li className="flex items-center gap-2"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /><span>Working on it…</span></li>
                  )}
                </ol>
              </div>
            )}
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
