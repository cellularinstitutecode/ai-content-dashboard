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

export type RefreshScope =
  | 'drafts'      // the drafts library (Recent Drafts, Image Studio gallery)
  | 'images'      // hero images attached to drafts
  | 'posts'       // the publishing queue and the calendar grid
  | 'stats'       // the headline stat cards
  | 'autopilot'   // the Autopilot run queue
  | 'insights'    // Metricool performance + "coming up next"
  | 'brand'       // the brand profile that steers every generator
  | 'templates'   // saved recurring templates
  | 'semrush';    // Semrush unit balance / cached research

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

// ---------------------------------------------------------------------------
// fetchDrafts: one in-flight request per identical drafts query.
//
// Three independent panels ask for the draft list on first paint — the Recent
// Drafts pager, the Image Studio gallery and the clip pre-warmer — so every
// dashboard load fired /api/drafts three times, two of them byte-identical.
// Callers keep their own fetches; this just makes concurrent identical ones
// share a single response. The entry is dropped as soon as it settles, so a
// later refresh always hits the network and nothing goes stale.
const inFlight = new Map<string, Promise<any>>();

export function fetchDrafts(limit: number, offset = 0): Promise<any> {
  const url = '/api/drafts?limit=' + limit + '&offset=' + offset;
  const existing = inFlight.get(url);
  if (existing) return existing;

  const p = fetch(url)
    .then(async (r) => {
      if (r.status === 401) throw new Error('Your session has expired. Sign in again.');
      if (!r.ok) throw new Error('Failed to load drafts (' + r.status + ')');
      return r.json();
    })
    .finally(() => { inFlight.delete(url); });

  inFlight.set(url, p);
  return p;
}
