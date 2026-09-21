// web/lib/template-strategy.ts
// What a schedule template tells the engine to do, and the one function that
// cleans it.
//
// WHY ITS OWN FILE. `strategy` is a jsonb column filled in from four doors —
// the templates form, the weekly planner, the assistant's tools and the
// strategy seed — and normalizeStrategy is the only thing standing between
// those four and the engine. It lived in lib/autopilot.ts, which imports
// `server-only` and therefore cannot be loaded by the test runner, so the
// round trip that the seed's ownership mark depends on could only ever be
// GREPPED for. Here it can be run.
//
// Pure: no imports, so the test runner reads this file directly.

/** The content formats the writer knows, mirroring ContentType in lib/ai.ts. */
export type StrategyFormat = 'social' | 'blog' | 'email' | 'video' | 'ad';

export type StrategyMode = 'off' | 'fixed_topic' | 'pillars' | 'auto';

export type TemplateStrategy = {
  mode: StrategyMode;
  topic?: string;
  pillars?: string[];
  goal?: 'rank' | 'traffic' | 'engagement' | 'authority';
  format?: StrategyFormat;
  lead_hours?: number;
  max_regens?: number;
  /**
   * Written by "Load the weekly strategy", and only by it.
   *
   * The seed overwrites a template only when this is present (see
   * lib/strategy-seed.ts), so it has to survive normalisation — a mark that
   * silently vanished on write would turn every re-seed into a duplicate.
   */
  seeded?: string;
  /**
   * A standing instruction for every occurrence of this template.
   *
   * Not an angle and not a topic: the clinic's written strategy carries two
   * rules that are true every time a pillar comes round — never claim Cancún
   * is categorically better than other destinations, and recovery services may
   * be introduced but never promoted. They had nowhere to live, so they were
   * enforced by nobody. This is where they live.
   */
  rule?: string;
};

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number);
  return Number.isFinite(n) ? n : null;
}

export function normalizeStrategy(raw: unknown): TemplateStrategy {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const mode: StrategyMode = ['off', 'fixed_topic', 'pillars', 'auto'].includes(String(s.mode))
    ? (String(s.mode) as StrategyMode)
    : 'off';
  const pillars = Array.isArray(s.pillars)
    ? s.pillars.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 12)
    : [];
  const goal = ['rank', 'traffic', 'engagement', 'authority'].includes(String(s.goal))
    ? (String(s.goal) as TemplateStrategy['goal'])
    : 'rank';
  const format = ['social', 'blog', 'email', 'video', 'ad'].includes(String(s.format))
    ? (String(s.format) as StrategyFormat)
    : 'social';
  const lead = num(s.lead_hours);
  const regens = num(s.max_regens);
  return {
    mode,
    topic: typeof s.topic === 'string' ? s.topic.trim().slice(0, 200) : undefined,
    pillars,
    goal,
    format,
    lead_hours: lead != null && lead >= 1 && lead <= 96 ? Math.round(lead) : 24,
    max_regens: regens != null && regens >= 0 && regens <= 2 ? Math.round(regens) : 1,
    // Clamped like every other field here, because this one reaches the model
    // as an instruction it must obey: a 4,000-word "rule" pasted into a
    // template would crowd out the brief it is meant to qualify.
    rule: typeof s.rule === 'string' && s.rule.trim() ? s.rule.trim().slice(0, 400) : undefined,
    seeded: typeof s.seeded === 'string' && s.seeded.trim() ? s.seeded.trim().slice(0, 40) : undefined,
  };
}
