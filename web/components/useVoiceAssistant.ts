"use client";
import { useCallback, useRef, useState } from "react";

export function useVoiceAssistant(getSession: () => any, applyResult: (data: any, command?: string) => void) {
  const [active, setActive] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const start = useCallback(async () => {
    setError(null);
    setConnecting(true);
    let failed = false; // local flag: avoids overwriting a specific error from the stale closure state
    const fail = (msg: string) => { failed = true; setError(msg); };
    try {
    const sessionRes = await fetch("/api/realtime-session", { method: "POST" });
    const s = await sessionRes.json().catch(() => ({}));
    if (!sessionRes.ok) {
      const detail = typeof s?.detail === "string" ? s.detail.slice(0, 300) : "";
      fail("Could not start a voice session (" + sessionRes.status + "). " + (detail || "Check that OPENAI_API_KEY is set in Vercel."));
      setConnecting(false);
      return;
    }
    const EPHEMERAL = s.value ?? s.client_secret?.value;
    if (!EPHEMERAL) {
      fail("The voice session came back without a usable key — the OpenAI Realtime API may have changed shape. Check the /api/realtime-session response.");
      setConnecting(false);
      return;
    }

    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    const audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    audioRef.current = audioEl;
    pc.ontrack = (e) => {
      audioEl.srcObject = e.streams[0];
      audioEl.play().catch((err) => console.error("voice: audio play failed", err));
    };

    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      const name = err && err.name ? String(err.name) : "UnknownError";
      const detail = err && err.message ? String(err.message) : "";
      const suffix = detail ? " (" + name + ": " + detail + ")" : " (" + name + ")";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setError("The browser blocked microphone access. If the site is already set to Allow, this is usually an operating-system block: open your OS Privacy settings and let your browser use the microphone, then fully restart the browser." + suffix);
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setError("No microphone was found. Please connect or enable a mic and try again." + suffix);
      } else if (name === "NotReadableError" || name === "AbortError") {
        setError("The microphone is in use or unavailable. Close other apps that might be using it (Zoom, Teams, Discord, OBS), then try again." + suffix);
      } else {
        setError("Could not access the microphone." + suffix);
      }
      try { console.error("voice: getUserMedia failed", name, detail); } catch {}
            pc.close();
      pcRef.current = null;
      setConnecting(false);
      setActive(false);
      return;
    }
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));

    const dc = pc.createDataChannel("oai-events");
    // Instructions + tools (run_command, keyword_lookup) are now minted
    // SERVER-SIDE in /api/realtime-session, where the session is grounded in
    // a live Semrush snapshot of the clinic's domain. No client-side
    // session.update — it would overwrite that grounding.
    dc.onmessage = async (e) => {
      const evt = JSON.parse(e.data);
      if (evt.type !== "response.function_call_arguments.done") return;

      const reply = (output: string) => {
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: evt.call_id, output },
        }));
        dc.send(JSON.stringify({ type: "response.create" }));
      };

      if (evt.name === "run_command") {
        const { command } = JSON.parse(evt.arguments || "{}");
        const data = await (await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: getSession(), text: command }),
        })).json();
        applyResult(data, command);
        reply(data.message ?? "done - ask the user to review on screen");
        return;
      }

      if (evt.name === "keyword_lookup") {
        // Real Semrush data (cache-first, budget-guarded server-side).
        try {
          const { topic } = JSON.parse(evt.arguments || "{}");
          const r = await fetch("/api/semrush?action=hub&topic=" + encodeURIComponent(String(topic || "")));
          const d = await r.json();
          if (!r.ok || !d?.ok || !d?.brief) {
            reply("No Semrush data available for that topic right now — say so plainly and do not invent numbers.");
            return;
          }
          const b = d.brief;
          const compact = {
            topic: b.topic,
            primary: b.primary,
            supporting: (b.supporting || []).slice(0, 5),
            questions: (b.questions || []).slice(0, 4),
            intent: b.intentSummary || null,
            fromCache: b.fromCache,
          };
          reply("Real Semrush data (volume = searches/mo, difficulty = KD 0-100): " + JSON.stringify(compact));
        } catch {
          reply("Keyword lookup failed — tell the user the data is unavailable rather than guessing.");
        }
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const callRes = await fetch("https://api.openai.com/v1/realtime/calls?model=gpt-realtime", {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${EPHEMERAL}`, "Content-Type": "application/sdp" },
    });
    const sdp = await callRes.text();
    // OpenAI returns a JSON error body (not SDP) on failure — surface the real
    // message instead of letting setRemoteDescription crash on "{".
    if (!callRes.ok || !sdp.trimStart().startsWith("v=")) {
      let msg = "OpenAI rejected the voice call (" + callRes.status + ").";
      try {
        const j = JSON.parse(sdp);
        const apiMsg = j?.error?.message ? String(j.error.message) : "";
        const code = j?.error?.code ? String(j.error.code) : "";
        if (code === "credit_balance_exhausted" || code === "insufficient_quota" || /credits/i.test(apiMsg)) {
          msg = "Your OpenAI account is out of API credits, so voice can't connect. Add credits at platform.openai.com → Billing, then try again.";
        } else if (apiMsg) {
          msg = "OpenAI voice error: " + apiMsg.slice(0, 300);
        }
      } catch { /* body wasn't JSON either */ }
      fail(msg);
      try { mic.getTracks().forEach((t) => t.stop()); } catch {}
      pc.close();
      pcRef.current = null;
      setConnecting(false);
      setActive(false);
      return;
    }
    await pc.setRemoteDescription({ type: "answer", sdp });
    setActive(true);
    setConnecting(false);
    } catch (err) {
      console.error("voice: start failed", err);
      if (!failed) setError("Voice assistant failed to start. Please try again.");
      try { pcRef.current?.close(); } catch {}
      pcRef.current = null;
      setConnecting(false);
      setActive(false);
    }
  }, [getSession, applyResult]);

  const stop = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
      audioRef.current.remove();
      audioRef.current = null;
    }
    setActive(false);
    setConnecting(false);
    setError(null);
  }, []);

  return { active, connecting, error, start, stop };
}
