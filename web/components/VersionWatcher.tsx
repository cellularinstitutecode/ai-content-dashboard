"use client";
// Polls /api/version and, when the deployed build changes underneath a long-open
// tab, shows a non-intrusive banner prompting a refresh. This fixes the
// stale-cached-bundle problem where an old JS bundle keeps running post-deploy.
import { useEffect, useRef, useState } from "react";

export default function VersionWatcher() {
  const initial = useRef<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;
    async function check() {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json().catch(() => null);
        const v = j && j.version;
        if (!v || !active) return;
        if (initial.current === null) {
          initial.current = v;
        } else if (v !== initial.current) {
          setStale(true);
        }
      } catch {
        // ignore transient network/poll failures
      }
    }
    check();
    const id = setInterval(check, 60000);
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!stale) return null;

  return (
    <div
      role="status"
      style={{
        position: "fixed",
        bottom: 20,
        left: 20,
        zIndex: 9999,
        maxWidth: 340,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 14px",
        borderRadius: 12,
        background: "#111827",
        color: "#fff",
        boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
        fontSize: 14,
      }}
    >
      <span>A new version is available.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          marginLeft: "auto",
          padding: "6px 12px",
          borderRadius: 8,
          border: "none",
          background: "#2563eb",
          color: "#fff",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        Refresh
      </button>
    </div>
  );
}
