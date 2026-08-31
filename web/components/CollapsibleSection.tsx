'use client';

import { useEffect, useState } from 'react';

/**
 * A dashboard section that starts closed.
 *
 * The dashboard grew into one page carrying every capability at once — a
 * generator, an image studio, a video repurposer, a six-tab SEO console, a
 * research copilot, an approval queue and a draft library, all open, all the
 * time. Counted end to end that is 60-plus controls for a daily job that needs
 * about six of them, and the effect on someone who is not a power user is that
 * they cannot find the six.
 *
 * Nothing is removed here. The powerful-but-occasional tools simply arrive
 * folded, with a one-line summary of what opening one would give you, and the
 * choice is remembered per browser so a person who lives in the SEO panel keeps
 * it open. `defaultOpen` is for sections that ARE the daily job.
 */
export default function CollapsibleSection({
  id,
  eyebrow,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  summary: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const storageKey = 'section-open:' + id;
  const [open, setOpen] = useState(defaultOpen);
  // Read after mount: the server has no way to know this viewer's choice, and
  // reading during render would make the markup disagree with the HTML sent.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved === 'open') setOpen(true);
      else if (saved === 'closed') setOpen(false);
    } catch {
      // Private browsing, or storage blocked. The default stands.
    }
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A link or a step card that points at this section must be able to open it,
  // or the viewer lands on a closed header and concludes the feature is gone.
  useEffect(() => {
    function onOpenRequest(e: Event) {
      if ((e as CustomEvent<string>).detail === id) {
        setOpen(true);
        try { window.localStorage.setItem(storageKey, 'open'); } catch { /* not essential */ }
      }
    }
    window.addEventListener('section:open', onOpenRequest);
    return () => window.removeEventListener('section:open', onOpenRequest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function toggle() {
    const next = !open;
    setOpen(next);
    try { window.localStorage.setItem(storageKey, next ? 'open' : 'closed'); } catch { /* not essential */ }
  }

  return (
    <section id={id} className="mb-8 overflow-hidden rounded-3xl bg-surface shadow-card ring-1 ring-line/60">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={id + '-body'}
        className="flex w-full items-center gap-3 px-6 py-5 text-left transition hover:bg-subtle/60 sm:px-8"
      >
        <span
          aria-hidden
          className={'text-[13px] text-ink-faint transition-transform ' + (open ? 'rotate-90' : '')}
        >
          ▶
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            {eyebrow && (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                {eyebrow}
              </span>
            )}
            <span className="text-[18px] font-semibold text-ink">{title}</span>
          </span>
          <span className="mt-1 block text-[13px] text-ink-muted">{summary}</span>
        </span>
        <span className="shrink-0 text-[12px] font-medium text-accent">{open ? 'Hide' : 'Open'}</span>
      </button>
      {/* Mounted only while open: these panels fetch on mount (Semrush spends
          API units doing it), so a closed section must not do that work. */}
      {open && ready ? <div id={id + '-body'} className="border-t border-line">{children}</div> : null}
    </section>
  );
}
