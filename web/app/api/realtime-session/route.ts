import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";

export const runtime = "nodejs";

export async function POST() {
  const supabase = supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": `chi-${user.id}`,
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: "gpt-realtime",
        audio: { output: { voice: "alloy" } },
        instructions: `You are the Content Studio voice assistant for Cellular Hope Institute.
You chat and help draft social/blog content. You NEVER publish or finalize scheduling
yourself. To act, call the run_command tool with a plain-English command, which the text
assistant will stage and ask the user to confirm ON SCREEN. Always read drafts back aloud
and ask the user to review before anything is scheduled. Be concise.`,
      },
    }),
  });

  if (!r.ok) {
    return NextResponse.json({ error: "session_failed", detail: await r.text() }, { status: 500 });
  }
  return NextResponse.json(await r.json());
}
