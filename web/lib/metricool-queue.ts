// web/lib/metricool-queue.ts
// Read Metricool's queue back, so our rows say what Metricool knows.
//
// GET /api/posts calls this on every read: the posts Metricool holds for
// each brand profile this deployment owns, between two dates, keyed by id.
// One call per brand, answered from a short memory cache so the refresh bus
// (which re-reads the list on every signal) does not become a Metricool
// call per screen. A failure is reported and answers an empty map: the
// queue still renders, from our own rows, as it always did.
import { metricoolConfigured, metricoolFetch } from '@/lib/metricool';
import { describeAnswer, indexByPostId } from '@/lib/metricool-state';
import { recordProviderOutcomeNow } from '@/lib/provider-status';
import { redact, reportError } from '@/lib/report';

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; posts: Map<string, Record<string, unknown>> }>();

function day(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

export async function metricoolQueue(blogIds: Iterable<string>, start: Date, end: Date): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  // Every way this read can end leaves a record (awaited: the request that
  // called us returns right after, and a note in flight is lost). Silence
  // used to be indistinguishable from "never ran".
  if (!metricoolConfigured()) {
    await recordProviderOutcomeNow('metricool', { ok: false, message: 'queue read skipped: Metricool is not configured' });
    return out;
  }
  const range = '?start=' + day(start) + '&end=' + day(end);
  await Promise.all(Array.from(blogIds).map(async (blogId) => {
    const key = blogId + range;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      for (const [id, p] of hit.posts) out.set(id, p);
      return;
    }
    try {
      const res = await metricoolFetch('/v2/scheduler/posts' + range, { method: 'GET', blogId, timeoutMs: 8_000 });
      if (!res.ok) {
        // Said in the provider record too, so /api/health and the status
        // table show a queue read Metricool refused, with its own words.
        const said = (await res.text().catch(() => '')).slice(0, 160);
        await recordProviderOutcomeNow('metricool', { ok: false, message: 'queue read: Metricool ' + res.status + ' ' + said });
        reportError('posts:metricool-queue', new Error('Metricool ' + res.status), { blogId });
        return;
      }
      const raw = await res.json().catch(() => null);
      const posts = indexByPostId(raw);
      // The shape of the answer is not documented; the record keeps the last
      // one seen (counts, keys and status fields, never the text).
      await recordProviderOutcomeNow('metricool', { ok: true, message: describeAnswer(raw) });
      cache.set(key, { at: Date.now(), posts });
      for (const [id, p] of posts) out.set(id, p);
    } catch (e) {
      await recordProviderOutcomeNow('metricool', { ok: false, message: 'queue read failed: ' + redact(String((e as Error)?.message || e)).slice(0, 200) });
      reportError('posts:metricool-queue', e, { blogId });
    }
  }));
  return out;
}
