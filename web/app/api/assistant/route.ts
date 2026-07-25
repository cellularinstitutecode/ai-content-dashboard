import { NextResponse } from "next/server";
import { supabaseServer, supabaseAdmin } from "@/lib/supabase";
import {
  generateContentPack,
  chatAssistant,
  chatWithTools,
  type ToolMessage,
} from "@/lib/ai";

export const runtime = "nodejs";

// Embedded assistant.
// Default mode is a free-form conversational AI that can also TAKE ACTIONS via
// tool-calling (generate content, save drafts, schedule posts). Scheduling to live
// social accounts always requires an explicit user confirmation first.
// The legacy guided wizard still exists and starts only on explicit draft intent.

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

type PendingSchedule = {
  network: string;
  text: string;
  publishAt: string;
};

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
  // Agentic tool-calling state:
  toolMessages?: ToolMessage[];
  lastPack?: Record<string, any>;
  lastTopic?: string;
  pendingSchedule?: PendingSchedule | null;
};

const NETWORKS = ["instagram", "facebook", "linkedin", "blog"];
const MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
};

const GUIDED_STEPS = new Set<Step>([
  "topic",
  "audience",
  "tone",
  "channels",
  "provider",
  "review",
  "scheduling",
]);

const DRAFT_INTENT =
  /\b(draft|write|create|make|generate|compose|build)\b.{0,30}\b(post|content|caption|copy|article|blog|email|ad|script|campaign|newsletter)\b/i;

const AFFIRM = /^(y|yes|yep|yeah|sure|ok|okay|confirm|confirmed|do it|go ahead|please do|schedule it|post it)\b/i;
const DECLINE = /^(n|no|nope|cancel|stop|don.?t|do not|nevermind|never mind)\b/i;

const SCHEDULE_NETWORK_MAP: Record<string, string> = {
  facebook: "facebook",
  instagram: "instagram",
  twitter: "twitter",
  x: "twitter",
  linkedin: "linkedin",
  tiktok: "tiktok",
  youtube: "youtube",
  threads: "threads",
};

const TIMEZONE = process.env.METRICOOL_TIMEZONE || "America/Cancun";

function normalizePublishAt(input: string): string {
  let s = String(input || "").trim();
  if (!s) return s;
  s = s.replace(/Z$/, "").replace(/[+-]\d{2}:?\d{2}$/, "");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) s = s + ":00";
  s = s.replace(/\.\d+$/, "");
  return s;
}

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

// Pull a plain-text post body out of a generated content pack for a given network.
function textFromPack(pack: Record<string, any> | undefined, network: string): string {
  if (!pack) return "";
  const key =
    network === "twitter" || network === "x"
      ? "instagram"
      : (["instagram", "facebook", "linkedin", "blog"].includes(network) ? network : "instagram");
  const v = pack[key] ?? pack.instagram ?? pack.facebook ?? pack.linkedin ?? pack.blog ?? "";
  return typeof v === "string" ? v : String(v || "");
}

// Execute the real Metricool scheduling (mirrors /api/metricool/schedule).
async function doSchedule(userId: string, p: PendingSchedule) {
  const token = process.env.METRICOOL_USER_TOKEN;
  const mcUserId = process.env.METRICOOL_USER_ID || "3377431";
  if (!token) throw new Error("METRICOOL_USER_TOKEN not configured");
  const provider = SCHEDULE_NETWORK_MAP[p.network.toLowerCase()];
  if (!provider) throw new Error("Unsupported network: " + p.network);
  const publishAt = normalizePublishAt(p.publishAt);
  if (!publishAt) throw new Error("publishAt is required");
  if (!p.text) throw new Error("text is required");
  const blogId = "4308292";
  const body: any = {
    text: p.text,
    publicationDate: { dateTime: publishAt, timezone: TIMEZONE },
    providers: [{ network: provider }],
    autoPublish: true,
  };
  const url =
    "https://app.metricool.com/api/v2/scheduler/posts?blogId=" +
    encodeURIComponent(blogId) +
    "&userId=" +
    encodeURIComponent(mcUserId);
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Mc-Auth": token },
    body: JSON.stringify(body),
  });
  const rawText = await r.text();
  let parsed: any = null;
  try { parsed = JSON.parse(rawText); } catch { parsed = { raw: rawText }; }
  if (!r.ok) throw new Error("Metricool API error " + r.status + ": " + rawText.slice(0, 300));
  const post = parsed && parsed.data ? parsed.data : parsed;
  const id = post && (post.id || post.postId) ? post.id || post.postId : null;
  const status = (post && post.providers && post.providers[0] && post.providers[0].status) || "scheduled";
  try {
    const admin = supabaseAdmin();
    await admin.from("posts").insert({
      user_id: userId,
      providers: [provider],
      text: p.text,
      publication_date: publishAt,
      metricool_post_id: id,
      status,
    });
  } catch { /* logging-only */ }
  return { id, status, publishAt };
}

