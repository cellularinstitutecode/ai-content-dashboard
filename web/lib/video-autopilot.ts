// web/lib/video-autopilot.ts
// The sweep: what happens on its own when a new link appears in Rodrigo's
// "Distribución RRSS CHI" sheet.
//
// For each row that has a video link and no copy yet:
//   transcript (YouTube captions, or speech-to-text on the Drive .mp4)
//     → Semrush keyword brief
//     → Claude writes the LinkedIn post and the TikTok caption from the
//       transcript, with the REF citation and the AVISO line
//     → COPY, KEYWORDS and REF written back into that row
//     → a draft saved so the copy is editable in the dashboard
//     → a post waiting in Metricool's REVIEW queue for someone to approve.
//
// Three rules hold the whole thing together:
//
//  1. NEVER overwrite what a person wrote. A cell that already has something
//     in it is left exactly as it is, and the run records that it was skipped.
//     This is why the sweep can be turned on over a sheet with 200 rows of
//     existing work without anyone having to check it afterwards.
//  2. Identity is the row's CONTENT, not its row number. Insert a row at the
//     top of a tab and nothing below it is re-processed.
//  3. It never PUBLISHES. What reaches Metricool is a draft in the review
//     queue — the same thing the "Send to Metricool" button has always made —
//     and it never ticks a network column in the sheet, because ticking one
//     is a record that a person published something. Approve stays a person.
import 'server-only';

import {
  SOURCE_IDS,
  ensureAiColumns,
  listTabs,
  probeDriveMedia,
  readTab,
  readTabWithMeta,
  readRowCells,
  updateRowCells,
  sourcesConfigured,
  tabGid,
  type VideoField,
} from '@/lib/google-sources';
import { mayRetry } from '@/lib/failure-kind';
import { megabytes, routeFor } from '@/lib/media-route';
import { canWriteCopy } from '@/lib/prepare-budget';
import { isMissingSchema } from '@/lib/schema-probe';
import { columnFor, pick, tableFromRows } from '@/lib/sheet-table';
import { VIDEO_NETWORK_COLUMNS, publishedNetworks } from '@/lib/sheet-ticks';
import { prepareVideo, saveVideoDraft, type PrepareOk, stampDraftVideoMeta } from '@/lib/video-prepare';
import { EXISTING_COPY_PER_RUN, existingCopyText, isExistingCopyRow, queueExistingEnabled } from '@/lib/existing-copy';
import { attachPendingVideos, pendingVideoPosts } from '@/lib/video-attach';

/** Rows whose waiting drafts get their video per run — same order of cost as queuing. */
const ATTACH_PER_RUN = 20;
import { STATUS_TEXT, claimIsStale, firstLinkIn, fitsNetwork, isCandidate, preparedStatus, rowKeyFor } from '@/lib/video-row';
import { NEEDS_VIDEO, networksFor, nextFreeSlot } from '@/lib/video-slot';
import { belowStart, parseQuota, parseStartRow, remainingQuota, startOfDayIso } from '@/lib/daily-pace';
import { SCHEDULE_TZ } from '@/lib/timezone';
import { publishVideoDraft, takenSlots, type PublishOutcome } from '@/lib/video-publish';
import { reviveStalledRuns, type ReviveResult } from '@/lib/video-revive';
import { cachedPublicCopy } from '@/lib/transcript-cache';
import { ensureShareableVideo } from '@/lib/media-library';
import { awaitingPostsForVideo } from '@/lib/awaiting-posts';
import { isAwaitingApproval } from '@/lib/post-mode';
import { alreadyQueuedMessage, hasGoneOut, networksAlreadyPublished, networksAlreadyQueued } from '@/lib/queue-guard';
import { parseDriveFileId } from '@/lib/drive-url';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';
import { recordFirstSeen, recordVideoEvent } from '@/lib/video-register';
import { SWEEP_KEY, videoKeyFor, type VideoActor } from '@/lib/video-event';

export type SweepOptions = {
  /** Whose brand voice to write in, and who owns the drafts. */
  userId: string;
  /** Stop starting new videos once this much time has gone. */
  budgetMs?: number;
  /** Never do more than this many in one tick, however fast they are. */
  maxVideos?: number;
  /** Look at the sheet and report what WOULD happen, writing nothing. */
  dryRun?: boolean;
  /** Fill the sheet but do not hand anything to Metricool. */
  skipMetricool?: boolean;
  spreadsheetId?: string;
};

export type SweepRowOutcome = {
  tab: string;
  row: number;
  rowKey: string;
  title: string;
  state: 'prepared' | 'needs_transcript' | 'transcript_ready' | 'failed' | 'skipped' | 'would_prepare' | 'queued_existing' | 'would_queue_existing' | 'attached';
  wrote?: Partial<Record<VideoField, boolean>>;
  draftId?: string | null;
  /** One entry per network a draft was attempted for. */
  metricool?: PublishOutcome[];
  message?: string;
};

export type SweepResult = {
  ok: boolean;
  scanned: number;
  candidates: number;
  prepared: number;
  needsTranscript: number;
  failed: number;
  /** Drafts actually waiting in Metricool after this run. */
  metricoolDrafts: number;
  rows: SweepRowOutcome[];
  stoppedEarly: boolean;
  /** How many videos the register had never seen before this sweep. */
  newlySeen: number;
  /** Rows hidden in the sheet, walked past untouched — not even registered. */
  hidden: number;
  /** Rows whose copy was already written, sent to Metricool as drafts with the video, unchanged. */
  queuedExisting: number;
  /** Rows with a video that sit above the start row — seen, never prepared. */
  belowStart: number;
  /**
   * WHY the walk did not reach every row — the counters that tell apart "the
   * queue is off", "those rows were done before", "those rows are retired" and
   * "the run ran out of time". Added when a fortnight of quarter-hour runs
   * left 90 copy rows untouched and the line could not say which gate held them.
   */
  withCopy: number;
  doneBefore: number;
  retired: number;
  priorErrors: number;
  queueOn: boolean;
  stoppedWhy?: 'time' | 'max_videos' | 'per_run_cap' | 'quota' | 'columns';
  /** Drafts that were waiting for their video and got it on this run. */
  attached: number;
  /**
   * The day's pace, when VIDEO_DAILY_QUOTA is set: how many rows the day
   * allows, how many were already prepared today (by any run or any button)
   * before this sweep began, and where the sweep was told to start. Absent
   * when no daily rule is configured.
   */
  pace?: { quota: number; preparedToday: number; startRow: string | null };
  /**
   * What the revive pass handed back to the queue before this sweep started.
   *
   * Carried in the result so the assistant can say "overnight I retried three
   * and fixed two" — the recovery was previously invisible even to the run
   * that performed it.
   */
  revived?: ReviveResult;
};

/**
 * Update one video_runs row, tolerating a database that predates a column.
 *
 * `last_error_code` arrived after the first version of this table, and naming
 * an absent column refuses the WHOLE statement — so on a database where the
 * migration has not been run yet, `state: 'prepared'` would be lost along with
 * it and the row would be re-downloaded and re-transcribed on every sweep from
 * then on, forever, at full price.
 *
 * A refusal that names a missing column is therefore retried without the new
 * field. Everything else is reported rather than swallowed: supabase-js
 * RESOLVES a failed query, so an unchecked update here looks exactly like a
 * successful one.
 */
async function updateRun(
  admin: ReturnType<typeof supabaseAdmin>,
  where: { spreadsheetId: string; tab: string; rowKey: string },
  patch: Record<string, unknown>,
): Promise<void> {
  const apply = (fields: Record<string, unknown>) =>
    admin.from('video_runs').update(fields)
      .eq('spreadsheet_id', where.spreadsheetId).eq('tab', where.tab).eq('row_key', where.rowKey);

  const { error } = await apply(patch);
  if (!error) return;
  if (isMissingSchema(error.code) && 'last_error_code' in patch) {
    const rest = { ...patch };
    delete rest.last_error_code;
    const retry = await apply(rest);
    if (retry.error) reportError('video-sweep:update-run', retry.error, { tab: where.tab });
    return;
  }
  reportError('video-sweep:update-run', error, { tab: where.tab });
}

/**
 * The sweep, plus ONE register line about the run itself.
 *
 * Five quarter-hour runs once produced nothing and nobody could say whether
 * the cron was not reaching the app, the owner could not be resolved, the
 * sheet read failed, or the walk skipped every row: the register recorded
 * rows, never runs. Now every run — including one that throws — leaves a
 * line saying what it saw and did, or why it stopped. Fire-and-forget like
 * every register write; it can never gate the sweep or change its result.
 */
