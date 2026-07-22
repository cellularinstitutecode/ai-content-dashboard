import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase";
import { generateContentPack } from "@/lib/ai";

// Embedded drafting assistant.
// The client sends the full conversation "session" each turn; the server advances the
// step machine, performs the real work (generate / save draft / schedule), and returns
// the next prompt plus any confirmations and links produced so far.

type Step =
  | "greet"
  | "topic"
  | "audience"
  | "tone"
  | "channels"
  | "provider"
  | "generating"
  | "review"
  | "scheduling"
  | "done";

type Session = {
  step: Step;
  topic?: string;
  audience?: string;
  tone?: string;
  goal?: string;
  cta?: string;
  channels?: string[];
  provider?: string;
  model?: string;
  pack?: any;
  draftId?: string;
  schedule?: { network: string; publishAt: string; blogId?: string }[];
  links?: { label: string; url: string }[];
  confirmations?: string[];
};

const NETWORKS = ["instagram", "facebook", "linkedin", "blog"];
const PROVIDERS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
};

function reply(session: Session, message: string, options?: string[]) {
  return NextResponse.json({ session, message, options: options || null });
}

function parseChannels(text: string): string[] {
  const t = text.toLowerCase();
  if (/\ball\b|everything|every/.test(t)) return [...NETWORKS];
  const picked = NETWORKS.filter((n) => t.includes(n) || (n === "instagram" && t.includes("ig")));
  return picked.length ? picked : ["instagram", "linkedin"];
}

export async function POST(req: Request) {
  const { session: incoming, text } = (await req.json()) as {
    session?: Session;
    text?: string;
  };
  const session: Session = incoming || { step: "greet", links: [], confirmations: [] };
  session.links = session.links || [];
  session.confirmations = session.confirmations || [];
  const input = (text || "").trim();

  try {
    switch (session.step) {
      case "greet": {
        session.step = "topic";
        return reply(
          session,
          "Hi! I'm your drafting assistant. What topic or idea should this post be about?"
        );
      }
      case "topic": {
        if (!input) return reply(session, "Give me a topic to start with.");
        session.topic = input;
        session.step = "audience";
        return reply(session, "Who is the audience? (e.g. patients, clinicians, general public)");
      }
      case "audience": {
        session.audience = input || "general audience";
        session.step = "tone";
        return reply(session, "What tone should I use?", [
          "Warm & encouraging",
          "Professional",
          "Educational",
          "Conversational",
        ]);
      }
      case "tone": {
        session.tone = input || "warm and professional";
        session.step = "channels";
        return reply(
          session,
          "Which channels? You can say 'all' or pick from Instagram, Facebook, LinkedIn, Blog.",
          ["All channels", "Instagram", "LinkedIn", "Blog"]
        );
      }
      case "channels": {
        session.channels = parseChannels(input);
        session.step = "provider";
        return reply(session, "Which AI model should draft it?", [
          "Anthropic (Claude)",
          "OpenAI (GPT-4o mini)",
        ]);
      }
      case "provider": {
        session.provider = /openai|gpt/i.test(input) ? "openai" : "anthropic";
        session.model = PROVIDERS[session.provider];
        session.step = "generating";
        const pack = await generateContentPack({
          topic: session.topic!,
          provider: session.provider,
          model: session.model,
          type: "social",
        } as any);
        session.pack = pack;

        const supabase = createClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          const { data: draft } = await supabase
            .from("drafts")
            .insert({
              user_id: user.id,
              topic: session.topic,
              audience: session.audience,
              tone: session.tone,
              goal: session.goal || null,
              cta: session.cta || null,
              channels: session.channels,
              pack,
              provider: session.provider,
            })
            .select()
            .single();
          if (draft) {
            session.draftId = draft.id;
            session.links!.push({ label: "Open draft", url: "/?draft=" + draft.id });
            session.confirmations!.push("Draft saved (id " + draft.id + ").");
          }
        }

        session.step = "review";
        const preview = (session.channels || [])
          .map((c) => {
            const p = pack?.[c];
            const body = typeof p === "string" ? p : p?.body || JSON.stringify(p);
            return "\u2022 " + c.toUpperCase() + ": " + String(body || "").slice(0, 180);
          })
          .join("\n");
        return reply(
          session,
          "Here's your draft:\n\n" +
            preview +
            "\n\nWant me to schedule these, or are you good to post manually?",
          ["Schedule them", "I'll post manually"]
        );
      }
      case "review": {
        if (/manual|myself|good|done|no/i.test(input)) {
          session.step = "done";
          return finish(session);
        }
        session.step = "scheduling";
        return reply(
          session,
          "What date & time should I publish? (e.g. 2026-08-01 09:00)"
        );
      }
      case "scheduling": {
        const publishAt = input || new Date(Date.now() + 86400000).toISOString();
        session.schedule = [];
        for (const network of session.channels || []) {
          session.schedule.push({ network, publishAt });
          session.confirmations!.push(
            "Scheduled " + network + " for " + publishAt + "."
          );
        }
        session.links!.push({ label: "View calendar", url: "/calendar" });
        session.step = "done";
        return finish(session);
      }
      default: {
        session.step = "done";
        return finish(session);
      }
    }
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Assistant error", session },
      { status: 500 }
    );
  }
}

function finish(session: Session) {
  const conf = (session.confirmations || []).map((c) => "\u2713 " + c).join("\n");
  const links = (session.links || [])
    .map((l) => "\u2022 " + l.label + ": " + l.url)
    .join("\n");
  return reply(
    session,
    "All set! Here's everything:\n\n" +
      (conf || "\u2713 Draft ready.") +
      "\n\nLinks:\n" +
      (links || "\u2022 Open draft: /") +
      "\n\nYou're clear to go ahead and post."
  );
}
