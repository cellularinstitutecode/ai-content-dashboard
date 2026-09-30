// components/pauseBus.ts
// One pause for the queues that spend money.
//
// A dropped strategy writes the whole week on its own — two posts at a time,
// each with a picture — and when the pictures start failing, or the bill is
// climbing, the person watching wants to STOP it, from wherever they are on
// the page, not hunt for the panel that started it. The right-hand progress
// badge (components/LoadingScreen.tsx TopProgressBar) shows a Pause button
// while any such queue is running; the queue asks `whenResumed()` before it
// starts anything new. Nothing in flight is cancelled — the server would
// finish (and bill) it anyway — but nothing new is started, which is where the
// money is.
//
// Plain module, no React: the badge and the panel both read it, and it can
// be tested without a browser.
type Listener = () => void;

let paused = false;
let queues = 0;
const listeners = new Set<Listener>();
let resumers: Array<() => void> = [];

function emit() { for (const fn of Array.from(listeners)) fn(); }

/** Is the pause on? */
export function isPaused(): boolean { return paused; }
/** How many pausable queues are running right now. */
export function queuesRunning(): number { return queues; }

/** Switch the pause on or off. Resuming releases everything waiting in `whenResumed`. */
export function setPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  if (!paused) { const waiting = resumers; resumers = []; for (const go of waiting) go(); }
  emit();
}

/** Watch the pause and the queue count; returns the unsubscribe. */
export function subscribePause(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * A queue announces itself while it runs. Returns the function to call when it
 * ends. When the last queue ends the pause clears itself: a Pause left on with
 * nothing to pause would silently stop the NEXT week from writing.
 */
export function beginQueue(): () => void {
  queues += 1;
  emit();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    queues = Math.max(0, queues - 1);
    if (queues === 0 && paused) { paused = false; const waiting = resumers; resumers = []; for (const go of waiting) go(); }
    emit();
  };
}

/** Resolves at once when not paused; otherwise when the pause is lifted. */
export function whenResumed(): Promise<void> {
  if (!paused) return Promise.resolve();
  return new Promise((resolve) => { resumers.push(resolve); });
}

/** Test seam: back to the initial state. */
export function resetPauseBus(): void {
  paused = false; queues = 0; listeners.clear(); resumers = [];
}
