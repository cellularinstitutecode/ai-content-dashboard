// Module hooks that let the REAL lib/video-ticks.ts run under plain
// `node --test`: a box ticked after a row was prepared, end to end through
// the real hand-off (lib/video-autopilot.ts handOffToMetricool).
//
// Layered on test/handoff-module-hooks.mjs, which already stands in for the
// model, Metricool, the posts table and Google for the hand-off. Three more
// stand-ins here, the ones this path reads and writes:
//   - the sheet (one tab, set by the test: __sheet(rows, hidden));
//   - the database: video_runs looked up by row_key and updated in place,
//     drafts looked up by id (__db({ runs, drafts }));
//   - the register, so the test can see the line the click wrote.
import { resolve as baseResolve, load as baseLoad } from './handoff-module-hooks.mjs';

const STUBS = {
  '@/lib/google-sources': `
    let sheet = { rows: [], hidden: new Set() };
    export function __sheet(rows, hidden) { sheet = { rows, hidden: new Set(hidden || []) }; }
    export const SOURCE_IDS = { videosSheet: () => 'sheet-1' };
    export async function readTabWithMeta(spreadsheetId, tab) { return { rows: sheet.rows, hidden: sheet.hidden }; }
    export async function readTab() { return sheet.rows; }
    export async function ensureAiColumns() { return {}; }
    export async function listTabs() { return [{ title: 'Videos', sheetId: 7 }]; }
    export async function probeDriveMedia() { return { ok: false }; }
    export async function readRowCells() { return {}; }
    export async function updateRowCells() {}
    export function sourcesConfigured() { return true; }
    export async function tabGid() { return 7; }
  `,
  '@/lib/supabase-admin': `
    let db = { runs: [], drafts: [] };
    const updates = [];
    export function __db(next) { db = { runs: next.runs || [], drafts: next.drafts || [] }; updates.length = 0; }
    export function __runs() { return db.runs; }
    export function __updates() { return updates; }
    function matches(row, filters) { return filters.every(([k, v]) => String(row[k]) === String(v)); }
    function table(name) {
      const rows = name === 'video_runs' ? db.runs : name === 'drafts' ? db.drafts : [];
      function query(op, payload) {
        const filters = [];
        const run = () => {
          const hit = rows.filter((r) => matches(r, filters));
          if (op === 'select') return { data: hit[0] || null, error: null };
          if (op === 'update') { hit.forEach((r) => Object.assign(r, payload)); updates.push({ table: name, filters: [...filters], payload, matched: hit.length }); return { data: null, error: null }; }
          return { data: null, error: null };
        };
        const q = {
          eq(k, v) { filters.push([k, v]); return q; },
          maybeSingle() { return Promise.resolve(run()); },
          then(ok, bad) { return Promise.resolve(run()).then(ok, bad); },
        };
        return q;
      }
      return {
        select() { return query('select'); },
        update(payload) { return query('update', payload); },
        upsert() { return Promise.resolve({ error: null }); },
        insert() { return Promise.resolve({ error: null }); },
      };
    }
    export function supabaseAdmin() {
      return {
        from: table,
        storage: { from() { return { upload() { return Promise.resolve({ error: null }); }, getPublicUrl(p) { return { data: { publicUrl: 'https://storage.test/' + p } }; } }; }, createBucket() { return Promise.resolve({}); } },
      };
    }
  `,
  '@/lib/video-register': `
    const events = [];
    export function __events() { return events; }
    export function __reset() { events.length = 0; }
    export async function recordFirstSeen() {}
    export async function recordVideoEvent(input) { events.push(input); return true; }
  `,
};

export async function resolve(specifier, context, next) {
  if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) return { url: 'rowstub:' + specifier, shortCircuit: true };
  return baseResolve(specifier, context, next);
}

export async function load(url, context, next) {
  if (url.startsWith('rowstub:') && Object.prototype.hasOwnProperty.call(STUBS, url.slice(8))) {
    return { format: 'module', source: STUBS[url.slice(8)], shortCircuit: true };
  }
  return baseLoad(url, context, next);
}
