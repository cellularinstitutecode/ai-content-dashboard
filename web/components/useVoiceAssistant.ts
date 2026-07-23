"use client";
import { useCallback, useRef, useState } from "react";

export function useVoiceAssistant(getSession: () => any, applyResult: (data: any) => void) {
  const [active, setActive] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  const start = useCallback(async () => {
    const s = await (await fetch("/api/realtime-session", { method: "POST" })).json();
    const EPHEMERAL = s.value ?? s.client_secret?.value;

    const pc = new RTCPeerConnection();
    pcRef.current = pc;

    const audioEl = new Audio();
    audioEl.autoplay = true;
    pc.ontrack = (e) => { audioEl.srcObject = e.streams[0]; };

    const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    mic.getTracks().forEach((t) => pc.addTrack(t, mic));

    const dc = pc.createDataChannel("oai-events");
    dc.onopen = () => {
      dc.send(JSON.stringify({
        type: "session.update",
        session: {
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
        applyResult(data);
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
    const sdp = await (await fetch("https://api.openai.com/v1/realtime/calls?model=gpt-realtime", {
      method: "POST",
      body: offer.sdp,
      headers: { Authorization: `Bearer ${EPHEMERAL}`, "Content-Type": "application/sdp" },
    })).text();
    await pc.setRemoteDescription({ type: "answer", sdp });
    setActive(true);
  }, [getSession, applyResult]);

  const stop = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    setActive(false);
  }, []);

  return { active, start, stop };
}
