'use client';

// progressBus — the single source of truth for "is anything loading, and how
// far along is it?".
//
// Every panel on this dashboard talks to the same backend through `fetch`, so
// rather than asking 50+ call sites to each report their own progress (which
// is how loading states drift out of sync), the bus installs one fetch
// interceptor and observes them all. Panels stay untouched; the loading screen
// still knows about every request they make.
//
// The percentage is *calibrated*, not decorative. Each endpoint's real
// durations are recorded to localStorage as an exponentially-weighted moving
// average, and the number you see is elapsed-vs-expected for that specific
// endpoint on this specific machine. A first-ever call uses the seeded
// estimate below; by the third call the bar is tracking that user's actual
// latency. Progress eases toward — but never reaches — 100% while a request
// is genuinely outstanding, so the number can never lie about being finished.

export type TaskKind = 'foreground' | 'background';
export type TaskState = 'running' | 'done' | 'error';

export type Task = {
  id: string;
  key: string;          // endpoint key, e.g. "POST /api/generate"
  label: string;        // human sentence, e.g. "Writing your content pack"
  detail?: string;
  kind: TaskKind;
  scope: string;        // which panel owns this work, e.g. "create", "image-studio"
  startedAt: number;
  endedAt?: number;
  expectedMs: number;
  explicit?: number;    // 0..1 when the caller reports real progress
  state: TaskState;
};

export type Snapshot = {
  tasks: Task[];            // running + recently-finished tasks in the batch
  running: Task[];
  percent: number;          // 0..100, monotonic within a batch
  active: boolean;          // a foreground batch is in flight
  backgroundActive: boolean;
  label: string;            // headline for the loading screen
  since: number;            // batch start timestamp
};

// ---------------------------------------------------------------- estimates

const PERF_STORE = 'chi:progress:perf:v1';
const EWMA_ALPHA = 0.35;

// Seeded expectations (ms) — replaced by measured values as soon as the user
// exercises the endpoint once. Keys are matched by longest prefix.
const SEED: Array<[string, number]> = [
  ['POST /api/generate', 22000],
  ['POST /api/assistant', 26000],
  ['POST /api/drafts/image', 30000],
  ['POST /api/transform', 12000],
  ['POST /api/opus/clip', 6000],
  ['POST /api/autopilot/tick', 40000],
  ['POST /api/autopilot/runs', 25000],
  ['POST /api/templates/apply', 5000],
  ['POST /api/metricool/ai-research', 20000],
  ['POST /api/metricool/schedule', 4500],
  ['GET /api/semrush', 6000],
  ['GET /api/keywords', 7000],
  ['GET /api/metricool', 3500],
  ['POST /api/realtime-session', 3000],
  ['GET /api/drafts', 1200],
  ['GET /api/posts', 1000],
  ['GET /api/stats', 900],
  ['GET /api/brand', 800],
  ['GET /api/templates', 900],
  ['GET /api/autopilot/runs', 1200],
];

function seedFor(key: string): number {
  let best = 0;
  let ms = 2500;
  for (const [prefix, value] of SEED) {
    if (key.startsWith(prefix) && prefix.length > best) { best = prefix.length; ms = value; }
  }
  return ms;
}

function readPerf(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try { return JSON.parse(window.localStorage.getItem(PERF_STORE) || '{}') || {}; }
  catch { return {}; }
}

function writePerf(map: Record<string, number>) {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(PERF_STORE, JSON.stringify(map)); } catch { /* quota / private mode */ }
}

export function expectedFor(key: string): number {
  const learned = readPerf()[key];
  if (typeof learned === 'number' && learned > 150 && learned < 15 * 60_000) return learned;
  return seedFor(key);
}

function record(key: string, actualMs: number) {
  if (!(actualMs > 0) || actualMs > 15 * 60_000) return;
  const map = readPerf();
  const prev = map[key];
  map[key] = typeof prev === 'number' ? Math.round(prev + EWMA_ALPHA * (actualMs - prev)) : Math.round(actualMs);
  writePerf(map);
}

// --------------------------------------------------------------- generation

// The ONLY work that earns a visible loading screen: drafting content and
// generating/verifying images. Each entry maps to the panel that owns it, so
// the loader covers that panel and nothing else. Everything not on this list
// runs silently (at most the hairline top bar) — saves, deletes, refreshes,
// lookups and the sign-in boot are not "generation" and never block the UI.
const GENERATION: Array<[RegExp, string]> = [
  [/^POST \/api\/generate(?:[/?]|$)/, 'create'],
  [/^POST \/api\/transform(?:[/?]|$)/, 'create'],
  [/^POST \/api\/metricool\/ai-research(?:[/?]|$)/, 'publish'],   // the research box lives in the Publishing panel
  [/^POST \/api\/assistant(?:[/?]|$)/, 'assistant'],
  [/^POST \/api\/drafts\/image(?:[/?]|$)/, 'image-studio'],
  [/^POST \/api\/autopilot\/tick(?:[/?]|$)/, 'autopilot'],
  [/^POST \/api\/autopilot\/runs(?:[/?]|$)/, 'autopilot'],
];

