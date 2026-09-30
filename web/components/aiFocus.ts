// components/aiFocus.ts
// WHAT THE USER IS POINTING AT.
//
// "Make the AI aware of where I'm clicking so it knows what I'm talking
// about." With the Drafting Assistant open, Alt-click (or the panel's
// "Point at something", then a click) picks the thing under the pointer — a
// draft card, an Autopilot post, a calendar entry, a strategy slot, a panel —
// outlines it in blue, and sends it with the next message so "make this
// shorter" or "give this one a library photo" needs no further description.
//
// Elements that know what they are say so with data-ai-target (kind), data-ai-id
// and data-ai-label; anything else falls back to the nearest card-like
// ancestor and its first words. Plain module, no React: the panel, the voice
// hook and the click listener all read it, and the resolver is tested alone.
export type AiFocus = {
  /** 'draft' | 'run' | 'post' | 'slot' | 'section' | 'element' */
  kind: string;
  id: string | null;
  label: string;
  /** The first words of what it shows, for the model. */
  text: string;
};

type Listener = () => void;
let current: AiFocus | null = null;
let pointing = false;
const listeners = new Set<Listener>();
function emit() { for (const fn of Array.from(listeners)) fn(); }

export function getFocus(): AiFocus | null { return current; }
export function isPointing(): boolean { return pointing; }
export function subscribeFocus(fn: Listener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function setPointing(on: boolean): void { if (pointing === on) return; pointing = on; emit(); }

/** The attribute the outline is drawn on (app/globals.css). */
export const FOCUSED_ATTR = 'data-ai-focused';

export function setFocus(next: AiFocus | null, el?: Element | null): void {
  if (typeof document !== 'undefined') {
    for (const old of Array.from(document.querySelectorAll('[' + FOCUSED_ATTR + ']'))) old.removeAttribute(FOCUSED_ATTR);
    if (next && el) el.setAttribute(FOCUSED_ATTR, '1');
  }
  current = next;
  pointing = false;
  emit();
}

export function clearFocus(): void { setFocus(null); }

/** Where a click lands: the nearest thing that describes itself, else the nearest card. */
export const CARD_SELECTOR = '[data-ai-target], article, section, li, tr, form, fieldset, [role="dialog"]';

const MAX_TEXT = 700;

/** The target an element resolves to, or null when there is nothing card-like above it. Pure over the DOM node given. */
export function resolveFocus(start: Element | null): { focus: AiFocus; el: Element } | null {
  const el = start?.closest?.(CARD_SELECTOR) as HTMLElement | null;
  if (!el) return null;
  const kind = el.getAttribute('data-ai-target') || (el.tagName === 'ARTICLE' || el.tagName === 'LI' ? 'card' : el.tagName === 'SECTION' ? 'section' : 'element');
  const id = el.getAttribute('data-ai-id');
  const text = String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  const label = el.getAttribute('data-ai-label') || (el.querySelector('h1, h2, h3, h4, [data-ai-title]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || text.slice(0, 80);
  if (!text && !label) return null;
  return { focus: { kind, id: id || null, label: label || kind, text }, el };
}

/** The lines the assistant is given for the next message. Empty when nothing is pointed at. */
export function focusBlock(f: AiFocus | null): string {
  if (!f) return '';
  const what = f.kind === 'draft' ? 'a draft in Recent Drafts' : f.kind === 'run' ? 'a post on the Autopilot queue' : f.kind === 'post' ? 'a post on the calendar' : f.kind === 'slot' ? 'a post of the dropped weekly strategy' : f.kind === 'section' ? 'a section of the page' : 'an element on the page';
  return [
    'WHAT THE USER IS POINTING AT (they clicked it; "this", "it", "that one" mean this): ' + what + (f.id ? ' — id ' + f.id : '') + '.',
    'Title: ' + (f.label || '(none)'),
    f.text ? 'What it shows: ' + f.text : '',
    'Act on THIS item when the request fits it (edit, rewrite, give it a picture, schedule it, explain it); use its id with your tools when one is given. Do not ask which one they mean.',
  ].filter(Boolean).join('\n');
}
