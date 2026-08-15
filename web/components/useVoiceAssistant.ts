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
    dc.onopen = () => {
      dc.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: "You are the voice assistant for the AI Content Dashboard, a tool for drafting and scheduling social media posts (Instagram, Facebook, LinkedIn, blog) and managing posting-schedule templates. You are warm, quick, and effortlessly capable, like a calm confident assistant who already understands the app and the user's intent without being told exactly how to phrase things. Interpret casual, vague, or shorthand speech generously and infer what the user most likely wants, then act on it; do not demand precise commands or make the user repeat themselves in a rigid format. To take any action, call run_command with a clear natural-language description of what the user wants, for example 'draft an Instagram post about our new summer menu' or 'set up a template that posts to LinkedIn every Monday at 9am'. Keep spoken replies short and natural, a sentence or two, confirming what you are doing rather than how it works internally. If a request is genuinely ambiguous, ask one brief clarifying question rather than guessing wildly. Every action you trigger is staged on screen for the user to review and confirm; you never publish or send anything directly, so reassure the user it is ready for their review rather than claiming it is already done or live.",
          tools: [{
            type: "function",
            name: "run_command",
            description: "Send a natural-language command to the text assistant, which stages any action and asks the user to confirm on screen. Never publishes directly.",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          }],
          tool_choice: "auto",
        },
      }));
    };
    dc.onmessage = async (e) => {
      const evt = JSON.parse(e.data);
      if (evt.type === "response.function_call_arguments.done" && evt.name === "run_command") {
        const { command } = JSON.parse(evt.arguments || "{}");
        const data = await (await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: getSession(), text: command }),
        })).json();
        applyResult(data, command);
        dc.send(JSON.stringify({
          type: "conversation.item.create",
          item: { type: "function_call_output", call_id: evt.call_id,
            output: data.message ?? "done - ask the user to review on screen" },
        }));
        dc.send(JSON.stringify({ type: "response.create" }));
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
