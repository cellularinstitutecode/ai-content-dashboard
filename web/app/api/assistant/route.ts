import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { supabaseServer } from '@/lib/supabase';
import { supabaseAdmin } from '@/lib/supabase-admin';
import {
  generateContentPack,
  chatAssistant,
  chatWithTools,
  researchTopic,
  type ToolMessage,
} from "@/lib/ai";
import { opusCreateClipProject } from "@/lib/opus";
import { researchBundle, briefPromptFrom, getUnitsBalance, recordDraftKeywords, type SemKeyword } from "@/lib/semrush";
import { checkRateLimit } from "@/lib/rate-limit";

// Compact, chat-friendly rendering of Semrush keyword rows.
function fmtKw(k: SemKeyword): string {
  const bits = [k.volume != null ? k.volume + "/mo" : "n/a"];
  if (k.difficulty != null) bits.push("KD " + k.difficulty);
  if (k.intents && k.intents.length) bits.push(k.intents.join("+"));
  return k.keyword + " (" + bits.join(", ") + ")";
}

export const runtime = "nodejs";

// Agent tool loop chains several sequential Anthropic calls; the default 10s
// serverless limit is too low and causes empty 500s / hangs (issue #36).
export const maxDuration = 300;

// Embedded assistant.
// Default mode is a free-form conversational AI that can also TAKE ACTIONS via
// tool-calling (generate content, save drafts, schedule posts). Scheduling to live
// social accounts always requires an explicit user confirmation first, and even
// then posts are queued in Metricool as drafts for review (never auto-published).
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
  // Server-issued HMAC over pendingSchedule. The whole session round-trips
  // through the client, so anything action-bearing must be tamper-evident:
  // a forged/edited pendingSchedule + "yes" must not schedule anything.
  _sig?: string | null;
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

// Key material for signing the client-round-tripped session. Service-role key
// is always present in this deployment; CRON_SECRET wins when set.
function sessionKey(): string {
  return process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}
function signPending(p: PendingSchedule | null | undefined): string | null {
  const key = sessionKey();
  if (!key || !p) return null;
  return createHmac("sha256", key).update(JSON.stringify([p.network, p.text, p.publishAt])).digest("hex");
}
// True only when the pendingSchedule the client sent back carries a valid
// server-issued signature. On any mismatch we drop the pending action.
function pendingIsAuthentic(session: Session): boolean {
  const p = session.pendingSchedule;
  if (!p) return false;
  const expect = signPending(p);
  const got = String(session._sig || "");
  if (!expect || !got || expect.length !== got.length) return false;
  try { return timingSafeEqual(Buffer.from(expect), Buffer.from(got)); } catch { return false; }
}

