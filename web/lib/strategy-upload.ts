// web/lib/strategy-upload.ts
// "Drop weekly strategy": a strategy document (a PDF like the clinic's
// "Weekly Social Content Strategy") turned into Autopilot schedules.
//
// HOW IT FLOWS. The route (app/api/templates/strategy-upload/route.ts) hands
// the PDF to Claude, which answers in the shape of UPLOAD_SCHEMA: one entry per
// post slot in the week — the day, the time, the pillar, the pillar's bank of
// angles, the channels and any standing rule. Everything the model said is
// then run through normalizeUpload() below, so a slot on "Funday" at "25:99"
// never reaches the database. What comes out is shown to the team as a week;
// on "Create schedules" it becomes ordinary `pillars` templates, which the
// Autopilot already knows how to run: keyword research and the competitor
// landscape for each angle, what has performed before, the verification gates,
// then the review queue. Nothing publishes until someone approves it; approved
// posts go to the calendar and Metricool exactly like every other post.
//
// ADDITIVE, ALWAYS. This file only ever produces rows to INSERT. It never
// updates or deletes a template — the built-in weekly strategy, hand-written
// templates and slots from an earlier upload are all left exactly as they are.
// A slot already created by an earlier upload (same mark, day, time and name)
// is skipped rather than written twice.
//
// Pure: `./x.ts` imports only, so the test runner reads this file directly.
import { STRATEGY_PROVIDERS } from './strategy-seed.ts';

/** The mark on every template this creates: `strategy.seeded`. */
export const UPLOAD_MARK = 'uploaded-strategy';

/** The largest PDF accepted — Vercel refuses request bodies over 4.5 MB. */
export const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/** A week of three posts a day is already more than any plan asks for. */
export const MAX_SLOTS = 21;
export const MAX_ANGLES = 12;

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type DayKey = (typeof DAY_KEYS)[number];
export const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const SOCIAL = ['instagram', 'facebook', 'linkedin'] as const;
/** The article's channels: the blog, promoted with its link on Facebook and LinkedIn. */
export const ARTICLE_PROVIDERS = ['blog', 'facebook', 'linkedin'] as const;

/** What the model is asked to answer with. Every object closed; enums for anything a key depends on. */
export const UPLOAD_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'The document title.' },
    summary: { type: 'string', description: 'One or two sentences: what the strategy is for and how the week is built.' },
    direction: { type: 'string', description: 'The editorial direction every post must follow (tone, what to avoid), in at most three sentences. Empty if the document gives none.' },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string', enum: [...DAY_KEYS] },
          time: { type: 'string', description: '24-hour HH:MM. Empty if the document does not say.' },
          pillar: { type: 'string', description: 'The content pillar or theme of this post, as the document names it.' },
          angles: { type: 'array', items: { type: 'string' }, description: 'The angles, questions or topics the document lists for this pillar, in its order, verbatim where possible.' },
          format: { type: 'string', enum: ['social', 'blog'] },
          channels: { type: 'array', items: { type: 'string', enum: [...SOCIAL, 'blog'] } },
          rule: { type: 'string', description: 'Any standing rule the document gives for this pillar. Empty if none.' },
        },
        required: ['day', 'time', 'pillar', 'angles', 'format', 'channels', 'rule'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'summary', 'direction', 'slots'],
  additionalProperties: false,
} as const;

export const UPLOAD_PROMPT = [
  'This PDF is a weekly content strategy for a medical clinic\'s social media.',
  'Read the whole document and return its week as data: one entry in `slots` for every post it schedules, Monday to Sunday.',
  'For each slot give the day, the time if the document states one (24-hour HH:MM, otherwise an empty string), the pillar or theme,',
  'and the angles the document lists for that pillar — copied in its own words and order, never invented.',
  'A long-form article or blog post is format "blog" with channels ["blog","facebook","linkedin"]; everything else is format "social".',
  'Use only the channels the document names; if it names none, use ["instagram","facebook","linkedin"].',
  'Put any rule the document attaches to a pillar in `rule`, and the document\'s overall editorial direction in `direction`.',
  'If the document is not a content strategy, return an empty `slots` array.',
].join(' ');

