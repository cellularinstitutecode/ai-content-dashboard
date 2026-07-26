"use client";
import {
  createContext, useContext, useState, useEffect, useCallback, ReactNode,
} from "react";
import { supabaseBrowser } from "@/lib/supabase";

type AssistantOptions = {
  label?: string;
  preview?: any;
  draftId?: string;
  postId?: string;
  schedule?: any;
} | null;

type AssistantResult = {
  session?: any;
  message?: string;
  options?: AssistantOptions;
  pack?: any;
  instagram?: string; facebook?: string; linkedin?: string; blog?: string;
};

type Draft = any;
type Stats = { drafts?: number; scheduled?: number; upcoming?: number; clips?: number; draftsCount?: number; scheduledCount?: number; upcomingCount?: number; clipJobs?: number } | null;

type LiveContent = {
  output: any;
  setOutput: (o: any) => void;
  drafts: Draft[];
  setDrafts: (d: Draft[] | ((p: Draft[]) => Draft[])) => void;
  stats: Stats;
  setStats: (s: Stats | ((p: Stats) => Stats)) => void;
  lastMessage: string;
  staged: AssistantOptions;
  status: "idle" | "thinking" | "applying";
  setStatus: (s: "idle" | "thinking" | "applying") => void;
  applyAssistantResult: (data: AssistantResult) => void;
};

const Ctx = createContext<LiveContent | null>(null);

export function useLiveContent() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useLiveContent must be used inside <LiveContentProvider>");
  return c;
}

export function LiveContentProvider({ children }: { children: ReactNode }) {
  const [output, setOutput] = useState<any>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [stats, setStats] = useState<Stats>(null);
  const [lastMessage, setLastMessage] = useState("");
  const [staged, setStaged] = useState<AssistantOptions>(null);
  const [status, setStatus] = useState<"idle" | "thinking" | "applying">("idle");

  const flattenPack = (pack: any): string => {
  if (pack == null) return "";
  if (typeof pack === "string") return pack;
  const order = ["instagram", "facebook", "linkedin", "blog"];
  const parts: string[] = [];
  for (const k of order) {
    const v = pack[k];
    if (v) parts.push(k.toUpperCase() + "\n" + (typeof v === "string" ? v : String(v)));
  }
  if (parts.length) return parts.join("\n\n");
  try { return JSON.stringify(pack, null, 2); } catch { return String(pack); }
};

  const extractPack = (data: AssistantResult) => {
    if (data?.options?.preview) return data.options.preview;
    if (data?.pack) return data.pack;
    const { instagram, facebook, linkedin, blog } = data || {};
    if (instagram || facebook || linkedin || blog) return { instagram, facebook, linkedin, blog };
    return null;
  };

  const applyAssistantResult = useCallback((data: AssistantResult) => {
    if (data?.message) setLastMessage(data.message);
    setStaged(data?.options ?? null);

    const pack = extractPack(data);
    if (pack) setOutput(flattenPack(pack));

    const id = data?.options?.draftId;
    if (id && pack) {
      setDrafts((prev) => {
        if (prev.some((d) => d?.id === id)) return prev;
        return [{ id, ...pack, created_at: new Date().toISOString() }, ...prev];
      });
      setStats((s) => ({ ...(s || {}), drafts: (s?.drafts ?? 0) + 1 }));
    }
    setStatus("idle");
  }, []);

  useEffect(() => {
    const sb = supabaseBrowser();
    const channel = sb
      .channel("live-content")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "drafts" },
        (payload: any) => {
          const row = payload.new;
          setDrafts((prev) => (prev.some((d) => d?.id === row.id) ? prev : [row, ...prev]));
          setStats((s) => ({ ...(s || {}), drafts: (s?.drafts ?? 0) + 1 }));
        })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "posts" },
        () => setStats((s) => ({ ...(s || {}), scheduled: (s?.scheduled ?? 0) + 1 })))
      .subscribe();

    return () => { sb.removeChannel(channel); };
  }, []);

  return (
    <Ctx.Provider value={{
      output, setOutput, drafts, setDrafts, stats, setStats,
      lastMessage, staged, status, setStatus, applyAssistantResult,
    }}>
      {children}
    </Ctx.Provider>
  );
}
