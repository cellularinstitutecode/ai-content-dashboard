import { isAllowedEmail } from "@/lib/access";
import { redact } from "@/lib/report";
import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase";
import { checkRateLimit } from "@/lib/rate-limit";
import { getUnitsBalance } from "@/lib/semrush";
import {
  domainOverview,
  keywordMovers,
  primaryDomain,
  topOrganicKeywords,
} from "@/lib/semrush-domain";

export const runtime = "nodejs";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Live Semrush grounding for the VOICE assistant. Every session is minted
// with a compact snapshot of the clinic's real search analytics (all reads
// are cache-first + unit-floor guarded, so this costs 0 units on repeat and
// never blocks: any failure just degrades to the base instructions).
// ---------------------------------------------------------------------------

function fmt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "?";
  return n >= 1000 ? Math.round(n).toLocaleString("en-US") : String(Math.round(n));
}

async function buildSemrushContext(): Promise<string> {
  try {
    const domain = primaryDomain();
    const [ov, top, movers, balance] = await Promise.all([
      domainOverview(domain).catch(() => null),
      topOrganicKeywords(domain, 30).catch(() => ({ rows: [] as Awaited<ReturnType<typeof topOrganicKeywords>>["rows"] })),
      keywordMovers(domain).catch(() => null),
      getUnitsBalance().catch(() => null),
    ]);

    const lines: string[] = ["LIVE SEMRUSH SNAPSHOT for " + domain + ":"];
    if (ov?.data) {
      lines.push(
        "- Domain: ~" + fmt(ov.data.organicTraffic) + " organic visits/mo across " +
        fmt(ov.data.organicKeywords) + " ranking keywords."
      );
    }
    const winners = (top?.rows || []).slice(0, 8);
    if (winners.length) {
      lines.push(
        "- Top ranking keywords (position · searches/mo): " +
        winners.map((k) => '"' + k.keyword + '" (#' + (k.position ?? "?") + " · " + fmt(k.volume) + ")").join(", ") + "."
      );
    }
    const losses = movers ? [...movers.lostKeywords, ...movers.declined].slice(0, 4) : [];
    if (losses.length) {
      lines.push(
        "- Rankings needing defense (lost or falling): " +
        losses.map((m) => '"' + m.keyword + '" (' + fmt(m.volume) + "/mo)").join(", ") + "."
      );
    }
    if (balance != null) lines.push("- Semrush API unit balance: " + fmt(balance) + ".");
    return lines.length > 1 ? lines.join("\n") : "";
  } catch {
    return "";
  }
}

const BASE_INSTRUCTIONS = `You are the Content Studio voice assistant for Cellular Hope Institute,
a physician-led regenerative-medicine clinic in Cancun. You chat and help draft social/blog
content, and you are an SEO-aware strategist: the LIVE SEMRUSH SNAPSHOT below is real data
about the clinic's own domain — use it. When the user asks what to write about, which topics
matter, or how they are ranking, answer from the snapshot and say the numbers out loud
(e.g. "stem cell therapy mexico, ranking number seven, nineteen hundred searches a month").
For anything keyword-specific that is NOT in the snapshot, call the keyword_lookup tool to
fetch real volume/difficulty/questions before recommending — never invent metrics; if data
is unavailable, say so plainly.
You NEVER publish or finalize scheduling yourself. To act (draft, schedule, templates), call
the run_command tool with a plain-English command; the text assistant stages it and asks the
user to confirm ON SCREEN. Always read drafts back aloud and ask the user to review before
anything is scheduled. Keep spoken replies short and natural — a sentence or two. Never make
medical claims; keep language compliant and non-exaggerated.`;

const VOICE_TOOLS = [
  {
    type: "function",
    name: "run_command",
    description:
      "Send a natural-language command to the text assistant, which stages any action (drafts, scheduling, templates) and asks the user to confirm on screen. Never publishes directly.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "keyword_lookup",
    description:
      "Fetch REAL Semrush search data for a topic or keyword: monthly volume, keyword difficulty (KD), searcher intent, related terms, and the questions people actually ask. Call this before recommending topics or keywords that are not already in the snapshot.",
    parameters: {
      type: "object",
      properties: { topic: { type: "string", description: "The topic or keyword to research" } },
      required: ["topic"],
    },
  },
];

export async function POST() {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Reaches a resource that belongs to the clinic, not to a user, so a valid
  // session is the weaker question. Middleware enforces this too; this is the
  // copy that stays correct if the middleware exemption ever widens again.
  if (!isAllowedEmail(user.email)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'This account is not authorized for this workspace.' },
      { status: 403 },
    );
  }

  // Every POST here mints an OpenAI Realtime client secret - a spendable
  // credential for live audio - and builds a Semrush snapshot on the way.
  // Every sibling AI route is capped; this one was the exception.
  const rl = await checkRateLimit(user.id, "realtime");
  if (!rl.ok) {
    return NextResponse.json(
      { error: "rate_limited", limit: rl.limit },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY is not configured on the server" }, { status: 500 });
  }

  const context = await buildSemrushContext();
  const instructions = context ? BASE_INSTRUCTIONS + "\n\n" + context : BASE_INSTRUCTIONS;

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
        instructions,
        tools: VOICE_TOOLS,
        tool_choice: "auto",
      },
    }),
  });

  if (!r.ok) {
    // Log the upstream body, do not return it: it carries account and quota
    // detail the browser has no use for.
    console.error("realtime-session: OpenAI rejected the request", r.status, redact((await r.text()).slice(0, 500)));
    return NextResponse.json({ error: "session_failed" }, { status: 502 });
  }
  return NextResponse.json(await r.json());
}
