'use client';

// refreshBus: the interconnection layer between dashboard panels.
//
// Every mutation (generate a pack, create an image, approve an Autopilot run,
// delete a draft, schedule a post…) announces WHICH data it changed, and every
// panel that displays that data listens and refetches. This keeps the Image
// Studio gallery, Recent Drafts, the stat cards, the Publishing queue and the
// Autopilot queue in sync with each other without any panel knowing the
// others exist — no more "generated a pack but the gallery didn't update
// until reload".

export type RefreshScope = 'drafts' | 'images' | 'posts' | 'stats' | 'autopilot';

const EVENT = 'chi:refresh';

export function announce(...scopes: RefreshScope[]) {
  if (typeof window === 'undefined' || scopes.length === 0) return;
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { scopes } }));
  } catch { /* never let a refresh signal break the action that fired it */ }
}

// Subscribe to refresh announcements. Returns the unsubscribe function —
// call it from the useEffect cleanup.
export function onRefresh(handler: (scopes: RefreshScope[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const fn = (e: Event) => {
    const scopes = (e as CustomEvent).detail?.scopes;
    if (Array.isArray(scopes) && scopes.length) handler(scopes as RefreshScope[]);
  };
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
