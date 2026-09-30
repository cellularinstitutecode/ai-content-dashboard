// web/lib/competitive-brief.ts
// Who is at the top of Google for this subject, what they are doing, and the
// instruction that turns it into OUR post: the same job, in the Brand Brain's
// voice.
//
// The clinic's rule since the voice assistant started drafting on command:
// every draft is written knowing the competition. Before this, only the video
// pipeline looked at the SERP (lib/serp-landscape.ts) and only the
// "compare me" tool named the leaders. This is the one place both come from,
// so the assistant's drafts, the batch drafts, the Content Generator and the
// Autopilot all write to the same brief — and the comparables the assistant
// shows are the ones the writer was given.
//
// Semrush, cache-first and unit-floor guarded; fails open to '' so a draft is
// never held for a lookup.
import 'server-only';

import { serpCompetitors } from '@/lib/semrush';
import { primaryDomain, topOrganicKeywords } from '@/lib/semrush-domain';
import { classifyDomain, serpLandscapeFrom, themesFrom } from '@/lib/serp-landscape';
import { reportError } from '@/lib/report';

export type Leader = {
  rank: number;
  domain: string;
  url: string;
  /** Whether it is the clinic's own site. */
  mine: boolean;
  kind: string;
  /** Its angle, read from the page's slug. */
  angle: string;
  themes: string[];
  /** The searches it owns: "keyword #position (volume/mo)". */
  owns: string[];
};

export type CompetitiveBrief = {
  /** The prompt block for the writer; '' when there is no data. */
  hint: string;
  leaders: Leader[];
  landscape: string;
  source: string;
  reason?: string;
};

const NONE: CompetitiveBrief = { hint: '', leaders: [], landscape: '', source: 'none' };

/** The top three for a topic, and the brief that mirrors them in our voice. */
export async function competitiveBrief(topic: string, opts: { limit?: number; leaders?: number } = {}): Promise<CompetitiveBrief> {
  const phrase = String(topic || '').replace(/\s+/g, ' ').trim();
  if (!phrase) return NONE;
  try {
    const serp = await serpCompetitors(phrase, { limit: opts.limit ?? 10 });
    if (!serp.ok || !serp.rows.length) return { ...NONE, reason: serp.reason };
    const mine = primaryDomain();
    const rows = serp.rows.filter((r) => r && r.domain);
    const leaders: Leader[] = [];
    for (const [i, r] of rows.slice(0, opts.leaders ?? 3).entries()) {
      const domain = r.domain.replace(/^www\./, '');
      let owns: string[] = [];
      try {
        const kw = await topOrganicKeywords(domain, 6);
        owns = kw.rows.slice(0, 6).map((k) => '"' + k.keyword + '"' + (k.position ? ' #' + k.position : '') + (k.volume ? ' (' + k.volume + '/mo)' : ''));
      } catch { owns = []; }
      const slug = String(r.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
      leaders.push({
        rank: i + 1,
        domain,
        url: r.url || '',
        mine: domain === mine,
        kind: classifyDomain(r.domain),
        angle: slug.replace(/[-_/]+/g, ' ').replace(/\.\w+$/, '').trim(),
        themes: themesFrom([r]),
        owns,
      });
    }
    const landscape = serpLandscapeFrom(phrase, rows);
    const lines: string[] = ['THE COMPETITION (top of Google for "' + phrase + '", Semrush ' + serp.source + '):'];
    for (const l of leaders) {
      lines.push(
        '- #' + l.rank + ' ' + l.domain + (l.mine ? ' (THIS CLINIC)' : '') + ' — ' + l.kind +
        (l.angle ? '; its angle: ' + l.angle : '') +
        (l.themes.length ? '; theme: ' + l.themes.join(', ') : '') +
        (l.owns.length ? '; searches it owns: ' + l.owns.join(', ') : ''),
      );
    }
    if (landscape) lines.push(landscape);
    lines.push(
      'MIRROR THE LEADERS IN OUR VOICE: do the job their pages do — the angle they take, the question they answer, the promise they make — ' +
      'but from THIS clinic: its facts, its doctors, its place, its voice and house rules from the CLINIC PROFILE, and only claims a REF line can back. ' +
      'Never their words, never a number or a claim you cannot support. Where a leader is a hospital or a reference work, do not out-explain it; ' +
      'take the angle the clinic can own instead.',
    );
    return { hint: lines.join('\n'), leaders, landscape, source: serp.source };
  } catch (e) {
    reportError('competitive-brief', e, { topic: phrase.slice(0, 80) });
    return NONE;
  }
}

/** One line for the person: who the draft was written against. */
export function leadersLine(brief: CompetitiveBrief): string {
  if (!brief.leaders.length) return '';
  return brief.leaders.map((l) => '#' + l.rank + ' ' + l.domain + (l.mine ? ' (us)' : '') + (l.angle ? ' — ' + l.angle : '')).join('; ');
}
