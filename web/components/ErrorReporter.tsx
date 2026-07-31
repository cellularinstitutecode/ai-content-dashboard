"use client";
// Captures uncaught client errors (window.onerror + unhandledrejection) and
// posts them to /api/client-errors so they surface in server logs. Throttled and
// fully fail-safe: reporting never throws and never blocks the app.
import { useEffect } from "react";

export default function ErrorReporter() {
  useEffect(() => {
    let last = 0;
    function report(message: string, stack?: string) {
      const now = Date.now();
      if (now - last < 3000) return; // throttle bursts
      last = now;
      try {
        fetch("/api/client-errors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message,
            stack: stack || "",
            path: typeof window !== "undefined" ? window.location.pathname : "",
          }),
          keepalive: true,
        }).catch(() => {});
      } catch {
        // swallow
      }
    }
    function onError(e: ErrorEvent) {
      report(e.message || "window.onerror", e.error && e.error.stack);
    }
    function onRejection(e: PromiseRejectionEvent) {
      const r: any = e.reason;
      report(
        (r && r.message) || String(r) || "unhandledrejection",
        r && r.stack,
      );
    }
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
