'use client';

// Route-level error boundary.
//
// Until this existed, an uncaught exception anywhere in the tree replaced the
// entire dashboard with Next's client-exception screen. That is how a single
// unchecked fetch in SemrushPanel — storing a 401 body and then reading a field
// off it — could take down Content Generator, Image Studio, Publishing, the
// Autopilot queue and the drafts library along with it, for a user whose only
// actual problem was a session that had expired in an open tab.
//
// A panel failing should cost you that panel, not the application. This is the
// floor under that: whatever else breaks, the person still gets a page that
// explains itself and a way back.

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Client-side, so this reaches the browser console and any error tracker
    // wired up there. lib/report.ts is the server-side equivalent.
    console.error('[dashboard] unhandled render error', error);
  }, [error]);

  return (
    <main
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600, margin: '0 0 0.75rem' }}>
          Something on this page stopped working
        </h1>
        <p style={{ margin: '0 0 1.5rem', lineHeight: 1.6, color: '#5a616d' }}>
          Your drafts and scheduled posts are safe — nothing was lost. Try again,
          and if it keeps happening, sign out and back in: an expired session is
          the most common cause.
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={reset}
            style={{
              padding: '0.6rem 1.1rem',
              borderRadius: '6px',
              border: 'none',
              background: '#2f4858',
              color: '#fff',
              fontSize: '0.95rem',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <a
            href="/sign-in"
            style={{
              padding: '0.6rem 1.1rem',
              borderRadius: '6px',
              border: '1px solid rgba(0,0,0,0.15)',
              color: '#1d1d1f',
              fontSize: '0.95rem',
              textDecoration: 'none',
            }}
          >
            Sign in again
          </a>
        </div>
        {error.digest ? (
          <p style={{ marginTop: '1.5rem', fontSize: '0.8rem', color: '#838c99' }}>
            Reference: {error.digest}
          </p>
        ) : null}
      </div>
    </main>
  );
}
