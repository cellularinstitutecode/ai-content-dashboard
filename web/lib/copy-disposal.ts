// web/lib/copy-disposal.ts
// What to remove when a video copy fails verification — and what never to touch.
//
// A post's video reaches Metricool one of four ways, and only two of them
// create anything this app can remove:
//
//   bucket    an object this app uploaded to Supabase Storage  → delete it
//   drive     a world-readable COPY this app made in Drive     → delete it
//   stream    NOTHING. A signed URL pointing at the clinic's   → delete nothing
//             own original, which the app streams on demand.
//   metricool the bytes, uploaded into Metricool's own         → delete nothing
//             storage (lib/metricool-upload.ts). Theirs now.
//
// The third is why this is a module and not an if-statement. The id recorded
// for a streamed video wraps the SOURCE file's Drive id: the master. The
// dispatchers that clean up after a failed verification used `else` for the
// Drive case, so anything that was not a bucket key went to deleteDriveFile —
// and under that rule a stream marker is a delete of the clinic's footage.
//
// An exhaustive switch cannot have a default branch, so it cannot have that
// bug. Pure, so the rule is tested on its own.

export type CopyWhere = 'bucket' | 'stream' | 'drive' | 'metricool';

export type Disposal = 'bucket' | 'drive' | 'none';

/** Where the bytes of a copy live, and therefore how it is removed. */
export function disposalFor(where: CopyWhere): Disposal {
  switch (where) {
    case 'bucket': return 'bucket';
    case 'drive': return 'drive';
    case 'stream': return 'none';
    case 'metricool': return 'none';
  }
}
