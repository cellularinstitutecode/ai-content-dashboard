'use client';

// workspace — the shared "what am I working on right now" context.
//
// The dashboard is spread across four routes (/, /calendar, /templates,
// /brand) and a dozen panels, and until now each one kept its own private idea
// of the current topic. Pick a keyword in Semrush, and the Content Generator,
// the Image Studio and the calendar's AI drafting box all still showed
// nothing. This context is the one value they all read and write, mirrored
// through sessionStorage so it survives navigation between those routes, and
// broadcast so every mounted panel updates at the same moment.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';

export type Workspace = {
  topic: string;          // the subject currently being worked on
  keyword: string;        // the SEO keyword it came from, when it came from one
  domain: string;         // the domain under analysis in Semrush
  draftId: string;        // the draft currently open / most recently touched
  source: string;         // which panel last set the topic (for a subtle hint in the UI)
};

const BLANK: Workspace = { topic: '', keyword: '', domain: '', draftId: '', source: '' };
const STORE = 'chi:workspace:v1';
const EVENT = 'chi:workspace';

function read(): Workspace {
  if (typeof window === 'undefined') return BLANK;
  try {
    const raw = window.sessionStorage.getItem(STORE);
    if (!raw) return BLANK;
    const parsed = JSON.parse(raw);
    return { ...BLANK, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch { return BLANK; }
}

function write(next: Workspace) {
  if (typeof window === 'undefined') return;
  try { window.sessionStorage.setItem(STORE, JSON.stringify(next)); } catch { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: next })); } catch { /* never break the caller */ }
}

type Ctx = Workspace & {
  setTopic: (topic: string, opts?: { keyword?: string; source?: string }) => void;
  setDomain: (domain: string) => void;
  setDraftId: (id: string) => void;
  patch: (next: Partial<Workspace>) => void;
};

const WorkspaceCtx = createContext<Ctx | null>(null);

export function useWorkspace(): Ctx {
  const ctx = useContext(WorkspaceCtx);
  // Panels rendered outside the provider (tests, storybook) still work; they
  // simply get a local, non-shared workspace instead of throwing.
  const [local, setLocal] = useState<Workspace>(BLANK);
  const fallback = useMemo<Ctx>(() => ({
    ...local,
    setTopic: (topic, opts) => setLocal((p) => ({ ...p, topic, keyword: opts?.keyword ?? p.keyword, source: opts?.source || '' })),
    setDomain: (domain) => setLocal((p) => ({ ...p, domain })),
    setDraftId: (draftId) => setLocal((p) => ({ ...p, draftId })),
    patch: (next) => setLocal((p) => ({ ...p, ...next })),
  }), [local]);
  return ctx || fallback;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Workspace>(BLANK);

  // Hydrate after mount so server and client markup match.
  useEffect(() => { setState(read()); }, []);

  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail === 'object') setState((prev) => ({ ...prev, ...detail }));
    };
    const onStorage = (e: StorageEvent) => { if (e.key === STORE) setState(read()); };
    window.addEventListener(EVENT, onEvent);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, onEvent);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const patch = useCallback((next: Partial<Workspace>) => {
    setState((prev) => {
      const merged = { ...prev, ...next };
      if (
        merged.topic === prev.topic && merged.keyword === prev.keyword &&
        merged.domain === prev.domain && merged.draftId === prev.draftId
      ) return prev;
      write(merged);
      return merged;
    });
  }, []);

  const value = useMemo<Ctx>(() => ({
    ...state,
    patch,
    setTopic: (topic: string, opts?: { keyword?: string; source?: string }) =>
      patch({ topic, keyword: opts?.keyword ?? (topic ? state.keyword : ''), source: opts?.source || '' }),
    setDomain: (domain: string) => patch({ domain }),
    setDraftId: (draftId: string) => patch({ draftId }),
  }), [state, patch]);

  return <WorkspaceCtx.Provider value={value}>{children}</WorkspaceCtx.Provider>;
}