export async function sweepVideos(opts: SweepOptions): Promise<SweepResult> {
  const heartbeat = (detail: Record<string, unknown>) => {
    if (!opts.userId) return;
    void recordVideoEvent({ userId: opts.userId, videoKey: SWEEP_KEY, event: 'sweep_ran', actor: 'sweep', title: 'Video sweep', detail });
  };
  let result: SweepResult;
  try {
    result = await sweepVideosInner(opts);
  } catch (e) {
    heartbeat({ dryRun: opts.dryRun === true, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  const startRow = parseStartRow(process.env.VIDEO_START_ROW);
  heartbeat({
    dryRun: opts.dryRun === true,
    ok: result.ok,
    scanned: result.scanned,
    hidden: result.hidden,
    belowStart: result.belowStart,
    candidates: result.candidates,
    prepared: result.prepared,
    queuedExisting: result.queuedExisting,
    attached: result.attached,
    needsTranscript: result.needsTranscript,
    failed: result.failed,
    metricoolDrafts: result.metricoolDrafts,
    newlySeen: result.newlySeen,
    stoppedEarly: result.stoppedEarly,
    ...(result.stoppedWhy ? { stoppedWhy: result.stoppedWhy } : {}),
    withCopy: result.withCopy,
    doneBefore: result.doneBefore,
    retired: result.retired,
    priorErrors: result.priorErrors,
    queueOn: result.queueOn,
    startRow: startRow ? (startRow.tab ? startRow.tab + '!' : '') + startRow.row : 'none',
    ...(result.ok ? {} : { error: 'Google access is not set up, so the sheet cannot be read.' }),
  });
  return result;
}

async function sweepVideosInner(opts: SweepOptions): Promise<SweepResult> {
  const started = Date.now();
  // Stop STARTING work here so the video already in flight has time to finish
  // and write back. The caller sizes it against its own maxDuration.
  const budgetMs = opts.budgetMs ?? 270_000;
  const maxVideos = opts.maxVideos ?? 1;
  const spreadsheetId = opts.spreadsheetId || SOURCE_IDS.videosSheet();
  const admin = supabaseAdmin();

  const result: SweepResult = { ok: true, scanned: 0, candidates: 0, prepared: 0, needsTranscript: 0, failed: 0, metricoolDrafts: 0, rows: [], stoppedEarly: false, newlySeen: 0, hidden: 0, queuedExisting: 0, belowStart: 0, attached: 0, withCopy: 0, doneBefore: 0, retired: 0, priorErrors: 0, queueOn: false };
  if (!sourcesConfigured()) {
    return { ...result, ok: false };
  }

  // Before reading a single tab: hand back the rows that stopped for reasons
  // which have since passed — a claim from a run that died, a failure that
  // looked temporary and has sat out its cooldown. One query, no spending, and
  // it decides which rows the walk below is even allowed to consider.
  //
  // A dry run reports what WOULD happen and must not move anything.
  if (!opts.dryRun) {
    try {
      result.revived = await reviveStalledRuns(opts.userId, started);
    } catch (e) {
      // Not being able to revive is not a reason to skip the sweep itself.
      reportError('video-sweep:revive', e);
    }
  }

  // Every row the sweep walks past, for the register. Not a set of things to do
  // — the sweep's own budget decides that — just a record that they exist.
  const seenRows: { videoKey: string; title: string; link: string; tab: string; row: number; gid: number | null }[] = [];

  // THE DAY'S PACE. "Two a day" is a count of rows prepared TODAY across every
  // run — the nightly cron, the sheet's edit trigger, a person's Prepare — on
  // the clinic's clock. Counted once, before the walk; the walk adds its own.
  // Unset quota = no daily rule, and the per-run attempt ceiling alone applies.
  const startRow = parseStartRow(process.env.VIDEO_START_ROW);
  const quota = parseQuota(process.env.VIDEO_DAILY_QUOTA);
  let preparedToday = 0;
  if (quota != null) {
    const since = startOfDayIso(new Date(), SCHEDULE_TZ);
    const counted = await admin
      .from('video_runs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', opts.userId)
      .eq('state', 'prepared')
      .gte('updated_at', since)
      .then((x) => x, (e: unknown) => ({ count: null, error: e as { message?: string } }));
    if (counted.error) {
      // Not knowing how many went out today is not a licence to send more.
      reportError('video-sweep:prepared-today', counted.error);
      return { ...result, ok: false };
    }
    preparedToday = counted.count ?? 0;
    result.pace = { quota, preparedToday, startRow: startRow ? (startRow.tab ? startRow.tab + '!' : '') + startRow.row : null };
  }
  const dayAllows = remainingQuota(quota, preparedToday);
  // A dry run prepares nothing, so it counts what it WOULD have prepared —
  // otherwise it would list every row to the end as "would prepare" and say
  // nothing about where the day's pair actually stops.
  let wouldPrepare = 0;
  const quotaReached = () => dayAllows != null && result.prepared + result.queuedExisting + wouldPrepare >= dayAllows;
  // Rows whose copy a person already wrote are queued, not written — with
  // their own per-run cap, because they cost seconds rather than minutes.
  const queueExisting = queueExistingEnabled(process.env);
  result.queueOn = queueExisting;
  let existingThisRun = 0;
  // Rows prepared earlier whose drafts still wait for the video: attached
  // in the walk, a few per run — one copy and a few Metricool calls each.
  let attachedThisRun = 0;

  // ONE SLOT PER ROW. The calendar is read once here; each prepared row takes
  // the next free instant and every network of that row shares it, so a row
  // going to YouTube, LinkedIn and TikTok fills one slot and not three. Read
  // lazily and remembered as failed: a calendar that cannot be read costs the
  // hand-off (reported per row, as before), never the copy.
  let taken: Set<string> | null = null;
  let takenFailed: string | null = null;
  const slotForNextRow = async (): Promise<string | undefined> => {
    if (takenFailed) return undefined;
    if (!taken) {
      try {
        taken = new Set(await takenSlots(opts.userId, new Date().toISOString()));
      } catch (e) {
        takenFailed = e instanceof Error ? e.message : 'The posting calendar could not be read.';
        reportError('video-sweep:slots', e);
        return undefined;
      }
    }
    const slot = nextFreeSlot(taken, new Date());
    if (!slot) return undefined;
    taken.add(slot.toISOString());
    return slot.toISOString();
  };

  const tabs = await listTabs(spreadsheetId);
  for (const tab of tabs) {
    if (result.prepared + result.failed + result.needsTranscript >= maxVideos) { result.stoppedEarly = true; result.stoppedWhy = 'max_videos'; break; }

    let rows: string[][] = [];
    let hidden = new Set<number>();
    try { ({ rows, hidden } = await readTabWithMeta(spreadsheetId, tab.title)); } catch (e) { reportError('video-sweep:tab', e, { tab: tab.title }); continue; }
    const { header, headerRow, records } = tableFromRows(rows, ['tipo de video', 'título del video', 'titulo del video', 'copy', 'link video', 'formato', 'title', 'video']);
    if (!header.length) continue;
    const linkCol = columnFor(header, 'link video', 'link', 'video link');
    if (!linkCol) continue; // not a video tab

    const copyCol = columnFor(header, 'copy', 'caption');

    // The three columns the sweep writes into, created on this tab the first
    // time it actually has something to write there. Lazily, deliberately: a
    // tab of finished 2024 videos should not grow three empty columns just
    // because the sweep read it.
    let aiColumns: Partial<Record<VideoField, string>> | null = null;
    let columnsFailed = false;
    const columnsFor = async (): Promise<Partial<Record<VideoField, string>>> => {
      if (aiColumns) return aiColumns;
      const usedWidth = rows.reduce((w, r) => Math.max(w, (r || []).length), 0);
      aiColumns = await ensureAiColumns(spreadsheetId, tab.title, headerRow, header, usedWidth);
      return aiColumns;
    };

    for (const { rec, row } of records) {
      if (Date.now() - started > budgetMs) { result.stoppedEarly = true; result.stoppedWhy = 'time'; break; }
      if (result.prepared + result.failed + result.needsTranscript >= maxVideos) { result.stoppedEarly = true; result.stoppedWhy = 'max_videos'; break; }

      result.scanned++;
      // HIDDEN ROWS ARE LEFT ALONE. A row the clinic has hidden is finished,
      // parked, or not for the app — and it stays exactly as it is: not
      // registered, not prepared, not written to. The instruction was literal:
      // "whatever is hidden should remain hidden." Checked before anything
      // else so a hidden row costs nothing, not even a register line.
      if (hidden.has(row)) {
        result.hidden++;
        continue;
      }
      const title = pick(rec, 'título del video', 'titulo del video', 'title');
      // The cell can carry a note around the link ("SUBS: https://…", a
      // numbered list of three takes). The first link is the one to work on.
      const videoLink = firstLinkIn(pick(rec, 'link video', 'link', 'video link'));
      const copy = pick(rec, 'copy', 'caption');
      const youtubeLink = (String(pick(rec, 'youtube')).match(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+/i) || [''])[0];
      const rowKey = rowKeyFor(title, videoLink);

      // THE REGISTER. Recorded before the candidate filter, because a row that
      // already has copy is still a video that is in the library — it is just
      // not work to do. Collected here and written once at the end of the sweep,
      // so walking two hundred rows costs one statement rather than two hundred.
      if (videoLink) {
        seenRows.push({
          videoKey: videoKeyFor(spreadsheetId, tab.title, rowKey),
          title,
          link: videoLink,
          tab: tab.title,
          row,
          gid: Number.isFinite(tab.sheetId) ? tab.sheetId : null,
        });
      }
      // WHERE this row is, for every register line about it. The sheet
      // coordinates are the one thing a person can act on from the panel —
      // a title is recognisable, a row number is findable.
      const where = { tab: tab.title, row, gid: Number.isFinite(tab.sheetId) ? tab.sheetId : null };

      // A row with a video AND copy already written is not the sweep's to
      // WRITE — but it is still a draft that needs its video. With queuing
      // on (the default) such a row goes to Metricool with the copy exactly
      // as the sheet has it; lib/existing-copy.ts holds the rule.
      const existingCopy = queueExisting && isExistingCopyRow({ videoLink, copy });
      if (!isCandidate({ videoLink, copy }) && !existingCopy) continue;
      // Before the start row: in the library and registered as seen, but not
      // this sweep's to prepare. Said in the report so a dry run shows exactly
      // which rows the rule is holding back.
      if (belowStart(tab.title, row, startRow)) {
        result.belowStart++;
        result.rows.push({ tab: tab.title, row, rowKey, title: title || videoLink, state: 'skipped', message: 'Below the start row (' + String(startRow?.row) + ').' });
        continue;
      }
      // The day's quota is full: this row waits for tomorrow's run. The walk
      // goes on (a `continue`, not a `break`) so every row is still registered
      // as seen, and no video_runs query is spent on a row that will not run.
      if (quotaReached()) {
        result.stoppedEarly = true;
        result.stoppedWhy = 'quota';
        result.rows.push({ tab: tab.title, row, rowKey, title: title || videoLink, state: 'skipped', message: 'Today\u2019s ' + String(quota) + ' are done (' + String(preparedToday + result.prepared + wouldPrepare) + ' prepared); this row waits for the next day.' });
        continue;
      }
      // Where the clinic has said this video goes. Ticks only — a FALSE
      // checkbox is Google's default, not a destination.
      const rowNetworks = VIDEO_NETWORKS.filter(([col]) => YES_TICK.test(pick(rec, col))).map(([, n]) => n);

      // Has this row been dealt with before? A prepared row is done. A failed
      // one is retried a few times and then left alone, so a video that simply
      // cannot be transcribed does not cost money every single day.
      // '*' rather than a column list, so that a database which has not yet
      // run the last_error_code migration simply returns a row without it.
      // Naming the column explicitly would make the whole query fail there,
      // and supabase-js RESOLVES a failed query — `prior` would come back null,
      // every row would look brand new, and the sweep would re-download and
      // re-transcribe the entire sheet. Degrading to "one column absent" is a
      // great deal cheaper than degrading to "no memory at all".
      if (existingCopy) result.withCopy++;
      const { data: existing, error: priorError } = await admin
        .from('video_runs')
        .select('*')
        .eq('spreadsheet_id', spreadsheetId).eq('tab', tab.title).eq('row_key', rowKey)
        .maybeSingle();
      if (priorError) {
        // Not knowing whether this row was done before is not a licence to do
        // it again at full price. Skip it and let the next sweep ask again.
        reportError('video-sweep:prior', priorError, { tab: tab.title, row: String(row) });
        result.priorErrors++;
        continue;
      }
      const prior = existing as { id: string; state: string; attempts: number; updated_at?: string; last_error_code?: string | null; draft_id?: string | null } | null;
      if (prior && prior.state === 'prepared') {
        result.doneBefore++;
        // DONE — but is it? A row prepared before the Shared Drive existed
        // has drafts with no video (the copy could not be made then), and
        // the publishing list shows them PENDING. The row is finished as far
        // as COPY goes; the video is still owed. Attach it, the way the
        // PENDING chip would, then move on. Cheap when nothing is pending:
        // one read of the row's posts.
        if (prior.draft_id && parseDriveFileId(videoLink) && attachedThisRun < ATTACH_PER_RUN) {
          if (opts.dryRun) {
            const pending = await pendingVideoPosts(opts.userId, prior.draft_id);
            if (pending.length) result.rows.push({ tab: tab.title, row, rowKey, title: title || videoLink, state: 'skipped', message: 'Prepared earlier; ' + pending.length + ' draft' + (pending.length === 1 ? '' : 's') + ' still waiting for the video — would attach it.' });
          } else {
            const out = await attachPendingVideos({
              userId: opts.userId, draftId: prior.draft_id, videoKey: videoKeyFor(spreadsheetId, tab.title, rowKey),
              videoLink, title: title || videoLink, actor: 'sweep', where,
            });
            if (out.pending) {
              attachedThisRun++;
              result.attached += out.attached;
              result.rows.push({ tab: tab.title, row, rowKey, title: title || videoLink, state: out.attached ? 'attached' : 'failed', message: out.error || ('Video attached to ' + out.attached + ' of ' + out.pending + ' waiting draft' + (out.pending === 1 ? '' : 's') + '.') });
            }
          }
        }
        continue;
      }
      if (prior && prior.state === 'skipped') { result.retired++; continue; }
      // How many passes this row is worth depends on WHY it stopped.
      //
      // This used to be a flat `attempts >= 3`, which retired a row that had
      // merely run out of time exactly as hard as one whose copy named a
      // person — and nothing anywhere could un-retire either. A timeout is
      // fixed by trying again; a refusal is not, and two more transcriptions
      // reach it again at full price. lib/failure-kind.ts holds the split.
      if (prior && !mayRetry(prior.last_error_code ?? null, prior.attempts)) { result.retired++; continue; }
      // Claimed by a sweep that is still running. The hourly cron and the
      // sheet's own edit trigger can fire seconds apart, and transcribing a
      // video takes minutes — without this both would do it, and pay twice.
      // A claim older than the longest a request can live is stale, not held.
      if (prior && prior.state === 'preparing' && !claimIsStale(prior.updated_at)) { result.retired++; continue; }

      if (existingCopy) {
        // QUEUE, DO NOT WRITE. The copy is the person's; it goes out verbatim.
        // The dashboard draft exists so the publishing list, the PENDING chip
        // and Approve treat this row like any other; the video_runs row exists
        // so a run fifteen minutes from now does not queue it again.
        if (existingThisRun >= EXISTING_COPY_PER_RUN) { result.stoppedEarly = true; result.stoppedWhy = 'per_run_cap'; continue; }
        result.candidates++;
        const draftTitle = title || videoLink;
        if (opts.dryRun) {
          result.rows.push({ tab: tab.title, row, rowKey, title: draftTitle, state: 'would_queue_existing', message: 'Copy already written — would be sent to Metricool as a draft with the video, unchanged.' });
          wouldPrepare++;
          existingThisRun++;
          continue;
        }
        let columns: Partial<Record<VideoField, string>>;
        try {
          columns = await columnsFor();
        } catch (e) {
          if (!columnsFailed) { reportError('video-sweep:columns', e, { tab: tab.title }); columnsFailed = true; }
          result.stoppedEarly = true; result.stoppedWhy = 'columns';
          break;
        }
        const queued = await queueExistingCopyRow({
          userId: opts.userId, spreadsheetId, tab: tab.title, row, gid: where.gid,
          rec, rowKey, title, videoLink, copy, columns, prior,
          publicationDate: await slotForNextRow(), actor: 'sweep', skipMetricool: opts.skipMetricool,
        });
        existingThisRun++;
        result.queuedExisting++;
        result.metricoolDrafts += queued.metricool.filter((p) => p.ok).length;
        result.rows.push({ tab: tab.title, row, rowKey, title: draftTitle, state: 'queued_existing', draftId: queued.draftId, metricool: queued.metricool });
        continue;
      }

      result.candidates++;
      if (opts.dryRun) {
        // Check the one thing a dry run can usefully check: whether the video
        // itself can actually be opened. Sharing the SHEET with the service
        // account grants nothing over the files it links to, so this is the
        // permission most likely to be missing — and the first real run is a
        // bad time to discover that. Metadata only: nothing is downloaded,
        // nothing is transcribed, nothing is written.
        const fileId = !youtubeLink ? parseDriveFileId(videoLink) : null;
        let reach: SweepRowOutcome = { tab: tab.title, row, rowKey, title: title || videoLink, state: 'would_prepare' };
        wouldPrepare++;
        if (fileId) {
          // Same ceiling the real run uses — none. A dry run that refused at
          // 450 MB while the real run streams the file would report work as
          // impossible that the sweep goes on to do.
          const probe = await probeDriveMedia(fileId, Number.POSITIVE_INFINITY);
          if (!probe.ok) {
            reach = { ...reach, state: 'failed', message: probe.message };
            result.failed++;
          } else {
            const route = routeFor(probe.sizeBytes);
            if (route === 'too_large') {
              reach = { ...reach, state: 'needs_transcript', message: megabytes(probe.sizeBytes) + ' — too much to read inside one request. A pasted transcript is the way in.' };
              result.needsTranscript++;
            } else {
              reach.message = 'Reachable · ' + megabytes(probe.sizeBytes) +
                (route === 'stream' ? ' · read from Drive rather than staged' : '');
            }
          }
        } else if (youtubeLink) {
          reach.message = 'Published to YouTube — its captions will be used, at no cost.';
        }
        result.rows.push(reach);
        continue;
      }

      // Somewhere to put the answer, before spending anything on producing it.
      let columns: Partial<Record<VideoField, string>>;
      try {
        columns = await columnsFor();
      } catch (e) {
        if (!columnsFailed) { reportError('video-sweep:columns', e, { tab: tab.title }); columnsFailed = true; }
        result.stoppedEarly = true; result.stoppedWhy = 'columns';
        break; // this whole tab is unwritable; the next sweep will retry it
      }

      const attempts = (prior?.attempts ?? 0) + 1;
      await admin.from('video_runs').upsert({
        ...(prior ? { id: prior.id } : {}),
        user_id: opts.userId,
        spreadsheet_id: spreadsheetId,
        tab: tab.title,
        row_key: rowKey,
        row_number: row,
        video_title: title || null,
        video_link: videoLink || null,
        state: 'preparing',
        attempts,
      }, { onConflict: 'spreadsheet_id,tab,row_key' });

      let outcome: SweepRowOutcome;
      try {
        const runPass = () => prepareVideo({
          userId: opts.userId,
          url: videoLink,
          youtubeUrl: youtubeLink || null,
          title: title || null,
          // Not for the copy — nobody is named in it. It is one more name the guard
          // refuses, and the videographer's is the one most easily mistaken for
          // somebody in the video.
          creator: pick(rec, 'creator', 'by') || null,
          // Whatever is left of the sweep's own window, not a fixed slice of
          // it. A fixed 32s made every long video in the backlog stop with
          // "transcript ready" forever, because no single row was ever given
          // enough of the clock to reach the copy — and the sweep runs once a
          // day, so forever was the literal outcome.
          //
          // The floor leaves room to write back and record the outcome even
          // when the sweep is nearly out of time; below it the loop above has
          // already stopped starting rows.
          budgetMs: Math.max(20_000, budgetMs - (Date.now() - started)),
        });

        let prepared = await runPass();

        // Banked the transcript and stopped? Finish it now, not tomorrow.
        //
        // The browser does exactly this (lib/prepare-request.ts asks a second
        // time on 202), and the sweep did not — it filed the row back into the
        // queue and moved on. That was survivable while a hand-off was rare;
        // now that the writer hands off rather than hurrying, it would mean the
        // biggest videos take two days, and the cron runs ONCE daily.
        //
        // The second pass is cheap: the transcript comes back from cache in
        // about a second and only the writing is left. Once, never twice — a
        // second 202 means something other than the clock is wrong, and the
        // existing branch below files it properly instead of looping.
        if (!prepared.ok && prepared.error === 'transcript_ready'
            && canWriteCopy(budgetMs - (Date.now() - started))) {
          prepared = await runPass();
        }

        // Out of time, with the transcript stored. That is half the job done,
        // not a failure — so the row keeps its place in the queue and the next
        // pass finishes it in seconds instead of starting the download again.
        // Filing it as an error would put "Error — revisar" in front of a
        // person for a row that needs nothing from them.
        if (!prepared.ok && prepared.error === 'transcript_ready') {
          await writeStatus(spreadsheetId, tab.title, row, columns, STATUS_TEXT.transcript_ready);
          await updateRun(admin, { spreadsheetId, tab: tab.title, rowKey }, {
            state: 'discovered',
            transcript_source: 'drive',
            last_error: null,
            last_error_code: null,
            // Give back the attempt this pass consumed.
            //
            // attempts was incremented when the row was claimed, and three of them
            // retires a row for good (see the guard above). A pass that banked the
            // transcript and stopped on the clock made PROGRESS — counting it against a
            // budget meant for videos that genuinely cannot be read would have the
            // backlog quietly retiring itself after three good passes, with no error
            // recorded anywhere to say why.
            attempts: Math.max(0, (prior?.attempts ?? 1) - 1),
            updated_at: new Date().toISOString(),
          });
          outcome = { tab: tab.title, row, rowKey, title: title || videoLink, state: 'transcript_ready', message: prepared.message };
          result.rows.push(outcome);
          continue;
        }

        if (!prepared.ok) {
          const state = prepared.needsPaste ? 'needs_transcript' : 'failed';
          await writeStatus(spreadsheetId, tab.title, row, columns, STATUS_TEXT[state]);
          // The CODE as well as the sentence. `last_error` is written for a
          // person and says nothing a machine can act on, so the decision
          // about whether to try this row again had nothing to read.
          await updateRun(admin, { spreadsheetId, tab: tab.title, rowKey }, {
            state,
            last_error: prepared.message,
            last_error_code: prepared.error,
            updated_at: new Date().toISOString(),
          });
          if (state === 'needs_transcript') result.needsTranscript++; else result.failed++;
          // THE REGISTER. video_runs keeps only the LATEST error and nulls it on
          // the next retry, so without this the third failure erases the first
          // two and a row that has never once worked looks like a row that
          // failed today.
          void recordVideoEvent({
            userId: opts.userId,
            videoKey: videoKeyFor(spreadsheetId, tab.title, rowKey),
            event: 'failed',
            actor: 'sweep',
            title: title || videoLink,
            link: videoLink,
            detail: { ...where, state, reason: prepared.error, error: prepared.message },
          });
          outcome = { tab: tab.title, row, rowKey, title: title || videoLink, state, message: prepared.message };
          result.rows.push(outcome);
          continue;
        }

        // Write back — but only into cells that are still empty. Re-read them
        // first: the sheet was read at the top of this tab, and preparing a
        // video takes long enough for somebody to have typed in the row since.
        const wrote = await writeRowBack(spreadsheetId, tab.title, row, {
          ...columns,
          ...(copyCol ? { copy: copyCol } : {}),
        }, {
          copy: prepared.tiktok,
          keywords: prepared.keywordLine,
          ref: prepared.ref,
          aiStatus: STATUS_TEXT.prepared, // replaced below once the hand-off is known
        });

        // Then the post itself: a DRAFT in Metricool, waiting for approval.
        // Failures here are recorded and do not undo the row — the copy is
        // already in the sheet and the draft is in the dashboard, so a
        // Metricool outage costs the hand-off, not the work.
        const posted = opts.skipMetricool
          ? []
          : await handOffToMetricool({
              userId: opts.userId,
              prepared,
              networks: rowNetworks,
              videoLink,
              title: prepared.title,
              format: pick(rec, 'formato', 'format'),
              sheetYoutube: pick(rec, 'youtube'),
              published: publishedNetworks(VIDEO_NETWORK_COLUMNS, (col: string) => pick(rec, col)),
              // The row's one slot, shared by all its networks. Undefined when
              // the calendar could not be read, and the hand-off then reports
              // that per network exactly as it always has.
              publicationDate: await slotForNextRow(),
            });

        // ESTADO IA last, once both the keyword coverage and the hand-off are
        // known: a row that got no keyword data, or whose copy was too long to
        // send, must not read the same as one that got everything.
        const status = preparedStatus({
          hasKeywords: prepared.hasKeywords,
          overLength: posted.some((p) => p.reason === 'too_long'),
        });
        if (status !== STATUS_TEXT.prepared) {
          await writeStatus(spreadsheetId, tab.title, row, columns, status);
        }

        await updateRun(admin, { spreadsheetId, tab: tab.title, rowKey }, {
          state: 'prepared',
          row_number: row,
          transcript_source: prepared.transcript.source,
          transcript_chars: prepared.transcript.chars,
          keywords: prepared.keywordLine,
          ref: prepared.ref,
          draft_id: prepared.draftId,
          wrote,
          metricool: posted,
          last_error: null,
          last_error_code: null,
          updated_at: new Date().toISOString(),
        });

        result.prepared++;
        result.metricoolDrafts += posted.filter((p) => p.ok).length;
        {
          const key = videoKeyFor(spreadsheetId, tab.title, rowKey);
          void recordVideoEvent({
            userId: opts.userId,
            videoKey: key,
            event: 'prepared',
            actor: 'sweep',
            title: prepared.title,
            link: videoLink,
            detail: { ...where, transcriptSource: prepared.transcript.source, hasKeywords: prepared.hasKeywords, wrote, titleSource: prepared.titleSource ?? null, titleSkipped: prepared.titleSkipped ?? null },
          });
          const sent = posted.filter((p) => p.ok).map((p) => p.network);
          const refused = posted.filter((p) => !p.ok);
          if (sent.length || refused.length) {
            void recordVideoEvent({
              userId: opts.userId,
              videoKey: key,
              event: 'queued',
              actor: 'sweep',
              title: prepared.title,
              link: videoLink,
              detail: { ...where, networks: sent, refused: refused.map((p) => ({ network: p.network, reason: p.reason, message: p.message })) },
            });
          }
        }
        outcome = { tab: tab.title, row, rowKey, title: prepared.title, state: 'prepared', wrote, draftId: prepared.draftId, metricool: posted };
        result.rows.push(outcome);
      } catch (e) {
        reportError('video-sweep:row', e, { tab: tab.title, row: String(row) });
        const message = e instanceof Error ? e.message : 'Unknown failure';
        // A thrown exception is not one of prepareVideo's named refusals — it
        // is Google, Supabase or the network having a bad moment, which is the
        // definition of worth trying again.
        await updateRun(admin, { spreadsheetId, tab: tab.title, rowKey }, {
          state: 'failed',
          last_error: message,
          last_error_code: 'unreachable',
          updated_at: new Date().toISOString(),
        });
        result.failed++;
        void recordVideoEvent({
          userId: opts.userId,
          videoKey: videoKeyFor(spreadsheetId, tab.title, rowKey),
          event: 'failed',
          actor: 'sweep',
          title: title || videoLink,
          link: videoLink,
          detail: { ...where, state: 'failed', reason: 'unreachable', error: message },
        });
        result.rows.push({ tab: tab.title, row, rowKey, title: title || videoLink, state: 'failed', message });
      }
    }
  }

  // One statement, after the work. Never awaited for its result beyond a count,
  // never able to fail the sweep: recordFirstSeen does not throw, and returns 0
  // when the register's table has not been created yet.
  result.newlySeen = await recordFirstSeen(opts.userId, seenRows, 'sweep');

  return result;
}

/**
 * Finish ONE row the same way the sweep finishes one.
 *
 * The "Prepare" button in the Video Library produced copy and then stopped:
 * nothing reached column E and nothing reached Metricool, so pressing it left
 * the row looking untouched while the automatic path on the identical video
 * would have completed it. Two behaviours for one operation.
 *
 * The rules live in the helpers this calls — never overwrite what a person
 * wrote, one post per slot, drafts only — so the button and the sweep cannot
 * disagree about them.
 */
/**
 * The sheet row a pasted link came from.
 *
 * Prepare writes column E only when it is given a tab and a row — which is
 * true of the button on a row, and false of the box at the top of the page.
 * So pasting a link produced perfect copy and put it nowhere, which is the
 * one step of this whole job that was being automated.
 *
 * The link is matched by Drive FILE ID rather than by string: the same file
 * appears as /file/d/<id>/view, /open?id=<id> and /uc?export=download&id=<id>,
 * and the sheet does not always hold the form that was pasted.
 *
 * Returns null when the link is not in the sheet at all — a video being
 * prepared ad hoc is a legitimate thing to do, and it simply has nowhere to
 * be written back to.
 */
export async function findRowByLink(
  link: string,
  spreadsheetId = SOURCE_IDS.videosSheet(),
): Promise<{ tab: string; row: number } | null> {
  const wanted = parseDriveFileId(link);
  if (!wanted) return null;
  const tabs = await listTabs(spreadsheetId);
  for (const t of tabs) {
    let rows: string[][];
    try {
      rows = await readTab(spreadsheetId, t.title);
    } catch {
      continue; // a tab that cannot be read is not the answer; the others might be
    }
    const { header, records } = tableFromRows(rows, ['copy', 'link video', 'título del video', 'titulo del video']);
    if (!header.length) continue;
    for (const { rec, row } of records) {
      const found = firstLinkIn(pick(rec, 'link video', 'video', 'link'));
      if (found && parseDriveFileId(found) === wanted) return { tab: t.title, row };
    }
  }
  return null;
}

/**
 * Make sure a tab has the KEYWORDS / REF / ESTADO IA columns, once, on its own.
 *
 * ensureAiColumns reads the sheet's width, works out which columns are missing and
 * appends them — four round-trips with no lock. Two rows of the same tab prepared at the
 * same time both read the old width, both decide all three are missing, and both append:
 * the tab ends up with TWO sets of those headers, and from then on half the rows write
 * their keywords into one set and half into the other. A person has to unpick that by
 * hand.
 *
 * So a batch calls this once per tab, serially, and only fans out afterwards. That
 * removes the race rather than trying to make it safe — by the time rows run in parallel
 * there is nothing left for them to append.
 */
export async function ensureTabColumns(tab: string, spreadsheetId = SOURCE_IDS.videosSheet()): Promise<void> {
  const rows = await readTab(spreadsheetId, tab);
  const { header, headerRow } = tableFromRows(rows, ['tipo de video', 'título del video', 'titulo del video', 'copy', 'link video', 'formato', 'title', 'video']);
  if (!header.length) return; // not a video table; the row write will say so properly
  const usedWidth = rows.reduce((w, r) => Math.max(w, (r || []).length), 0);
  await ensureAiColumns(spreadsheetId, tab, headerRow, header, usedWidth);
}

type QueueRowArgs = {
  userId: string;
  spreadsheetId: string;
  tab: string;
  row: number;
  gid: number | null;
  rec: Record<string, string>;
  rowKey: string;
  title: string;
  videoLink: string;
  copy: string;
  columns: Partial<Record<VideoField, string>>;
  prior: { id: string; attempts: number } | null;
  publicationDate?: string;
  actor: VideoActor;
  skipMetricool?: boolean;
};

/**
 * QUEUE A ROW WHOSE COPY IS ALREADY WRITTEN — do not write.
 *
 * The copy is the person's and goes out verbatim. The dashboard draft exists
 * so the publishing list, the PENDING chip and Approve treat this row like
 * any other; the video_runs row exists so a sweep fifteen minutes from now
 * does not queue it again; ESTADO IA says what happened; the register keeps
 * the row. One place for it, so the nightly sweep and the "Attach videos"
 * button cannot drift apart.
 */
async function queueExistingCopyRow(a: QueueRowArgs): Promise<{ draftId: string | null; metricool: PublishOutcome[] }> {
  const admin = supabaseAdmin();
  const draftTitle = a.title || a.videoLink;
  const text = existingCopyText(a.copy);
  const fileId = parseDriveFileId(a.videoLink);
  const rowNetworks = VIDEO_NETWORKS.filter(([col]) => YES_TICK.test(pick(a.rec, col))).map(([, n]) => n);

  let draftId: string | null = null;
  try {
    draftId = await saveVideoDraft(a.userId, draftTitle, {
      instagram: text, facebook: text, linkedin: text, blog: '',
      kind: 'video', title: draftTitle, sourceUrl: a.videoLink, videoId: fileId || a.videoLink,
      transcript: '', transcriptSource: 'sheet', transcriptLanguage: null, tiktok: text,
      // So a replace on approve still knows Short-or-video and the privacy cell.
      format: pick(a.rec, 'formato', 'format') || null,
      sheetYoutube: pick(a.rec, 'youtube') || null,
    });
  } catch (e) {
    reportError('video-queue:draft', e, { tab: a.tab, row: String(a.row) });
  }
  const posted = a.skipMetricool ? [] : await handOffToMetricool({
    userId: a.userId,
    prepared: { linkedin: text, tiktok: text, draftId },
    networks: rowNetworks,
    videoLink: a.videoLink,
    title: draftTitle,
    rowLabel: a.tab + ' \u00b7 row ' + a.row,
    format: pick(a.rec, 'formato', 'format'),
    sheetYoutube: pick(a.rec, 'youtube'),
    published: publishedNetworks(VIDEO_NETWORK_COLUMNS, (col: string) => pick(a.rec, col)),
    publicationDate: a.publicationDate,
  });
  // ESTADO IA only. COPY is not even named here, and writeRowBack never
  // fills a cell that has something in it.
  try {
    await writeRowBack(a.spreadsheetId, a.tab, a.row, a.columns, { aiStatus: STATUS_TEXT.queued_existing });
  } catch (e) {
    reportError('video-queue:status', e, { tab: a.tab, row: String(a.row) });
  }
  const { error: runError } = await admin.from('video_runs').upsert({
    ...(a.prior ? { id: a.prior.id } : {}),
    user_id: a.userId,
    spreadsheet_id: a.spreadsheetId,
    tab: a.tab,
    row_key: a.rowKey,
    row_number: a.row,
    video_title: a.title || null,
    video_link: a.videoLink || null,
    state: 'prepared',
    attempts: (a.prior?.attempts ?? 0) + 1,
    transcript_source: 'sheet',
    draft_id: draftId,
    metricool: posted,
    last_error: null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'spreadsheet_id,tab,row_key' });
  if (runError) reportError('video-queue:run', runError, { tab: a.tab, row: String(a.row) });
  const sent = posted.filter((p) => p.ok).map((p) => p.network);
  const refused = posted.filter((p) => !p.ok);
  void recordVideoEvent({
    userId: a.userId,
    videoKey: videoKeyFor(a.spreadsheetId, a.tab, a.rowKey),
    event: 'queued',
    actor: a.actor,
    title: draftTitle,
    link: a.videoLink,
    detail: { tab: a.tab, row: a.row, gid: a.gid, existingCopy: true, networks: sent, refused: refused.map((p) => ({ network: p.network, reason: p.reason, message: p.message })) },
  });
  return { draftId, metricool: posted };
}

export type QueueExistingResult =
  | { ok: true; title: string; draftId: string | null; metricool: PublishOutcome[] }
  | { ok: false; reason: 'no_table' | 'not_found' | 'hidden' | 'no_video' | 'no_copy' | 'already_queued' | 'already_published'; message: string };

/**
 * Queue ONE named row whose copy is already written, with its video — the
 * "Attach videos" button's path for a row that has no draft yet. Reads the
 * row itself, applies the same rules as the sweep (hidden rows are left
 * alone, no video or no copy is a refusal, not a guess), and hands the rest
 * to queueExistingCopyRow.
 */
export async function queueExistingCopy(opts: {
  userId: string;
  tab: string;
  row: number;
  publicationDate?: string;
  actor?: VideoActor;
  spreadsheetId?: string;
  skipMetricool?: boolean;
}): Promise<QueueExistingResult> {
  const spreadsheetId = opts.spreadsheetId || SOURCE_IDS.videosSheet();
  const { rows, hidden } = await readTabWithMeta(spreadsheetId, opts.tab);
  const { header, headerRow, records } = tableFromRows(rows, ['tipo de video', 'título del video', 'titulo del video', 'copy', 'link video', 'formato', 'title', 'video']);
  if (!header.length) return { ok: false, reason: 'no_table', message: 'That tab has no video table.' };
  const found = records.find((r) => r.row === opts.row);
  if (!found) return { ok: false, reason: 'not_found', message: 'Row ' + opts.row + ' is not a data row on ' + opts.tab + '.' };
  if (hidden.has(opts.row)) return { ok: false, reason: 'hidden', message: 'Row ' + opts.row + ' is hidden in the sheet, so it is left alone.' };

  const title = pick(found.rec, 'título del video', 'titulo del video', 'title');
  const videoLink = firstLinkIn(pick(found.rec, 'link video', 'link', 'video link'));
  const copy = pick(found.rec, 'copy', 'caption');
  if (!String(copy || '').trim()) return { ok: false, reason: 'no_copy', message: 'Row ' + opts.row + ' has no copy yet — Prepare writes it and queues the video.' };
  if (!isExistingCopyRow({ videoLink, copy })) return { ok: false, reason: 'no_video', message: 'Row ' + opts.row + ' has no Drive or YouTube video to attach.' };

  const usedWidth = rows.reduce((w, r) => Math.max(w, (r || []).length), 0);
  const columns = await ensureAiColumns(spreadsheetId, opts.tab, headerRow, header, usedWidth);
  const rowKey = rowKeyFor(title, videoLink);
  const { data: existing } = await supabaseAdmin()
    .from('video_runs')
    .select('id, attempts, state')
    .eq('spreadsheet_id', spreadsheetId).eq('tab', opts.tab).eq('row_key', rowKey)
    .maybeSingle()
    .then((x) => x, () => ({ data: null }));
  const prior = (existing as { id: string; attempts: number; state?: string } | null) || null;
  const gid = await tabGid(spreadsheetId, opts.tab);

  // A row the sweep (or an earlier press) already queued is not queued again
  // while its drafts wait: this path used to read the run for its id only,
  // never its state, and re-queued the row — the second of row 179's four
  // sets of drafts. Only when the queue holds nothing for the video any more
  // (drafts deleted, or published) is the row eligible again.
  if (prior && prior.state === 'prepared' && !opts.skipMetricool) {
    const fileId = parseDriveFileId(videoLink);
    const known = fileId ? await cachedPublicCopy(fileId) : null;
    const forVideo = await awaitingPostsForVideo(opts.userId, { fileId, copyId: known?.id });

    // ALREADY OUT. A row whose posts were approved and published is finished,
    // and nothing here may queue it again: approving emptied the queue, so the
    // waiting check below saw nothing and the row looked free — one press of
    // Attach videos over a range would publish the same reel twice.
    const published = forVideo.filter((p) => hasGoneOut(p.status));
    if (published.length) {
      const nets = Array.from(new Set(published.map((p) => String((Array.isArray(p.providers) ? p.providers[0] : '') || '')).filter(Boolean)));
      const message = 'Row ' + opts.row + ' has already been published (' + (nets.join(', ') || String(published.length) + ' post' + (published.length === 1 ? '' : 's')) + '), so it was left alone. Queuing it again would post the same video twice.';
      void recordVideoEvent({
        userId: opts.userId, videoKey: videoKeyFor(spreadsheetId, opts.tab, rowKey), event: 'skipped', actor: opts.actor ?? 'button',
        title: title || videoLink, link: videoLink, detail: { tab: opts.tab, row: opts.row, gid, reason: 'already_published', error: message },
      });
      return { ok: false, reason: 'already_published', message };
    }

    const waiting = forVideo.filter((p) => isAwaitingApproval(p.status));
    if (waiting.length) {
      const nets = Array.from(new Set(waiting.map((p) => String((Array.isArray(p.providers) ? p.providers[0] : '') || '')).filter(Boolean)));
      const message = 'Row ' + opts.row + ' already has ' + waiting.length + ' draft' + (waiting.length === 1 ? '' : 's') + ' waiting for your approval (' + nets.join(', ') + ') \u2014 approve them in the queue, or delete them there first.';
      void recordVideoEvent({
        userId: opts.userId, videoKey: videoKeyFor(spreadsheetId, opts.tab, rowKey), event: 'skipped', actor: opts.actor ?? 'button',
        title: title || videoLink, link: videoLink, detail: { tab: opts.tab, row: opts.row, gid, reason: 'already_queued', error: message },
      });
      return { ok: false, reason: 'already_queued', message };
    }
  }

  const out = await queueExistingCopyRow({
    userId: opts.userId, spreadsheetId, tab: opts.tab, row: opts.row, gid,
    rec: found.rec, rowKey, title, videoLink, copy, columns, prior,
    publicationDate: opts.publicationDate, actor: opts.actor ?? 'button', skipMetricool: opts.skipMetricool,
  });
  return { ok: true, title: title || videoLink, ...out };
}

export async function completeRow(opts: {
  userId: string;
  tab: string;
  row: number;
  prepared: PrepareOk;
  videoLink: string;
  skipMetricool?: boolean;
  spreadsheetId?: string;
  /**
   * The instant this row's drafts were already given, when a batch reserved them.
   *
   * Without it every row in a batch reads the calendar before any of them has written to
   * it, so they all choose the same morning and stack. One reading, taken up front, and
   * each row arrives holding the slot it owns.
   */
  publicationDate?: string;
  /**
   * Which mechanism is doing this, for the register.
   *
   * Optional and defaulted, so every existing caller keeps compiling — but a
   * caller that leaves it out records 'unknown', which is the honest answer and
   * not a guess. video_runs.user_id cannot carry this: it is the tenant, and on
   * this single-clinic deployment every path writes the same id.
   */
  actor?: VideoActor;
}): Promise<{ wrote: Partial<Record<VideoField, boolean>>; metricool: PublishOutcome[]; status: string }> {
  const spreadsheetId = opts.spreadsheetId || SOURCE_IDS.videosSheet();
  const { rows, hidden } = await readTabWithMeta(spreadsheetId, opts.tab);
  const { header, headerRow, records } = tableFromRows(rows, ['tipo de video', 'título del video', 'titulo del video', 'copy', 'link video', 'formato', 'title', 'video']);
  if (!header.length) throw new Error('That tab has no video table.');

  const found = records.find((r) => r.row === opts.row);
  if (!found) throw new Error('Row ' + opts.row + ' is not a data row on ' + opts.tab + '.');
  // The same rule the sweep and the library apply, for the one door that can
  // still name a row directly (the assistant, an old link): hidden is untouched.
  if (hidden.has(opts.row)) throw new Error('Row ' + opts.row + ' is hidden in the sheet, so it is left alone. Unhide it first if it should be prepared.');

  const usedWidth = rows.reduce((w, r) => Math.max(w, (r || []).length), 0);
  const columns = await ensureAiColumns(spreadsheetId, opts.tab, headerRow, header, usedWidth);
  const copyCol = columnFor(header, 'copy', 'caption');
  const rowNetworks = VIDEO_NETWORKS.filter(([col]) => YES_TICK.test(pick(found.rec, col))).map(([, n]) => n);

  const wrote = await writeRowBack(spreadsheetId, opts.tab, opts.row, {
    ...columns,
    ...(copyCol ? { copy: copyCol } : {}),
  }, {
    copy: opts.prepared.tiktok,
    keywords: opts.prepared.keywordLine,
    ref: opts.prepared.ref,
    aiStatus: STATUS_TEXT.prepared,
  });

  // The sheet's FORMATO / YOUTUBE cells travel with the draft, so the replace
  // on approve says Short-or-video the same way the first hand-off did.
  await stampDraftVideoMeta(opts.prepared.draftId, {
    format: pick(found.rec, 'formato', 'format'),
    sheetYoutube: pick(found.rec, 'youtube'),
    title: opts.prepared.title,
  });
  const metricool = opts.skipMetricool ? [] : await handOffToMetricool({
    userId: opts.userId,
    prepared: opts.prepared,
    networks: rowNetworks,
    videoLink: opts.videoLink,
    title: opts.prepared.title,
    format: pick(found.rec, 'formato', 'format'),
    sheetYoutube: pick(found.rec, 'youtube'),
    published: publishedNetworks(VIDEO_NETWORK_COLUMNS, (col: string) => pick(found.rec, col)),
    publicationDate: opts.publicationDate,
  });

  const status = preparedStatus({
    hasKeywords: opts.prepared.hasKeywords,
    overLength: metricool.some((m) => m.reason === 'too_long'),
  });
  if (status !== STATUS_TEXT.prepared) {
    await writeStatus(spreadsheetId, opts.tab, opts.row, columns, status);
  }

  // Record it, so the sweep sees this row as done rather than doing it again.
  const rowKey = rowKeyFor(pick(found.rec, 'título del video', 'titulo del video', 'title'), opts.videoLink);
  try {
    await supabaseAdmin().from('video_runs').upsert({
      user_id: opts.userId,
      spreadsheet_id: spreadsheetId,
      tab: opts.tab,
      row_key: rowKey,
      row_number: opts.row,
      video_title: opts.prepared.title || null,
      video_link: opts.videoLink || null,
      state: 'prepared',
      transcript_source: opts.prepared.transcript.source,
      transcript_chars: opts.prepared.transcript.chars,
      keywords: opts.prepared.keywordLine,
      ref: opts.prepared.ref,
      draft_id: opts.prepared.draftId,
      wrote,
      metricool,
      // The row succeeded, so the last failure is no longer true of it. The
      // sweep clears this on its own success path; a retry driven from the
      // assistant comes through here and nowhere else, and would otherwise
      // leave a finished row still carrying the error that stopped it.
      //
      // last_error_code is deliberately NOT cleared here: naming a column a
      // database has not migrated yet would refuse this whole upsert, and
      // losing `state: 'prepared'` means re-downloading the video for ever.
      // A stale code on a row that reads 'prepared' is consulted by nothing.
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'spreadsheet_id,tab,row_key' });
  } catch (e) {
    reportError('video-complete:run', e);
  }

  // THE REGISTER. Two separate facts, because they fail separately: the copy was
  // written, and (sometimes) drafts reached Metricool. Neither is awaited for
  // anything — recordVideoEvent does not throw, and the row above is already
  // saved either way.
  const registerKey = videoKeyFor(spreadsheetId, opts.tab, rowKey);
  // The gid is a cached metadata read (an hour's TTL) and null on any failure:
  // the register line then opens the document instead of the row, which is
  // the same degradation the publishing list's button has.
  const where = { tab: opts.tab, row: opts.row, gid: await tabGid(spreadsheetId, opts.tab) };
  void recordVideoEvent({
    userId: opts.userId,
    videoKey: registerKey,
    event: 'prepared',
    actor: opts.actor ?? 'unknown',
    title: opts.prepared.title,
    link: opts.videoLink,
    detail: {
      ...where,
      transcriptSource: opts.prepared.transcript.source,
      titleSource: opts.prepared.titleSource ?? null,
      titleSkipped: opts.prepared.titleSkipped ?? null,
      hasKeywords: opts.prepared.hasKeywords,
      // What reached the sheet, and what was left alone because a person had
      // already written there — the distinction `wrote` exists to record.
      wrote,
      status,
    },
  });
  const sent = metricool.filter((m) => m.ok).map((m) => m.network);
  const refused = metricool.filter((m) => !m.ok);
  if (sent.length || refused.length) {
    void recordVideoEvent({
      userId: opts.userId,
      videoKey: registerKey,
      event: 'queued',
      actor: opts.actor ?? 'unknown',
      title: opts.prepared.title,
      link: opts.videoLink,
      // A compliance refusal reads very differently from an outage, and both
      // need to still be visible next week.
      detail: { ...where, networks: sent, refused: refused.map((m) => ({ network: m.network, reason: m.reason, message: m.message })) },
    });
  }

  return { wrote, metricool, status };
}

/** The sheet's own network columns, and what a tick in one means. */
const VIDEO_NETWORKS: [string, string][] = [
  ['linkedin', 'linkedin'], ['tiktok', 'tiktok'], ['x', 'twitter'],
  ['facebook', 'facebook'], ['instagram', 'instagram'],
];
/** A ticked box. Never FALSE — Google writes that into every untouched checkbox. */
const YES_TICK = /^(x|✓|✔|yes|si|sí|true|posted|done)$/i;

/**
 * Hand the finished copy to Metricool as drafts awaiting approval.
 *
 * LinkedIn and X take the long, insight-led post; the short caption with the
 * hashtags, REF and AVISO is what TikTok, Instagram and Facebook get — the
 * same split the Video Library's two boxes have always had.
 *
 * A network that needs a video only gets a draft when there is a URL Metricool
 * can actually fetch, which means copying the reel into the app's own Drive
 * folder and opening that copy. The copy is made once per video, not once per
 * network.
 */
export async function handOffToMetricool(args: {
  userId: string;
  prepared: {
    linkedin: string;
    tiktok: string;
    draftId: string | null;
    /** The drafted public title (lib/video-prepare.ts). Absent for a row whose copy a person wrote. */
    title?: string | null;
  };
  networks: string[];
  videoLink: string;
  /** The sheet's "título del video" cell: the fallback when nothing was drafted. */
  title: string;
  /** The sheet's FORMATO cell, so a landscape video is kept off a vertical feed. */
  format?: string | null;
  /** The sheet's YOUTUBE cell. Sometimes a link, sometimes the word "Unlisted". */
  sheetYoutube?: string | null;
  /** Networks this row is already live on, so the default cannot re-post them. */
  published?: readonly string[];
  /** A slot already reserved for this row by a batch; overrides the local search. */
  publicationDate?: string;
  /** "2026 CELLULAR HOPE · row 179", for the sentence a skipped network gets. */
  rowLabel?: string | null;
}): Promise<PublishOutcome[]> {
  const { userId, prepared, networks, videoLink, title: sheetTitle, format, sheetYoutube, published = [] } = args;
  // The drafted title when there is one, else the sheet cell. Two of the three
  // callers already pass the drafted title as `title` too, so for them this is
  // a no-op; it makes the rule hold for any caller rather than for the ones
  // that happened to remember.
  const title = String(prepared.title || '').trim() || sheetTitle;

  // Make the copy whenever any network is going out and there is a file.
  //
  // This used to ask whether some network REQUIRED a video, which quietly meant
  // "not for LinkedIn" — so a LinkedIn post went out as text ending in a Drive
  // link that is not public and most readers cannot open. Every network that
  // can carry the video now does.
  const fileId = parseDriveFileId(videoLink);
  const wantsVideo = networksFor(networks, true, format, published).length > 0;
  let mediaUrl: string | null = null;
  let mediaFileId: string | null = null;
  if (wantsVideo && fileId) {
    // Made once per video, not once per run, and VERIFIED before it is recorded
    // — lib/media-library.ts streams the file into the app's bucket and reads
    // its first bytes back the way Metricool will. This used to be an inline
    // Drive copy handing over a download link that Google answered with a web
    // page for any reel over ~100 MB.
    const made = await ensureShareableVideo(videoLink, title, { userId, actor: 'sweep' });
    if (made.ok) {
      mediaFileId = made.fileId;
      mediaUrl = made.url;
    } else {
      // Not fatal here: the networks that need a video are dropped below, and
      // the text-only ones still get their drafts. The register carries why.
      reportError('video-sweep:media-copy', new Error(made.message), { fileId });
    }
  }

  const wanted = networksFor(networks, Boolean(mediaUrl), format, published);
  if (!wanted.length) return [];

  // ONE DRAFT PER VIDEO AND NETWORK while it waits for approval. Four paths
  // reach this hand-off — the sweep's two branches, Prepare, Attach videos —
  // and none of them used to ask whether the video already had a draft
  // waiting on that network; row 179 ended up in Metricool eleven times.
  // A network that already has one is answered, not sent.
  const already = await awaitingPostsForVideo(userId, { fileId, copyId: mediaFileId });
  // Published first: a network this video already went out on is finished, and
  // approving had emptied the waiting list, so the row looked free again.
  const gone = networksAlreadyPublished(already, wanted);
  const split = networksAlreadyQueued(already, gone.free);
  const out: PublishOutcome[] = [
    ...gone.published.map((network) => ({
      network, ok: false as const, reason: 'already_published' as const,
      message: (args.rowLabel ? args.rowLabel + ' has' : 'This video has') + ' already been published on ' + network + ', so nothing was sent \u2014 posting it again would publish the same video twice.',
    })),
    ...split.queued.map((network) => ({
      network, ok: false as const, reason: 'already_queued' as const, message: alreadyQueuedMessage(network, args.rowLabel),
    })),
  ];
  const chosen = split.free;
  if (!chosen.length) return out;

  const now = new Date();
  // takenSlots throws rather than returning an empty list it cannot vouch for:
  // "nothing is scheduled" and "I could not find out" choose very different
  // slots, and treating them alike stacks every post on one instant. Caught
  // here so it costs the HAND-OFF and not the row — by this point the copy is
  // already in the sheet and the draft already in the dashboard.
  // A reserved slot is already distinct from every other row's in the batch, so the
  // calendar does not need reading again — and reading it here, once per row, is exactly
  // what made concurrent rows all agree on the same morning.
  //
  // Every network of a reserved row shares that one instant. Allocating a separate slot
  // per network was an artifact of choosing them one at a time; the same video reaching
  // LinkedIn and TikTok together is what a person would do by hand anyway, and it keeps
  // the reservation honest — one row, one slot.
  let taken = new Set<string>();
  if (!args.publicationDate) try {
    taken = new Set(await takenSlots(userId, now.toISOString()));
  } catch (e) {
    reportError('video-sweep:slots', e);
    const message = e instanceof Error ? e.message : 'The posting calendar could not be read.';
    return [...out, ...chosen.map((network) => ({ network, ok: false as const, reason: 'metricool_error' as const, message }))];
  }
  const reserved = args.publicationDate ? new Date(args.publicationDate) : null;
  for (const network of chosen) {
    const slot = reserved && Number.isFinite(reserved.getTime()) ? reserved : nextFreeSlot(taken, now);
    if (!slot) {
      out.push({ network, ok: false, reason: 'metricool_error', message: 'No free posting slot inside the scheduling horizon.' });
      continue;
    }
    // Claim the slot locally too, so two networks in the same run do not both
    // take it — takenSlots was read once, before any of this was written.
    taken.add(slot.toISOString());
    const text = network === 'linkedin' || network === 'twitter' ? prepared.linkedin : prepared.tiktok;

    // Too long for this network? Say so instead of sending it. Metricool would
    // reject it anyway, and trimming to fit would cut the REF and AVISO lines,
    // which sit at the end — a silently non-compliant post is worse than one a
    // person is asked to shorten.
    const fit = fitsNetwork(network, text);
    if (!fit.ok) {
      out.push({
        network,
        ok: false,
        reason: 'too_long',
        message: 'The copy is ' + fit.length + ' characters; ' + network + ' accepts ' + fit.limit + '. Shorten it and send from the Video Library.',
      });
      continue;
    }

    out.push(await publishVideoDraft({
      userId,
      network,
      text,
      publicationDate: slot.toISOString(),
      // Every network, not only the ones that cannot post without it. Whether a
      // network REQUIRES a video and whether it should CARRY one are different
      // questions, and NEEDS_VIDEO was being asked both.
      mediaUrl,
      // Recorded per post, because ONE copy backs every network of a run: deleting the
      // file when the first of them is deleted would break the rest.
      mediaFileId,
      draftId: prepared.draftId,
      // YouTube's own fields. Everywhere else these are meaningless; there, a
      // draft without them cannot be saved at all.
      title,
      format,
      sheetYoutube,
      // The pack, so publishVideoDraft can run the "written from a video" rule.
      // Every post the sweep creates IS written from a video, so this is what
      // makes the rule real on this path rather than a fact nobody checks.
      pack: { kind: 'video', sourceUrl: args.videoLink || '' },
    }));
  }
  return out;
}

/**
 * Write values into a row, skipping every cell that already has something in
 * it. Returns which fields were actually written.
 *
 * The re-read is the whole point: this is a document three people edit at the
 * same time, and the gap between deciding to write and writing is measured in
 * minutes here, not milliseconds.
 */
export async function writeRowBack(
  spreadsheetId: string,
  tab: string,
  row: number,
  columns: Partial<Record<VideoField, string>>,
  values: Partial<Record<VideoField, string>>,
): Promise<Partial<Record<VideoField, boolean>>> {
  const fields = (Object.keys(values) as VideoField[]).filter((f) => columns[f] && String(values[f] || '').trim());
  if (!fields.length) return {};
  const letters = fields.map((f) => columns[f] as string);
  const current = await readRowCells(spreadsheetId, tab, row, letters);

  const wrote: Partial<Record<VideoField, boolean>> = {};
  const cells: { column: string; value: string }[] = [];
  fields.forEach((f, i) => {
    const letter = letters[i];
    // ESTADO IA is the sweep's own column and is meant to be replaced each run.
    const occupied = Boolean(current[letter]) && f !== 'aiStatus';
    wrote[f] = !occupied;
    if (!occupied) cells.push({ column: letter, value: String(values[f] || '') });
  });
  if (cells.length) await updateRowCells(spreadsheetId, tab, row, cells);
  return wrote;
}

async function writeStatus(
  spreadsheetId: string,
  tab: string,
  row: number,
  columns: Partial<Record<VideoField, string>>,
  text: string,
): Promise<void> {
  const col = columns.aiStatus;
  if (!col || !text) return;
  try {
    await updateRowCells(spreadsheetId, tab, row, [{ column: col, value: text }]);
  } catch (e) {
    reportError('video-sweep:status', e, { tab, row: String(row) });
  }
}

// Whose account the sweep runs as, and what to say when the answer is nobody,
// now lives in lib/sweep-owner.ts — it grew a diagnostic that /api/health needs
// too, and health should not have to import the whole sweep to ask it.
export { resolveOwner, resolveSweepUser, type OwnerResult, type OwnerSource } from '@/lib/sweep-owner';