export type UploadSlot = {
  /** 0 = Sunday, as `schedule_templates.weekdays` stores. */
  weekday: number;
  /** HH:MM. */
  time: string;
  pillar: string;
  angles: string[];
  format: 'social' | 'blog';
  providers: string[];
  rule: string;
};

export type UploadPlan = {
  title: string;
  summary: string;
  direction: string;
  slots: UploadSlot[];
  /** What was dropped or corrected, in words, for the preview. */
  notes: string[];
};

const clean = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function weekdayOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6) return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  const i = DAY_KEYS.findIndex((k) => s.startsWith(k));
  return i >= 0 ? i : null;
}

/** "9:00", "09:00", "9am", "6:30 PM", "18.00" → "HH:MM"; anything else null. */
export function timeOf(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.[0];
  if (!m[2] && !ampm) return null; // a bare "9" is not a time
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'p' && h !== 12) h += 12;
    if (ampm === 'a' && h === 12) h = 0;
  }
  if (h > 23 || min > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

/**
 * Default times when the document gives none: the social posts at 09:00 and
 * 18:00, a third at 13:00, the article at 11:00 — the built-in strategy's
 * own hours, clear of the video pipeline's 13:00 and 17:00 where possible.
 */
const SOCIAL_DEFAULT_TIMES = ['09:00', '18:00', '13:00'];
const ARTICLE_DEFAULT_TIME = '11:00';

/** Everything the model said, made safe to store — or dropped, with a note saying why. */
export function normalizeUpload(raw: unknown): UploadPlan {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const notes: string[] = [];
  const list = Array.isArray(o.slots) ? o.slots : [];
  const slots: UploadSlot[] = [];
  const seen = new Set<string>();
  const perDay = new Map<number, number>();

  for (const item of list) {
    const s = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const pillar = clean(s.pillar ?? s.name, 80);
    const weekday = weekdayOf(s.day ?? s.weekday);
    if (!pillar || weekday == null) {
      notes.push('A slot without a ' + (!pillar ? 'pillar' : 'day') + ' was left out.');
      continue;
    }
    const providersIn = Array.isArray(s.channels ?? s.providers) ? ((s.channels ?? s.providers) as unknown[]).map((p) => String(p).trim().toLowerCase()) : [];
    const format: 'social' | 'blog' = String(s.format) === 'blog' || providersIn.includes('blog') ? 'blog' : 'social';
    let providers: string[] = format === 'blog'
      ? [...ARTICLE_PROVIDERS]
      : SOCIAL.filter((p) => providersIn.includes(p));
    if (!providers.length) providers = [...STRATEGY_PROVIDERS];

    const nth = perDay.get(weekday) ?? 0;
    let time = timeOf(s.time);
    if (!time) time = format === 'blog' ? ARTICLE_DEFAULT_TIME : SOCIAL_DEFAULT_TIMES[Math.min(nth, SOCIAL_DEFAULT_TIMES.length - 1)];

    const angles: string[] = [];
    const angleKeys = new Set<string>();
    for (const a of Array.isArray(s.angles) ? s.angles : []) {
      const t = clean(a, 200);
      const k = t.toLowerCase();
      if (t && !angleKeys.has(k)) { angleKeys.add(k); angles.push(t); }
    }
    if (angles.length > MAX_ANGLES) notes.push('"' + pillar + '" lists ' + angles.length + ' angles; the first ' + MAX_ANGLES + ' are kept.');
    if (!angles.length) angles.push(pillar);

    const key = weekday + '|' + time + '|' + pillar.toLowerCase();
    if (seen.has(key)) continue;
    if (slots.length >= MAX_SLOTS) {
      notes.push('More than ' + MAX_SLOTS + ' posts a week: "' + pillar + '" on ' + DAY_LABELS[weekday] + ' and any after it were left out.');
      break;
    }
    seen.add(key);
    perDay.set(weekday, nth + 1);
    slots.push({ weekday, time, pillar, angles: angles.slice(0, MAX_ANGLES), format, providers, rule: clean(s.rule, 500) });
  }

  // Monday first, as the document reads; Sunday last.
  slots.sort((a, b) => ((a.weekday + 6) % 7) - ((b.weekday + 6) % 7) || a.time.localeCompare(b.time));
  return {
    title: clean(o.title, 120) || 'Uploaded weekly strategy',
    summary: clean(o.summary, 400),
    direction: clean(o.direction, 400),
    slots,
    notes,
  };
}

/** One `schedule_templates` row, before user_id and timestamps. */
export type UploadRow = {
  name: string;
  providers: string[];
  weekdays: number[];
  time_of_day: string;
  active: true;
  strategy: {
    mode: 'pillars';
    pillars: string[];
    goal: 'authority';
    format: 'social' | 'blog';
    lead_hours: number;
    max_regens: number;
    rule?: string;
    seeded: typeof UPLOAD_MARK;
  };
};

/** The standing rule a slot's posts carry: its own, then the document's direction. ≤ 800, as normalizeStrategy keeps. */
export function ruleFor(slot: UploadSlot, direction: string): string | undefined {
  const parts = [slot.rule, direction ? 'The strategy\'s editorial direction: ' + direction : ''].filter(Boolean);
  const text = parts.join(' ').trim();
  return text ? text.slice(0, 800) : undefined;
}

export function uploadRows(plan: UploadPlan): UploadRow[] {
  return plan.slots.map((s) => {
    const rule = ruleFor(s, plan.direction);
    return {
      name: s.pillar,
      providers: [...s.providers],
      weekdays: [s.weekday],
      time_of_day: s.time,
      active: true as const,
      strategy: {
        mode: 'pillars' as const,
        pillars: [...s.angles],
        goal: 'authority' as const,
        format: s.format,
        lead_hours: 24,
        max_regens: 1,
        ...(rule ? { rule } : {}),
        seeded: UPLOAD_MARK,
      },
    };
  });
}

export type ExistingRow = { name?: unknown; weekdays?: unknown; time_of_day?: unknown; active?: unknown; strategy?: unknown };

const hhmm = (v: unknown) => String(v ?? '').slice(0, 5);
const daysOf = (v: unknown) => (Array.isArray(v) ? v.map(Number) : []);
const markOf = (v: unknown) => String((v && typeof v === 'object' ? (v as { seeded?: unknown }).seeded : '') || '');

export type UploadApplyPlan = {
  create: UploadRow[];
  /** Slots an earlier upload already created — skipped, never written twice. */
  already: UploadRow[];
  /** Other ACTIVE templates posting at the same day and time — both will run. */
  clashes: { slot: string; with: string }[];
};

/** What "Create schedules" will do, given what is already in the account. Insert-only. */
export function planUpload(plan: UploadPlan, existing: readonly ExistingRow[] = []): UploadApplyPlan {
  const out: UploadApplyPlan = { create: [], already: [], clashes: [] };
  for (const row of uploadRows(plan)) {
    const day = row.weekdays[0];
    const same = existing.find((e) =>
      markOf(e.strategy) === UPLOAD_MARK && daysOf(e.weekdays).includes(day) && hhmm(e.time_of_day) === row.time_of_day &&
      String(e.name ?? '').trim().toLowerCase() === row.name.toLowerCase());
    if (same) { out.already.push(row); continue; }
    out.create.push(row);
    for (const e of existing) {
      if (e.active === false || !daysOf(e.weekdays).includes(day) || hhmm(e.time_of_day) !== row.time_of_day) continue;
      out.clashes.push({ slot: DAY_LABELS[day] + ' ' + row.time_of_day + ' · ' + row.name, with: String(e.name ?? 'an unnamed template') });
    }
  }
  return out;
}

export function uploadSummary(p: UploadApplyPlan): string {
  const parts: string[] = [];
  parts.push(p.create.length
    ? p.create.length + ' weekly slot' + (p.create.length === 1 ? '' : 's') + ' created. Autopilot writes each post ahead of time; every one waits in the review queue, and goes to the calendar and Metricool only once approved.'
    : 'Nothing new to create.');
  if (p.already.length) parts.push(p.already.length + ' already there from an earlier upload — left as they are.');
  if (p.clashes.length) parts.push(p.clashes.length + ' share a day and time with another active template; both will post — pause one on the Templates page if that is not wanted.');
  return parts.join(' ');
}
