// web/lib/workspace-snapshot.ts
// What else is going on, for the assistant: the calendar, the Autopilot
// queue, the drafts and the planner — in a few capped lines.
//
// The LIVE SITUATION block (lib/assistant-context.ts) covers the video
// pipeline and the health checks, and nothing else: the assistant could say
// which reel was stuck and could not say how many posts were waiting for
// approval on the calendar it was sitting next to. This is the rest of the
// room. Every read fails open to a line saying it could not be read, never
// to a confident zero.
import 'server-only';

import { supabaseAdmin } from '@/lib/supabase-admin';
import { isAwaitingApproval, APPROVED_STATUS } from '@/lib/post-mode';
import { reportError } from '@/lib/report';

const NAMED = 3;
const TITLE = 60;

function trim(s: unknown, fallback: string): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim() || fallback;
  return t.length > TITLE ? t.slice(0, TITLE - 1) + '…' : t;
}

function when(iso: unknown): string {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Cancun' });
}

export async function workspaceBlock(userId: string): Promise<string> {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const lines: string[] = ['WORKSPACE (right now, clinic time — use it to answer, do not recite it):'];

  // The calendar.
  try {
    const { data, error } = await db
      .from('posts')
      .select('id, text, status, publication_date, providers')
      .eq('user_id', userId)
      .gte('publication_date', new Date(Date.now() - 24 * 3600_000).toISOString())
      .order('publication_date', { ascending: true })
      .limit(60);
    if (error) throw error;
    const rows = (data || []) as { id: string; text?: string | null; status?: string | null; publication_date?: string | null; providers?: string[] | null }[];
    const waiting = rows.filter((r) => isAwaitingApproval(r.status));
    const approved = rows.filter((r) => String(r.status || '') === APPROVED_STATUS && String(r.publication_date || '') >= now);
    const name = (r: typeof rows[number]) =>
      '"' + trim(String(r.text || '').split('\n')[0], 'Untitled') + '" (' + (r.providers || []).join(', ') + ', ' + when(r.publication_date) + ')';
    lines.push(
      '- Calendar: ' + waiting.length + ' post' + (waiting.length === 1 ? '' : 's') + ' waiting for approval' +
      (waiting.length ? ' — next: ' + waiting.slice(0, NAMED).map(name).join('; ') : '') +
      '; ' + approved.length + ' approved and scheduled ahead.',
    );
  } catch (e) {
    reportError('workspace:posts', e);
    lines.push('- Calendar: could not be read just now.');
  }

  // The Autopilot queue.
  try {
    const { data, error } = await db
      .from('template_runs')
      .select('id, state, scheduled_for, angle')
      .eq('user_id', userId)
      .eq('state', 'ready_for_review')
      .order('scheduled_for', { ascending: true })
      .limit(20);
    if (error) throw error;
    const rows = (data || []) as { id: string; scheduled_for?: string | null; angle?: { query?: string; seedTopic?: string } | null }[];
    lines.push(
      '- Autopilot: ' + rows.length + ' draft' + (rows.length === 1 ? '' : 's') + ' waiting for review' +
      (rows.length ? ' — ' + rows.slice(0, NAMED).map((r) => '"' + trim(r.angle?.query || r.angle?.seedTopic, 'Untitled') + '" (' + when(r.scheduled_for) + ')').join('; ') : '') + '.',
    );
  } catch (e) {
    reportError('workspace:runs', e);
    lines.push('- Autopilot: could not be read just now.');
  }

  // The drafts. Ids travel with the latest few so generate_image can name one.
  try {
    const { data, error, count } = await db
      .from('drafts')
      .select('id, topic, pack, created_at', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    const rows = (data || []) as { id: string; topic?: string | null; pack?: { title?: string; kind?: string; _image?: { url?: string } } | null }[];
    lines.push(
      '- Drafts: ' + (count ?? rows.length) + ' saved; latest: ' +
      (rows.length ? rows.map((r) => '"' + trim(r.pack?.title || r.topic, 'Untitled') + '" [' + r.id + (r.pack?._image?.url ? ', has picture' : ', no picture') + ']').join('; ') : 'none') + '.',
    );
  } catch (e) {
    reportError('workspace:drafts', e);
    lines.push('- Drafts: could not be read just now.');
  }

  // The planner.
  try {
    const { data, error } = await db.from('templates').select('id, name, active').eq('user_id', userId).limit(50);
    if (error) throw error;
    const rows = (data || []) as { name?: string | null; active?: boolean | null }[];
    const active = rows.filter((r) => r.active !== false);
    lines.push('- Planner: ' + active.length + ' active template' + (active.length === 1 ? '' : 's') + (rows.length > active.length ? ', ' + (rows.length - active.length) + ' paused' : '') + '.');
  } catch (e) {
    reportError('workspace:templates', e);
    lines.push('- Planner: could not be read just now.');
  }

  return lines.join('\n');
}

/**
 * What has worked for this brand, from the numbers: the posts with the most
 * engagement, the networks and times of day that do best, and the keywords
 * the drafts that performed were written to. This is what "a step ahead"
 * is based on — the assistant chooses its suggestions from here, not from
 * habit. Ninety days, capped, and every read fails open to a line saying so.
 */
export async function performanceBlock(userId: string): Promise<string> {
  const db = supabaseAdmin();
  const lines: string[] = ['WHAT HAS WORKED (last 90 days, from Metricool\u2019s numbers — choose suggestions from this):'];
  const since = new Date(Date.now() - 90 * 24 * 3600_000).toISOString();
  try {
    const { data, error } = await db
      .from('post_metrics')
      .select('network, text, published_at, impressions, engagement')
      .eq('user_id', userId)
      .gte('published_at', since)
      .limit(1500);
    if (error) throw error;
    const rows = ((data || []) as { network?: string | null; text?: string | null; published_at?: string | null; impressions?: number | null; engagement?: number | null }[])
      .map((r) => ({ network: String(r.network || 'unknown'), text: String(r.text || ''), at: String(r.published_at || ''), engagement: Number(r.engagement) || 0, impressions: Number(r.impressions) || 0 }));
    if (!rows.length) {
      lines.push('- No published post has numbers yet, so nothing is known to have worked; say so rather than guess.');
    } else {
      const top = [...rows].sort((a, b) => b.engagement - a.engagement).slice(0, 3);
      lines.push('- Best posts: ' + top.map((r) => '"' + trim(r.text.split('\n')[0], 'Untitled') + '" (' + r.network + ', engagement ' + r.engagement + ')').join('; ') + '.');
      const byNet = new Map<string, { n: number; e: number }>();
      for (const r of rows) { const c = byNet.get(r.network) || { n: 0, e: 0 }; c.n++; c.e += r.engagement; byNet.set(r.network, c); }
      const nets = [...byNet].filter(([, c]) => c.n >= 2).map(([k, c]) => ({ k, avg: c.e / c.n, n: c.n })).sort((a, b) => b.avg - a.avg);
      if (nets.length) lines.push('- Networks by average engagement: ' + nets.map((x) => x.k + ' ' + x.avg.toFixed(1) + ' (' + x.n + ' posts)').join(', ') + '.');
      const slots = new Map<string, { n: number; e: number }>();
      for (const r of rows) {
        const d = new Date(r.at); if (Number.isNaN(d.getTime())) continue;
        const h = Number(d.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Cancun' }));
        const slot = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
        const c = slots.get(slot) || { n: 0, e: 0 }; c.n++; c.e += r.engagement; slots.set(slot, c);
      }
      const best = [...slots].filter(([, c]) => c.n >= 2).map(([k, c]) => ({ k, avg: c.e / c.n })).sort((a, b) => b.avg - a.avg);
      if (best.length) lines.push('- Time of day (clinic time) by average engagement: ' + best.map((x) => x.k + ' ' + x.avg.toFixed(1)).join(', ') + '.');
    }
  } catch (e) {
    reportError('workspace:performance', e);
    lines.push('- The performance numbers could not be read just now.');
  }
  try {
    const { data, error } = await db.from('draft_keywords').select('keyword, role').eq('user_id', userId).order('created_at', { ascending: false }).limit(300);
    if (error) throw error;
    const counts = new Map<string, number>();
    for (const r of (data || []) as { keyword?: string | null; role?: string | null }[]) {
      const k = String(r.keyword || '').trim().toLowerCase(); if (!k) continue;
      counts.set(k, (counts.get(k) || 0) + (r.role === 'primary' ? 2 : 1));
    }
    const kws = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
    if (kws.length) lines.push('- Keywords the drafts have been written to most: ' + kws.join(', ') + '.');
  } catch (e) {
    reportError('workspace:keywords', e);
  }
  return lines.join('\n');
}