function reply(session: Session, message: string, options?: string[]) {
  // Stamp (or clear) the signature so only server-created pending actions survive the round-trip.
  session._sig = signPending(session.pendingSchedule);
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
// REVIEW STEP: posts are queued in Metricool as drafts (autoPublish:false), so a
// human still approves them in Metricool before anything goes live.
async function doSchedule(userId: string, p: PendingSchedule) {
  const token = process.env.METRICOOL_USER_TOKEN;
  const mcUserId = process.env.METRICOOL_USER_ID;
  if (!token || !mcUserId) throw new Error("METRICOOL_USER_TOKEN and METRICOOL_USER_ID must be configured");
  const provider = SCHEDULE_NETWORK_MAP[p.network.toLowerCase()];
  if (!provider) throw new Error("Unsupported network: " + p.network);
  const publishAt = normalizePublishAt(p.publishAt);
  if (!publishAt) throw new Error("publishAt is required");
  if (!p.text) throw new Error("text is required");
  const blogId = process.env.METRICOOL_BLOG_ID;
  if (!blogId) throw new Error("METRICOOL_BLOG_ID must be configured");
  const body: any = {
    text: p.text,
    publicationDate: { dateTime: publishAt, timezone: TIMEZONE },
    providers: [{ network: provider }],
    // Review step: hold in Metricool as a draft for human approval before publishing.
    autoPublish: false,
    draft: true,
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
  if (!r.ok) {
    console.error("Metricool schedule error", r.status, rawText.slice(0, 300));
    throw new Error("Metricool rejected the request (status " + r.status + ").");
  }
  const post = parsed && parsed.data ? parsed.data : parsed;
  const id = post && (post.id || post.postId) ? post.id || post.postId : null;
  const status = (post && post.providers && post.providers[0] && post.providers[0].status) || "pending_review";
  try {
    const admin = supabaseAdmin();
    await admin.from("posts").insert({
      user_id: userId,
      providers: [provider],
      text: p.text,
      publication_date: publishAt,
      metricool_post_id: id,
      status: status && status !== "scheduled" ? status : "pending_review",
    });
  } catch { /* logging-only */ }
  return { id, status, publishAt };
}

// Run the agentic tool loop. Executes generate/save immediately; gates schedule
// behind confirmation by stashing a pendingSchedule and returning to the user.
async function runAgent(session: Session, input: string, userId: string | null) {
  const tm: ToolMessage[] = Array.isArray(session.toolMessages) ? session.toolMessages : [];
  tm.push({ role: "user", content: input });

  // Reliable auto-save: remember any pre-existing draft so we can tell if THIS turn saved one.
  const _startDraftId = (session as any).draftId || null;
  const _wantsSave = /\b(save|draft|keep|store|add (it|this) to (my )?drafts)\b/i.test(input || "");

  let finalMessage = "";
  for (let i = 0; i < 4; i++) {
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
      // Semrush pre-filter runs automatically inside generateContentPack and
      // stamps the pack with `_semrush` provenance (visible on saved drafts).
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
      if (userId && result.keywordBrief) void recordDraftKeywords(userId, topic, result.keywordBrief);
      const kwNote =
        result.semrush && result.semrush.source === "semrush"
          ? "\n\n[Semrush keyword research applied" + (result.semrush.fromCache ? " (cached)" : "") + " — primary: " + (result.semrush.primary || "n/a") + (result.semrush.volume != null ? " (" + result.semrush.volume + "/mo)" : "") + "; tell the user their draft was optimized with real search data.]"
          : "\n\n[Semrush keyword data was unavailable for this topic (" + (result.semrush?.reason || "unknown") + ") — the draft was generated without live keyword research; mention this briefly.]";
      const preview = textFromPack(pack, "instagram").slice(0, 500);
      toolResult = "Generated content for topic: " + topic + "\n\n" + preview + kwNote;
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
          "Ready to queue this to " + pretty + " for " + publishAt + " as a draft for review in Metricool (it will NOT publish automatically):\n\n\"" +
          text.slice(0, 400) + "\"\n\nShould I send it for review? (yes / no)",
        options: ["Yes, send for review", "No, cancel"],
      };
    } else if (call.name === "clip_video") {
      if (!userId) {
        toolResult = "Cannot start a clip job: user is not signed in.";
      } else {
        try {
          const videoUrl = String(call.input.videoUrl || "").trim();
          const title = call.input.title ? String(call.input.title) : undefined;
          const language = call.input.language ? String(call.input.language) : undefined;
          if (!videoUrl) {
            toolResult = "No video URL provided. Ask the user for a YouTube or Vimeo link.";
          } else {
            const project: any = await opusCreateClipProject({ videoUrl, language, title });
            const projectId = String((project && (project.projectId || project.id || (project.project && (project.project.id || project.project.projectId)))) || "").trim();
            if (!projectId) {
              toolResult = "OpusClip did not return a project id, so the job could not be started.";
            } else {
              const thumb = (project && (project.sourceInfo?.thumbnailUrl || project.sourceInfo?.thumbnail || project.thumbnailUrl)) || null;
              const projectTitle = title || (project && project.sourceInfo && project.sourceInfo.title) || null;
              const admin = supabaseAdmin();
              await admin.from("clips").insert({ user_id: userId, opus_project_id: projectId, source_url: videoUrl, status: "processing" });
              const pack = { kind: "clip", video: videoUrl, thumb, projectId, status: "processing", clips: [] as any[] };
              await admin.from("drafts").insert({ user_id: userId, topic: projectTitle ? ("Video clips — " + projectTitle) : ("Video clips from " + videoUrl), pack, provider: "opusclip" });
              session.confirmations = session.confirmations || [];
              session.confirmations.push("Started an OpusClip job — clips will appear under Recent Drafts when ready.");
              toolResult = "Started an OpusClip job for the video. It is processing now and the clips will appear under Recent Drafts automatically when ready (this can take a few minutes).";
            }
          }
        } catch (e: any) {
          toolResult = "Failed to start the clip job: " + (e?.message || "unknown error");
        }
      }
    } else if (call.name === "research_topic") {
      try {
        const topic = String(call.input.topic || "").trim();
        const network = String(call.input.network || "instagram").trim() || "instagram";
        if (!topic) {
          toolResult = "No topic provided. Ask the user what they want researched.";
        } else {
          // Ground the research in the REAL Semrush Keyword Brief (cache-first,
          // budget-guarded) so the chatbot recommends keywords with genuine
          // volume/difficulty/intent rather than inventing them.
          const bundle = await researchBundle(topic, { relatedLimit: 12, questionLimit: 6 });
          const kwHint = briefPromptFrom(bundle.brief);
          const research: any = await researchTopic({ topic, provider: session.provider === "openai" ? "openai" : "anthropic", network, keywordHint: kwHint || undefined });
          const r = (research && research.result) ? research.result : research;
          const angles = Array.isArray(r?.angles) ? r.angles.slice(0, 5).join("; ") : "";
          const keywords = Array.isArray(r?.keywords) ? r.keywords.map((k: any) => (k && (k.term || k)) || "").filter(Boolean).slice(0, 8).join(", ") : "";
          const hashtags = Array.isArray(r?.hashtags) ? r.hashtags.slice(0, 10).join(" ") : "";
          const hooks = Array.isArray(r?.hooks) ? r.hooks.slice(0, 3).join(" | ") : "";
          if (r && typeof r.draft === "string" && r.draft.trim()) {
            session.lastPack = { instagram: r.draft, blog: r.draft, format: "research", research: r } as any;
            session.lastTopic = topic;
            session.provider = session.provider === "openai" ? "openai" : "anthropic";
          }
          const briefKws = bundle.brief.source === "semrush"
            ? [bundle.brief.primary, ...bundle.brief.supporting].filter(Boolean).map((k) => fmtKw(k as SemKeyword)).join(", ")
            : "";
          const kwLine = briefKws
            ? "\nSemrush keywords (real search data" + (bundle.brief.fromCache ? ", cached" : "") + "): " + briefKws
            : "\n(Keyword data source: model estimate — set SEMRUSH_API_KEY for live search volume/difficulty.)";
          toolResult = "Research for " + topic + ":\nAngles: " + angles + "\nKeywords: " + keywords + kwLine + "\nHashtags: " + hashtags + "\nHooks: " + hooks + "\nA ready-to-edit draft is prepared; call save_draft to keep it.";
        }
      } catch (e: any) {
        toolResult = "Research failed: " + (e?.message || "unknown error");
      }
    } else if (call.name === "keyword_lookup") {
      try {
        const topic = String(call.input.topic || "").trim();
        if (!topic) {
          toolResult = "No topic provided. Ask the user what keyword or topic to look up.";
        } else {
          const bundle = await researchBundle(topic, { relatedLimit: 12, questionLimit: 6 });
          if (bundle.brief.source !== "semrush") {
            toolResult =
              bundle.reason === "no_token"
                ? "Semrush is not connected (SEMRUSH_API_KEY not set) and this topic is not in the cache. Tell the user to add the key in Vercel, and offer your best editorial judgement clearly labeled as an estimate."
                : bundle.reason === "budget"
                ? "Semrush unit balance is at the protection floor, and this topic is not cached. Recommend re-using recently analyzed topics, and label any further advice as an estimate."
                : "No Semrush data available for this topic (" + (bundle.note || bundle.reason) + "). Offer editorial judgement clearly labeled as an estimate.";
          } else {
            const b = bundle.brief;
            const lines: string[] = [];
            lines.push("Semrush data for \"" + topic + "\"" + (b.fromCache ? " (cached, 0 units)" : " (live)") + ":");
            if (b.primary) lines.push("PRIMARY: " + fmtKw(b.primary));
            if (b.supporting.length) lines.push("SUPPORTING: " + b.supporting.map((k) => fmtKw(k)).join(", "));
            if (bundle.questions.length) lines.push("REAL QUESTIONS: " + bundle.questions.slice(0, 5).map((q) => q.keyword + (q.volume ? " (" + q.volume + "/mo)" : "")).join("; "));
            lines.push("Dominant intent: " + b.intentSummary + ".");
            const balance = await getUnitsBalance();
            if (balance != null) lines.push("(API unit balance: " + balance.toLocaleString() + ".)");
            lines.push("Ground your recommendation in these numbers: prefer high volume with KD under ~60, match the intent, and cite figures in your reply.");
            toolResult = lines.join("\n");
          }
        }
      } catch (e: any) {
        toolResult = "Keyword lookup failed: " + (e?.message || "unknown error");
      }
    } else {
      toolResult = "Unknown tool.";
    }

    tm.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: turn.toolUseId, content: toolResult }],
    });
  }

  // Reliable auto-save fallback: if the user wanted to save but the model never persisted a
  // draft this turn (e.g. it narrated a blog article inline instead of calling the tools),
  // generate the pack in code if needed and insert the draft deterministically.
  if (_wantsSave && userId && (session as any).draftId === _startDraftId) {
    try {
      if (!session.lastPack) {
        // Reuse the content the model already narrated this turn instead of
        // regenerating (a second generateContentPack call times out for blogs).
        const _topic = (session.lastTopic || (input || "").replace(/\b(please|kindly)\b/gi, "").replace(/\b(save|keep|store|add)\b.*$/i, "").replace(/^(write|create|draft|generate|make)\s+(me\s+)?(an?\s+)?/i, "").trim()).slice(0, 200) || "Untitled";
        const _fmt = /blog|article/i.test(input) ? "blog" : /email/i.test(input) ? "email" : /video|script/i.test(input) ? "video" : /\bad\b|advert/i.test(input) ? "ad" : "social";
        const _body = String(finalMessage || "").trim();
        if (_body) {
          const _key = _fmt === "blog" ? "blog" : _fmt === "email" ? "email" : _fmt === "video" ? "video" : _fmt === "ad" ? "ad" : "instagram";
          session.lastPack = { [_key]: _body, instagram: _body };
          session.lastTopic = _topic;
          session.provider = session.provider === "openai" ? "openai" : "anthropic";
        }
      }
      const _sb = supabaseServer();
      const { data: _draft } = await _sb
        .from("drafts")
        .insert({
          user_id: userId,
          topic: String(session.lastTopic || "Untitled"),
          pack: session.lastPack,
          provider: session.provider || "anthropic",
        })
        .select()
        .single();
      if (_draft) {
        session.draftId = _draft.id;
        session.links = session.links || [];
        session.links.push({ label: "Open draft", url: "/?draft=" + _draft.id });
        if (!/saved|draft/i.test(finalMessage || "")) {
          finalMessage = (finalMessage ? finalMessage + "\n\n" : "") + "Saved it to your drafts.";
        }
      }
    } catch (_e) {
      // Non-fatal: if the fallback save fails, keep the model's message.
    }
  }

  session.toolMessages = tm;
  if (!finalMessage) finalMessage = "Done.";
  return { message: finalMessage, options: ((session as any).lastPack ? { preview: (session as any).lastPack, draftId: (session as any).draftId ?? null } : undefined) as any };}

