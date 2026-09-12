// web/lib/health-notes.ts
// Failing health checks, turned into the few sentences the assistant should say.
//
// lib/health-plain.ts has said "One map, two readers" in its header since it was
// written. It had one: the banner in components/SystemStatus.tsx. The assistant
// — the thing people actually type "is this broken?" into — built its whole idea
// of the world from ONE check (the schema probe), so with drive_storage red it
// would open with "Everything in the video pipeline is either done or moving"
// while the banner an inch above it said no video could be attached to any post.
//
// This is the second reader. No imports beyond the map itself and a type, so the
// test runner strips types and runs this file directly.
import { plainFor } from './health-plain.ts';
import type { HealthNote } from './assistant-context.ts';

/** The shape this needs from a check. Structurally satisfied by lib/health-checks.ts. */
export type CheckLike = {
  name: string;
  ok: boolean;
  severity?: 'required' | 'optional';
  code?: string | null;
};

/**
 * The checks whose failure means a video cannot get through the pipeline AT ALL.
 *
 * Deliberately short. `greetingFor` returns on the FIRST blocking note and says
 * nothing else, so every name here buys silence about everything else — which is
 * right for "the copy cannot be written anywhere" and wrong for "keyword research
 * is paused". Degraded-but-working belongs in the aside, not the headline.
 *
 * audio_extractor is the close call and is deliberately absent: a video with
 * captions still goes through, so it costs quality, not the pipeline.
 */
const BLOCKS_VIDEO = new Set([
  'supabase',
  'supabase_service_role',
  'sweep_owner',
  'sheet_write',
  'ai_provider',
  'drive',
  'drive_storage',
]);

/**
 * Order among the blocking ones, most-upstream first.
 *
 * A deployment with no Supabase also has no sweep owner and no Drive folder, and
 * naming the third of those sends somebody to fix a symptom.
 */
const PRIORITY = [
  'supabase',
  'supabase_service_role',
  'ai_provider',
  'sweep_owner',
  'sheet_write',
  'drive_storage',
  'drive',
];

/**
 * The plain-words notes for everything currently failing.
 *
 * `database_schema` is skipped on purpose: the caller composes that one from the
 * probe itself, which knows exactly which migration file is missing and splits
 * the video half from the Autopilot half. Flattened to "run the migration" it
 * loses the only part a person can act on.
 */
export function healthNotes(checks: readonly CheckLike[]): HealthNote[] {
  const failing = (checks || []).filter((c) => c && !c.ok && c.name !== 'database_schema');

  // `drive` and `drive_storage` fail together whenever DRIVE_FOLDER_ID is unset,
  // and they would say nearly the same thing twice. drive_storage is the more
  // specific of the two — it is the one that names the Shared Drive — so it wins.
  const names = new Set(failing.map((c) => c.name));
  const shown = failing.filter((c) => !(c.name === 'drive' && names.has('drive_storage')));

  const rank = (c: CheckLike) => {
    const i = PRIORITY.indexOf(c.name);
    return i === -1 ? PRIORITY.length : i;
  };

  return shown
    .slice()
    .sort((a, b) => {
      const ba = BLOCKS_VIDEO.has(a.name) ? 0 : 1;
      const bb = BLOCKS_VIDEO.has(b.name) ? 0 : 1;
      if (ba !== bb) return ba - bb;
      const sa = a.severity === 'required' ? 0 : 1;
      const sb = b.severity === 'required' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return rank(a) - rank(b);
    })
    .map((c) => {
      // The reason code matters: "keyword research is paused" is true whether
      // the token is missing or the balance is at its floor, and the difference
      // is exactly who can fix it.
      const said = plainFor(c.name, c.code ?? null);
      return { down: said.down, stillWorks: said.stillWorks, blocksVideos: BLOCKS_VIDEO.has(c.name) };
    });
}