export function generationScopeFor(key: string): string | null {
  for (const [re, scope] of GENERATION) if (re.test(key)) return scope;
  return null;
}

// ------------------------------------------------------------------- labels

// Endpoint → plain-English sentence. Anything unmatched falls back to a
// readable version of the path, so a new route is never a blank overlay.
const LABELS: Array<[RegExp, string]> = [
  [/^POST \/api\/generate(?:[/?]|$)/, 'Writing your content pack'],
  [/^POST \/api\/assistant(?:[/?]|$)/, 'Thinking it through'],
  [/^POST \/api\/drafts\/image(?:[/?]|$)/, 'Generating and verifying the hero image'],
  [/^POST \/api\/drafts(?:[/?]|$)/, 'Saving the draft'],
  [/^PATCH \/api\/drafts(?:[/?]|$)/, 'Updating the draft'],
  [/^DELETE \/api\/drafts(?:[/?]|$)/, 'Deleting the draft'],
  [/^GET \/api\/drafts(?:[/?]|$)/, 'Loading drafts'],
  [/^POST \/api\/transform(?:[/?]|$)/, 'Reworking the copy'],
  [/^POST \/api\/opus\/clip(?:[/?]|$)/, 'Sending the video to OpusClip'],
  [/^GET \/api\/opus\/clip(?:[/?]|$)/, 'Checking clip progress'],
  [/^POST \/api\/autopilot\/tick(?:[/?]|$)/, 'Running the Autopilot engine'],
  [/^(POST|GET) \/api\/autopilot\/runs(?:[/?]|$)/, 'Working through the Autopilot queue'],
  [/^POST \/api\/templates\/apply(?:[/?]|$)/, 'Scheduling the template'],
  [/^(GET|POST|DELETE) \/api\/templates(?:[/?]|$)/, 'Loading templates'],
  [/^POST \/api\/metricool\/ai-research(?:[/?]|$)/, 'Researching the topic'],
  [/^POST \/api\/metricool\/schedule(?:[/?]|$)/, 'Scheduling with Metricool'],
  [/^GET \/api\/metricool\/insights(?:[/?]|$)/, 'Loading recent performance'],
  [/^GET \/api\/metricool(?:[/?]|$)/, 'Checking the Metricool connection'],
  [/^GET \/api\/semrush\?action=advise(?:[/?]|$)/, 'Building your SEO plan'],
  [/^GET \/api\/semrush\?action=domain(?:[/?]|$)/, 'Analysing the domain'],
  [/^GET \/api\/semrush\?action=hub(?:[/?]|$)/, 'Researching keywords'],
  [/^GET \/api\/semrush\?action=serp(?:[/?]|$)/, 'Reading the search results'],
  [/^GET \/api\/semrush(?:[/?]|$)/, 'Talking to Semrush'],
  [/^GET \/api\/keywords(?:[/?]|$)/, 'Researching keywords'],
  [/^(GET|POST) \/api\/brand(?:[/?]|$)/, 'Loading your brand profile'],
  [/^GET \/api\/posts(?:[/?]|$)/, 'Loading the publishing queue'],
  [/^PATCH \/api\/posts(?:[/?]|$)/, 'Rescheduling the post'],
  [/^GET \/api\/stats(?:[/?]|$)/, 'Refreshing the numbers'],
  [/^POST \/api\/realtime-session(?:[/?]|$)/, 'Opening the voice channel'],
];

