'use client';

// components/VideoRegister.tsx
// "Recently added" — the panel at the top of the Video Library.
//
// The Video Library is a live window onto the Google Sheet, so until now there
// was no answer on screen to "what turned up this week, and what happened to
// it?" — the only date on a row is `fecha de elaboración`, free text typed by a
// person. This reads the register, which records arrivals and outcomes as
// events rather than overwriting a row's current state.
//
// It renders NOTHING when the register is off (its migration has not been run)
// or empty, so dropping this in front of an unmigrated deployment changes the
// page not at all.
import { useEffect, useRef, useState } from 'react';

type Entry = {
  id: string;
  videoKey: string;
  title: string | null;
  link: string | null;
  event: string;
  actor: string;
  said: string;
  createdAt: string;
};

/** The events worth a line in a summary, and how to colour them. */
const TONE: Record<string, string> = {
  first_seen: 'var(--accent, #2563eb)',
  prepared: '#15803d',
  queued: '#15803d',
  copy_made: '#15803d',
  failed: '#b91c1c',
  copy_failed: '#b91c1c',
  retried: '#a16207',
  skipped: '#6b7280',
};

function whenWords(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const mins = Math.max(0, Math.round((now - at) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + 'd ago';
}

export default function VideoRegister() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [off, setOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // One fetch per mount. Without the ref an effect that also sets state can
  // re-enter and cancel the request it just started — the deadlock this
  // codebase has already shipped once, in the media picker.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    fetch('/api/videos/register?limit=40')
      .then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j?.message || 'unreadable')))))
      .then((j) => {
        setOff(Boolean(j?.off));
        setEntries(Array.isArray(j?.entries) ? j.entries : []);
      })
      // A register that cannot be READ is not a register with nothing in it,
      // and the two must not look the same.
      .catch((e: Error) => setError(e.message || 'The register could not be read.'));
  }, []);

  // Nothing to say: the register is off, or genuinely empty. Render nothing at
  // all rather than an empty box that reads as "nothing has ever happened".
  if (off || (!error && !entries.length)) return null;

  const shown = open ? entries : entries.slice(0, 6);
  const arrivals = entries.filter((e) => e.event === 'first_seen').length;

  return (
    <section
      aria-label="Recently added"
      style={{
        border: '1px solid var(--line, #e5e7eb)',
        borderRadius: 10,
        padding: '10px 12px',
        marginBottom: 12,
        background: 'var(--canvas, #fafafa)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <strong style={{ fontSize: 13 }}>Recently added</strong>
        {arrivals > 0 && (
          <span style={{ fontSize: 12, color: 'var(--muted, #6b7280)' }}>
            {arrivals} new {arrivals === 1 ? 'video' : 'videos'}
          </span>
        )}
      </div>

      {error ? (
        <p style={{ fontSize: 12, color: '#b91c1c', margin: 0 }}>{error}</p>
      ) : (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
            {shown.map((e) => (
              <li key={e.id} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span
                  aria-hidden
                  style={{
                    width: 6, height: 6, borderRadius: 3, flex: '0 0 auto',
                    background: TONE[e.event] || 'var(--muted, #6b7280)',
                    transform: 'translateY(-1px)',
                  }}
                />
                <span style={{ flex: '0 0 auto', color: 'var(--muted, #6b7280)', minWidth: 58 }}>
                  {whenWords(e.createdAt, Date.now())}
                </span>
                <span style={{ minWidth: 0 }}>
                  {e.link ? (
                    <a href={e.link} target="_blank" rel="noreferrer" style={{ fontWeight: 500 }}>
                      {e.title || 'Untitled video'}
                    </a>
                  ) : (
                    <strong style={{ fontWeight: 500 }}>{e.title || 'Untitled video'}</strong>
                  )}{' '}
                  <span style={{ color: 'var(--muted, #6b7280)' }}>{e.said}</span>
                </span>
              </li>
            ))}
          </ul>
          {entries.length > 6 && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              style={{ marginTop: 6, fontSize: 12, background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent, #2563eb)' }}
            >
              {open ? 'Show less' : 'Show all ' + entries.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}
