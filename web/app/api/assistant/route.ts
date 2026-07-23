import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { generateContentPack, chatAssistant } from "@/lib/ai";

// Embedded assistant.
// The client sends the full conversation "session" each turn. By default the assistant
// is a free-form conversational AI (mode: "chat"). It only enters the guided draft
// wizard when the user explicitly asks to draft/generate a post (or is already mid-wizard).

type Step =
  | "greet"
  | "topic"
  | "audience"
  | "tone"
  | "channels"
  | "provider"
  | "review"
  | "scheduling"
  | "done";

type LinkItem = { label: string; url: string };

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
  pack?: Record<string, any>;
  draftId?: string;
  schedule?: { network: string; publishAt: string }[];
  links?: LinkItem[];
  confirmations?: string[];
  mode?: "chat" | "guided";
  history?: { role: "user" | "assistant"; content: string }[];
};

const NETWORKS = ["instagram", "facebook", "linkedin", "blog"];
const MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
};

// Steps that mean we are already inside the guided draft wizard and should keep
// advancing the state machine rather than diverting to free-form chat.
const GUIDED_STEPS = new Set<Step>([
  "topic",
  "audience",
  "tone",
  "channels",
  "provider",
  "review",
  "scheduling",
]);

// Explicit "start the draft wizard" intent, e.g. "draft a post", "write me content".
const DRAFT_INTENT =
  /\b(draft|write|create|make|generate|compose|build)\b.{0,30}\b(post|content|caption|copy|article|blog|email|ad|script|campaign|newsletter)\b/i;

function reply(session: Session, message: string, options?: string[]) {
  return NextResponse.json({ session, message, options: options || null });
}

function parseChannels(text: string): string[] {
  const t = text.toLowerCase();
  if (/\ball\b|everything|every/.test(t)) return [...NETWORKS];
  const picked = NETWORKS.filter(
    (n) => t.includes(n) || (n === "instagram" && t.includes("ig"))
  );
  return picked.length ? picked : ["instagram", "linkedin"];
}

async function runChat(session: Session, input: string) {
  const history = Array.isArray(session.history) ? session.history.slice(-11) : [];
  history.push({ role: "user", content: input });
  let answer = "";
  try {
    answer = await chatAssistant(history, session.provider as any);
  } catch {
    answer = "I had trouble reaching the AI just now. Please try again in a moment.";
  }
  const newHistory = [...history, { role: "assistant" as const, content: answer }];
  return reply(
    { ...session, mode: "chat", step: "greet", history: newHistory },
    answer,
  );
}

export async function POST(req: Request) {
  const { session: incoming, text } = (await req.json()) as {
    session?: Session;
    text?: string;
  };
  const session: Session = incoming || {
    step: "greet",
    links: [],
    confirmations: [],
  };
  session.links = session.links || [];
  session.confirmations = session.confirmations || [];
  const input = (text || "").trim();

  try {
    // Initial priming call (empty input at greet): just show the greeting.
    // Do NOT advance the step, so the user's first real message is still evaluated freshly.
    if (!input && session.step === "greet" && !session.mode) {
      return reply(
        session,
        "Hi! I'm your AI assistant for Content Studio. Ask me anything about how the dashboard works, and I can explain the process or suggest content ideas. Or say 'draft a post' and I'll walk you through creating one.",
      );
    }

    const inGuided = session.mode === "guided" || GUIDED_STEPS.has(session.step);

    // Explicit request to start the guided draft wizard.
    if (input && !inGuided && DRAFT_INTENT.test(input)) {
      return reply(
        { ...session, mode: "guided", step: "topic" },
        "Great, let's draft a post. What topic or idea should it be about?",
      );
    }

    // Free-form conversational mode is the default whenever we are not mid-wizard.
    if (input && !inGuided) {
      return await runChat(session, input);
    }

    switch (session.step) {
      case "greet": {
        // Reached only via an explicit guided start with empty input; ask for a topic.
        session.mode = "guided";
        session.step = "topic";
        return reply(session, "What topic or idea should this post be about?");
      }
      case "topic": {
        if (!input) return reply(session, "Give me a topic to start with.");
        session.topic = input;
        session.step = "audience";
        return reply(
          session,
          "Who is the audience? (e.g. patients, clinicians, general public)"
        );
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
          "Which channels? Say 'all' or pick from Instagram, Facebook, LinkedIn, Blog.",
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
        session.model = MODELS[session.provider];

        const result = await generateContentPack({
          topic: session.topic!,
          audience: session.audience,
          tone: session.tone,
          channels: session.channels,
          provider: session.provider as any,
          model: session.model,
          contentType: "social" as any,
        });
        const pack = (result?.pack || result) as Record<string, any>;
        session.pack = pack;

        const supabase = supabaseServer();
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
            const p = pack[c];
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
        const publishAt =
          input || new Date(Date.now() + 86400000).toISOString();
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
  const conf = (session.confirmations || [])
    .map((c) => "\u2713 " + c)
    .join("\n");
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