export function labelFor(key: string): string {
  for (const [re, label] of LABELS) if (re.test(key)) return label;
  const path = key.split(' ')[1] || key;
  const tail = path.replace(/^\/api\//, '').split('?')[0].replace(/[/-]/g, ' ').trim();
  return tail ? 'Working on ' + tail : 'Working';
}

// -------------------------------------------------------------------- store

let tasks: Task[] = [];
let batchStart = 0;
let batchFloor = 0;               // monotonic guard: percent never goes backwards
const scopeStarts = new Map<string, number>();   // per-panel batch start
const scopeFloors = new Map<string, number>();   // per-panel monotonic guard
const listeners = new Set<() => void>();
let seq = 0;

function emit() { listeners.forEach((l) => { try { l(); } catch { /* a bad listener must not stall the bus */ } }); }

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Eased progress for a task with no explicit reporter: approaches 0.94
// asymptotically so a slow endpoint keeps moving without ever claiming done.
function curve(task: Task, now: number): number {
  if (task.state !== 'running') return 1;
  if (typeof task.explicit === 'number') return Math.max(0, Math.min(0.99, task.explicit));
  const elapsed = Math.max(0, now - task.startedAt);
  const tau = Math.max(200, task.expectedMs / 2.3);
  return 0.94 * (1 - Math.exp(-elapsed / tau));
}

const DONE_LINGER_MS = 700;       // finished tasks stay visible briefly

// Cost-weighted aggregate of a pool of tasks into one 0..100 number.
function aggregate(pool: Task[], now: number): number {
  let weight = 0;
  let sum = 0;
  for (const t of pool) {
    const w = Math.max(300, t.expectedMs);
    weight += w;
    sum += w * curve(t, now);
  }
  return weight > 0 ? (sum / weight) * 100 : 0;
}

// The view a single panel's loader reads: only the foreground (generation)
// tasks belonging to that panel's scope, with its own monotonic percentage.
export function scopedSnapshot(scope: string, now: number = Date.now()): Snapshot {
  const live = tasks.filter(
    (t) => t.kind === 'foreground' && t.scope === scope &&
      (t.state === 'running' || (t.endedAt || 0) + DONE_LINGER_MS > now),
  );
  const running = live.filter((t) => t.state === 'running');
  const active = running.length > 0;

  let percent = aggregate(live, now);
  if (!active && live.length > 0) percent = 100;
  if (!active && live.length === 0) {
    scopeFloors.delete(scope);
    scopeStarts.delete(scope);
    percent = 0;
  } else {
    const floor = scopeFloors.get(scope) || 0;
    percent = Math.max(percent, floor);
    scopeFloors.set(scope, percent);
    if (!scopeStarts.has(scope)) scopeStarts.set(scope, running[0]?.startedAt || now);
  }

  const headline = running[0] || live[0];
  return {
    tasks: live,
    running,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    active,
    backgroundActive: false,
    label: headline ? headline.label : 'Finishing up',
    since: scopeStarts.get(scope) || now,
  };
}

export function snapshot(now: number = Date.now()): Snapshot {
  const live = tasks.filter((t) => t.state === 'running' || (t.endedAt || 0) + DONE_LINGER_MS > now);
  const running = live.filter((t) => t.state === 'running');
  const fg = live.filter((t) => t.kind === 'foreground');
  const fgRunning = fg.filter((t) => t.state === 'running');

  const pool = fg.length ? fg : live;
  let percent = aggregate(pool, now);

  const active = fgRunning.length > 0;
  if (!active && fg.length > 0) percent = 100;
  if (!active && fg.length === 0) { batchFloor = 0; percent = pool.length > 0 ? percent : 0; }
  else { percent = Math.max(percent, batchFloor); batchFloor = percent; }

  const headline = fgRunning[0] || running[0];
  return {
    tasks: live,
    running,
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    active,
    backgroundActive: running.some((t) => t.kind === 'background'),
    label: headline ? headline.label : 'Finishing up',
    since: batchStart,
  };
}

export type TaskHandle = {
  id: string;
  setProgress: (p: number) => void;
  setLabel: (label: string, detail?: string) => void;
  done: () => void;
  fail: (detail?: string) => void;
};

export function startTask(opts: {
  key?: string;
  label?: string;
  detail?: string;
  kind?: TaskKind;
  scope?: string;
  expectedMs?: number;
}): TaskHandle {
  const key = opts.key || 'TASK ' + (opts.label || 'work');
  const now = Date.now();
  const task: Task = {
    id: 'task-' + (++seq) + '-' + now,
    key,
    label: opts.label || labelFor(key),
    detail: opts.detail,
    kind: opts.kind || 'foreground',
    scope: opts.scope || generationScopeFor(key) || 'app',
    startedAt: now,
    expectedMs: opts.expectedMs || expectedFor(key),
    state: 'running',
  };
  const anyForeground = tasks.some((t) => t.state === 'running' && t.kind === 'foreground');
  if (task.kind === 'foreground' && !anyForeground) { batchStart = now; batchFloor = 0; }
  // A scope going idle → active starts a fresh batch for that panel. Without
  // this, a panel whose loader was unmounted when its last batch finished
  // (closed modal, route change) would inherit a stale high floor and its next
  // generation would start at ~90% instead of 0.
  if (task.kind === 'foreground' &&
      !tasks.some((t) => t.state === 'running' && t.kind === 'foreground' && t.scope === task.scope)) {
    scopeFloors.delete(task.scope);
    scopeStarts.set(task.scope, now);
  }
  tasks = [...tasks, task];
  emit();

  const finish = (state: TaskState, detail?: string) => {
    const t = tasks.find((x) => x.id === task.id);
    if (!t || t.state !== 'running') return;
    t.state = state;
    t.endedAt = Date.now();
    if (detail) t.detail = detail;
    if (state === 'done') record(t.key, t.endedAt - t.startedAt);
    tasks = [...tasks];
    emit();
    window.setTimeout(() => {
      tasks = tasks.filter((x) => x.state === 'running' || (x.endedAt || 0) + DONE_LINGER_MS > Date.now());
      emit();
    }, DONE_LINGER_MS + 60);
  };

  return {
    id: task.id,
    setProgress(p: number) {
      const t = tasks.find((x) => x.id === task.id);
      if (!t || t.state !== 'running') return;
      t.explicit = Math.max(t.explicit ?? 0, Math.max(0, Math.min(0.99, p)));
      tasks = [...tasks]; emit();
    },
    setLabel(label: string, detail?: string) {
      const t = tasks.find((x) => x.id === task.id);
      if (!t) return;
      t.label = label;
      if (detail !== undefined) t.detail = detail;
      tasks = [...tasks]; emit();
    },
    done: () => finish('done'),
    fail: (detail?: string) => finish('error', detail),
  };
}

// Wrap any async unit of work (not just a fetch) so it shows on the loading
// screen — used by multi-step flows that want one honest bar for the whole
// sequence instead of a flicker per request.
export async function runTask<T>(
  opts: { key?: string; label: string; detail?: string; kind?: TaskKind; scope?: string; expectedMs?: number },
  fn: (handle: TaskHandle) => Promise<T>,
): Promise<T> {
  const handle = startTask(opts);
  try {
    const out = await fn(handle);
    handle.done();
    return out;
  } catch (e: any) {
    handle.fail(e?.message);
    throw e;
  }
}

// ------------------------------------------------------- fetch interception

// Endpoints that poll on a timer. They must never take over the screen.
const QUIET = [
  /^\/api\/opus\/clip/,
  /^\/api\/autopilot\/runs$/,
  /^\/api\/semrush\?action=balance/,
];

let installed = false;

// Kept for API compatibility (call sites and tests reference it); the
// classifier no longer promotes requests just because a click happened.
export function noteInteraction() { /* interaction no longer changes classification */ }

// Foreground = a panel loading screen. ONLY generation work (drafting content,
// generating/verifying images, Autopilot runs) qualifies — everything else,
// including the sign-in boot fetches, saves, deletes, schedules and lookups,
// stays background: silent, or at most the hairline top bar.
function classify(key: string, path: string, headerHint: string | null): TaskKind {
  if (headerHint === 'quiet') return 'background';
  if (headerHint === 'loud') return 'foreground';
  // Generation outranks the QUIET path list: the same /api/autopilot/runs path
  // is a quiet GET poller but a foreground POST action (approve/regenerate) —
  // the key carries the method, so the whitelist can tell them apart.
  if (generationScopeFor(key)) return 'foreground';
  if (QUIET.some((re) => re.test(path))) return 'background';
  return 'background';
}

export function installFetchProgress() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;

  const original = window.fetch.bind(window);

  window.fetch = async function tracked(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let path = '';
    let method = 'GET';
    let hint: string | null = null;
    let scopeHint: string | null = null;
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const url = new URL(raw, window.location.origin);
      // Only this app's own API is observed. Third-party calls (OpenAI
      // realtime, Supabase, fonts) and Next's internals stay untouched.
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) {
        return original(input as any, init);
      }
      path = url.pathname + url.search;
      method = String(init?.method || (input as Request)?.method || 'GET').toUpperCase();
      const h = new Headers(init?.headers || (input as Request)?.headers || undefined);
      hint = h.get('x-chi-progress');
      scopeHint = h.get('x-chi-progress-scope');
    } catch {
      return original(input as any, init);
    }

    // Key ignores volatile query values but keeps `action`, which is what
    // actually changes how long a Semrush call takes.
    const base = path.split('?')[0];
    const action = /[?&]action=([a-z-]+)/i.exec(path)?.[1];
    const key = method + ' ' + base + (action ? '?action=' + action : '');

    const kind = classify(key, path, hint);

    const handle = startTask({
      key,
      kind,
      scope: scopeHint || generationScopeFor(key) || 'app',
      label: labelFor(key),
    });
    try {
      const res = await original(input as any, init);
      if (res.ok) handle.done(); else handle.fail('Server returned ' + res.status);
      return res;
    } catch (e: any) {
      handle.fail(e?.message || 'Network error');
      throw e;
    }
  } as typeof window.fetch;
}

// Install at module-evaluation time. React runs CHILD effects before PARENT
// effects, so every panel fires its first fetches before ProgressProvider's
// useEffect ever gets to call installFetchProgress() — which would make the
// hairline top bar miss the initial page load. Client bundles are evaluated
// before hydration effects run, so patching here guarantees the very first
// fetch is already observed.
// installFetchProgress() is idempotent, so the later useEffect calls are
// harmless no-ops.
if (typeof window !== 'undefined') {
  try { installFetchProgress(); } catch { /* never break the app over progress */ }
}