// Run the agentic tool loop. Executes generate/save immediately; gates schedule
// behind confirmation by stashing a pendingSchedule and returning to the user.
async function runAgent(session: Session, input: string, userId: string | null) {
  const tm: ToolMessage[] = Array.isArray(session.toolMessages) ? session.toolMessages : [];
  tm.push({ role: "user", content: input });

  let finalMessage = "";
  for (let i = 0; i < 5; i++) {
    const turn = await chatWithTools(tm);
    // Record the assistant turn (text and/or tool_use) so the model keeps context.
    const assistantBlocks: any[] = [];
    if (turn.message) assistantBlocks.push({ type: "text", text: turn.message });
    if (turn.toolCall && turn.toolUseId) {
      assistantBlocks.push({ type: "tool_use", id: turn.toolUseId, name: turn.toolCall.name, input: turn.toolCall.input });
    }
    tm.push({ role: "assistant", content: assistantBlocks.length ? assistantBlocks : (turn.message || "") });

    if (!turn.toolCall) { finalMessage = turn.message; break; }

    const call = turn.toolCall;
    let toolResult = "";

    if (call.name === "generate_content") {
      const topic = String(call.input.topic || "").trim();
      const provider = call.input.provider === "openai" ? "openai" : "anthropic";
      const result = await generateContentPack({
        topic,
        audience: call.input.audience,
        tone: call.input.tone,
        provider: provider as any,
        model: MODELS[provider],
        contentType: (call.input.format || "social") as any,
      });
      const pack = (result?.pack || result) as Record<string, any>;
      session.lastPack = pack;
      session.lastTopic = topic;
      session.provider = provider;
      const preview = textFromPack(pack, "instagram").slice(0, 500);
      toolResult = "Generated content for topic: " + topic + "\n\n" + preview;
    } else if (call.name === "save_draft") {
      if (!session.lastPack) {
        toolResult = "No generated content to save yet. Call generate_content first.";
      } else if (!userId) {
        toolResult = "Cannot save: user is not signed in.";
      } else {
        try {
          const sb = supabaseServer();
          const { data: draft } = await sb
            .from("drafts")
            .insert({
              user_id: userId,
              topic: String(call.input.topic || session.lastTopic || "Untitled"),
              pack: session.lastPack,
              provider: session.provider || "anthropic",
            })
            .select()
            .single();
          if (draft) {
            session.draftId = draft.id;
            session.links = session.links || [];
            session.links.push({ label: "Open draft", url: "/?draft=" + draft.id });
            toolResult = "Draft saved with id " + draft.id + ".";
          } else {
            toolResult = "Draft save returned no row.";
          }
        } catch (e: any) {
          toolResult = "Failed to save draft: " + (e?.message || "error");
        }
      }
    } else if (call.name === "schedule_post") {
      // SAFETY GATE: do not publish. Stash and ask the user to confirm.
      const network = String(call.input.network || "").toLowerCase();
      const text = String(call.input.text || textFromPack(session.lastPack, network) || "").trim();
      const publishAt = String(call.input.publishAt || "").trim();
      session.pendingSchedule = { network, text, publishAt };
      const pretty = network.charAt(0).toUpperCase() + network.slice(1);
      session.toolMessages = tm;
      return {
        message:
          (turn.message ? turn.message + "\n\n" : "") +
          "Ready to schedule to " + pretty + " for " + publishAt + ":\n\n\"" +
          text.slice(0, 400) + "\"\n\nShould I schedule it? (yes / no)",
        options: ["Yes, schedule it", "No, cancel"],
      };
    } else {
      toolResult = "Unknown tool.";
    }

    tm.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: turn.toolUseId, content: toolResult }],
    });
  }

  session.toolMessages = tm;
  if (!finalMessage) finalMessage = "Done.";
  return { message: finalMessage, options: undefined as string[] | undefined };
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

  // Resolve the signed-in user once (used for save/schedule).
  let userId: string | null = null;
  try {
    const sb = supabaseServer();
    const { data: { user } } = await sb.auth.getUser();
    userId = user?.id || null;
  } catch { userId = null; }

  try {
    // Priming call: greet without advancing state.
    if (!input && session.step === "greet" && !session.mode) {
      return reply(
        session,
        "Hi! I am your AI assistant for Content Studio. Ask me anything, or tell me to do something — like \"write an Instagram post about NK cell therapy and schedule it for Friday 9am\". I will always confirm with you before anything goes live.",
      );
    }

    // If a schedule is awaiting confirmation, handle yes/no first.
    if (session.pendingSchedule && input) {
      if (AFFIRM.test(input)) {
        const p = session.pendingSchedule;
        session.pendingSchedule = null;
        if (!userId) {
          return reply({ ...session, mode: "chat", step: "greet" }, "You need to be signed in to schedule posts. Please sign in and try again.");
        }
        try {
          const res = await doSchedule(userId, p);
          session.links!.push({ label: "View calendar", url: "/calendar" });
          const pretty = p.network.charAt(0).toUpperCase() + p.network.slice(1);
          return reply(
            { ...session, mode: "chat", step: "greet" },
            "Scheduled to " + pretty + " for " + res.publishAt + " (status: " + res.status + "). You can see it on the calendar.",
          );
        } catch (e: any) {
          return reply(
            { ...session, mode: "chat", step: "greet" },
            "I could not schedule that: " + (e?.message || "error") + ". Nothing was posted.",
          );
        }
      }
      if (DECLINE.test(input)) {
        session.pendingSchedule = null;
        return reply({ ...session, mode: "chat", step: "greet" }, "Okay, I will not schedule it. Anything else?");
      }
      // Ambiguous reply: keep waiting.
      return reply(session, "Just to confirm — should I schedule that post? Please reply yes or no.", ["Yes, schedule it", "No, cancel"]);
    }

    const inGuided = session.mode === "guided" || GUIDED_STEPS.has(session.step);

    // Explicit request to start the legacy step-by-step guided wizard.
    if (input && !inGuided && /guided|step by step|wizard/i.test(input)) {
      return reply(
        { ...session, mode: "guided", step: "topic" },
        "Sure, guided mode. What topic or idea should this post be about?",
      );
    }

    // Default: agentic chat that can take actions via tools.
    if (input && !inGuided) {
      try {
        const out = await runAgent(session, input, userId);
        return reply({ ...session, mode: "chat", step: "greet" }, out.message, out.options);
      } catch (e: any) {
        // Fall back to plain conversational answer if tool loop fails.
        const history = Array.isArray(session.history) ? session.history.slice(-11) : [];
        history.push({ role: "user", content: input });
        let answer = "";
        try { answer = await chatAssistant(history, session.provider as any); }
        catch { answer = "I had trouble reaching the AI just now. Please try again in a moment."; }
        const newHistory = [...history, { role: "assistant" as const, content: answer }];
        return reply({ ...session, mode: "chat", step: "greet", history: newHistory }, answer);
      }
    }

    switch (session.step) {
      case "greet": {
        session.mode = "guided";
        session.step = "topic";
        return reply(session, "What topic or idea should this post be about?");
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
          "Which channels? Say \"all\" or pick from Instagram, Facebook, LinkedIn, Blog.",
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
        if (userId) {
          const sb = supabaseServer();
          const { data: draft } = await sb
            .from("drafts")
            .insert({
              user_id: userId,
              topic: session.topic,
              audience: session.audience,
              tone: session.tone,
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
          "Here is your draft:\n\n" + preview + "\n\nWant me to schedule these, or are you good to post manually?",
          ["Schedule them", "I will post manually"]
        );
      }
      case "review": {
        if (/manual|myself|good|done|no/i.test(input)) {
          session.step = "done";
          return finish(session);
        }
        session.step = "scheduling";
        return reply(session, "What date & time should I publish? (e.g. 2026-08-01 09:00)");
      }
      case "scheduling": {
        const publishAt = input || new Date(Date.now() + 86400000).toISOString();
        session.schedule = [];
        for (const network of session.channels || []) {
          session.schedule.push({ network, publishAt });
          session.confirmations!.push("Scheduled " + network + " for " + publishAt + ".");
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
  const links = (session.links || []).map((l) => "\u2022 " + l.label + ": " + l.url).join("\n");
  return reply(
    session,
    "All set! Here is everything:\n\n" +
      (conf || "\u2713 Draft ready.") +
      "\n\nLinks:\n" +
      (links || "\u2022 Open draft: /") +
      "\n\nYou are clear to go ahead and post."
  );
}