export async function POST(req: Request) {
  // Guarded like every other route in the repo: an unparseable body used to
  // throw above the handler's try block and surface as an opaque 500 that the
  // assistant widget rendered as "unexpected response (status 500)".
  const parsed = (await req.json().catch(() => null)) as { session?: Session; text?: string } | null;
  if (!parsed || typeof parsed !== 'object') {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const { session: incoming, text } = parsed;
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

  // Require an authenticated user before running the assistant (which spends AI credits).
  if (!userId) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Rate limit before spending AI credits.
  const rl = await checkRateLimit(userId, 'assistant');
  if (!rl.ok) {
    return NextResponse.json(
      { error: 'rate_limited', limit: rl.limit },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
    );
  }

  try {
    // Priming call: greet without advancing state.
    if (!input && session.step === "greet" && !session.mode) {
      return reply(
        session,
        "Hi! I am your AI assistant for Content Studio. Ask me anything, or tell me to do something — like \"write an Instagram post about NK cell therapy and schedule it for Friday 9am\". I will always confirm with you before anything goes live.",
      );
    }

    // If a schedule is awaiting confirmation, handle yes/no first.
    // Reject any pendingSchedule the server didn't sign — the session object
    // is client-supplied, so an unsigned/forged one must never schedule.
    if (session.pendingSchedule && !pendingIsAuthentic(session)) {
      session.pendingSchedule = null;
    }
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
            "Sent to " + pretty + " as a draft for review for " + res.publishAt + " (status: " + res.status + "). Approve it in Metricool to publish. You can also see it on the calendar.",
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
      return reply(session, "Just to confirm — should I send that post to Metricool for review? Please reply yes or no.", ["Yes, send for review", "No, cancel"]);
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
        // Semrush pre-filter runs automatically inside generateContentPack.
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
        if (userId && result.keywordBrief) void recordDraftKeywords(userId, session.topic!, result.keywordBrief);
        if (result.semrush && result.semrush.source === "semrush") {
          session.confirmations!.push(
            "Semrush keyword research applied — primary keyword: " + (result.semrush.primary || "n/a") +
            (result.semrush.volume != null ? " (" + result.semrush.volume.toLocaleString() + "/mo)" : "")
          );
        }
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
