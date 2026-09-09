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
  readRowCells,
  updateRowCells,
  sourcesConfigured,
  type VideoField,
} from '@/lib/google-sources';
import { columnFor, pick, tableFromRows } from '@/lib/sheet-table';
import { prepareVideo, type PrepareOk } from '@/lib/video-prepare';
import { STATUS_TEXT, claimIsStale, firstLinkIn, fitsNetwork, isCandidate, preparedStatus, rowKeyFor } from '@/lib/video-row';
import { NEEDS_VIDEO, networksFor, nextFreeSlot } from '@/lib/video-slot';
import { publishVideoDraft, takenSlots, type PublishOutcome } from '@/lib/video-publish';
import { publicVideoCopy } from '@/lib/drive';
import { parseDriveFileId } from '@/lib/drive-url';
import { isAllowedEmail } from '@/lib/access';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { reportError } from '@/lib/report';

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
  state: 'prepared' | 'needs_transcript' | 'failed' | 'skipped' | 'would_prepare';
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
};

export async function sweepVideos(opts: SweepOptions): Promise<SweepResult> {
  const started = Date.now();
  // Sized for a 60-second function (the Hobby ceiling): stop STARTING work at
  // 45s so the video already in flight has time to finish and write back.
  const budgetMs = opts.budgetMs ?? 45_000;
  const maxVideos = opts.maxVideos ?? 1;
  const spreadsheetId = opts.spreadsheetId || SOURCE_IDS.videosSheet();
  const admin = supabaseAdmin();

  const result: SweepResult = { ok: true, scanned: 0, candidates: 0, prepared: 0, needsTranscript: 0, failed: 0, metricoolDrafts: 0, rows: [], stoppedEarly: false };
  if (!sourcesConfigured()) {
    return { ...result, ok: false };
  }

  const tabs = await listTabs(spreadsheetId);
  for (const tab of tabs) {
    if (result.prepared + result.failed + result.needsTranscript >= maxVideos) { result.stoppedEarly = true; break; }

    let rows: string[][] = [];
    try { rows = await readTab(spreadsheetId, tab.title); } catch (e) { reportError('video-sweep:tab', e, { tab: tab.title }); continue; }
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
      if (Date.now() - started > budgetMs) { result.stoppedEarly = true; break; }
      if (result.prepared + result.failed + result.needsTranscript >= maxVideos) { result.stoppedEarly = true; break; }

      result.scanned++;
      const title = pick(rec, 'título del video', 'titulo del video', 'title');
      // The cell can carry a note around the link ("SUBS: https://…", a
      // numbered list of three takes). The first link is the one to work on.
      const videoLink = firstLinkIn(pick(rec, 'link video', 'link', 'video link'));
      const copy = pick(rec, 'copy', 'caption');
      const youtubeLink = (String(pick(rec, 'youtube')).match(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\/\S+/i) || [''])[0];
      if (!isCandidate({ videoLink, copy })) continue;
      // Where the clinic has said this video goes. Ticks only — a FALSE
      // checkbox is Google's default, not a destination.
      const rowNetworks = VIDEO_NETWORKS.filter(([col]) => YES_TICK.test(pick(rec, col))).map(([, n]) => n);

      const rowKey = rowKeyFor(title, videoLink);

      // Has this row been dealt with before? A prepared row is done. A failed
      // one is retried a few times and then left alone, so a video that simply
      // cannot be transcribed does not cost money every single day.
      const { data: existing } = await admin
        .from('video_runs')
        .select('id, state, attempts, updated_at')
        .eq('spreadsheet_id', spreadsheetId).eq('tab', tab.title).eq('row_key', rowKey)
        .maybeSingle();
      const prior = existing as { id: string; state: string; attempts: number; updated_at?: string } | null;
      if (prior && (prior.state === 'prepared' || prior.state === 'skipped')) continue;
      if (prior && prior.attempts >= 3) continue;
      // Claimed by a sweep that is still running. The hourly cron and the
      // sheet's own edit trigger can fire seconds apart, and transcribing a
      // video takes minutes — without this both would do it, and pay twice.
      // A claim older than the longest a request can live is stale, not held.
      if (prior && prior.state === 'preparing' && !claimIsStale(prior.updated_at)) continue;

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
        if (fileId) {
          const probe = await probeDriveMedia(fileId);
          if (!probe.ok) {
            reach = {
              ...reach,
              // 'too_large' now means past what can be pulled down at all, not
              // past what can be transcribed — the audio track is what gets
              // transcribed, and that is always small.
              state: probe.reason === 'too_large' ? 'needs_transcript' : 'failed',
              message: probe.message,
            };
            if (probe.reason === 'too_large') result.needsTranscript++; else result.failed++;
          } else {
            reach.message = 'Reachable · ' + (probe.sizeBytes ? (probe.sizeBytes / 1024 / 1024).toFixed(1) + ' MB' : 'size unknown');
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
        const prepared = await prepareVideo({
          userId: opts.userId,
          url: videoLink,
          youtubeUrl: youtubeLink || null,
          title: title || null,
        });

        if (!prepared.ok) {
          const state = prepared.needsPaste ? 'needs_transcript' : 'failed';
          await writeStatus(spreadsheetId, tab.title, row, columns, STATUS_TEXT[state]);
          await admin.from('video_runs').update({ state, last_error: prepared.message, updated_at: new Date().toISOString() })
            .eq('spreadsheet_id', spreadsheetId).eq('tab', tab.title).eq('row_key', rowKey);
          if (state === 'needs_transcript') result.needsTranscript++; else result.failed++;
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

        await admin.from('video_runs').update({
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
          updated_at: new Date().toISOString(),
        }).eq('spreadsheet_id', spreadsheetId).eq('tab', tab.title).eq('row_key', rowKey);

        result.prepared++;
        result.metricoolDrafts += posted.filter((p) => p.ok).length;
        outcome = { tab: tab.title, row, rowKey, title: prepared.title, state: 'prepared', wrote, draftId: prepared.draftId, metricool: posted };
        result.rows.push(outcome);
      } catch (e) {
        reportError('video-sweep:row', e, { tab: tab.title, row: String(row) });
        const message = e instanceof Error ? e.message : 'Unknown failure';
        await admin.from('video_runs').update({ state: 'failed', last_error: message, updated_at: new Date().toISOString() })
          .eq('spreadsheet_id', spreadsheetId).eq('tab', tab.title).eq('row_key', rowKey);
        result.failed++;
        result.rows.push({ tab: tab.title, row, rowKey, title: title || videoLink, state: 'failed', message });
      }
    }
  }

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
export async function completeRow(opts: {
  userId: string;
  tab: string;
  row: number;
  prepared: PrepareOk;
  videoLink: string;
  skipMetricool?: boolean;
  spreadsheetId?: string;
}): Promise<{ wrote: Partial<Record<VideoField, boolean>>; metricool: PublishOutcome[]; status: string }> {
  const spreadsheetId = opts.spreadsheetId || SOURCE_IDS.videosSheet();
  const rows = await readTab(spreadsheetId, opts.tab);
  const { header, headerRow, records } = tableFromRows(rows, ['tipo de video', 'título del video', 'titulo del video', 'copy', 'link video', 'formato', 'title', 'video']);
  if (!header.length) throw new Error('That tab has no video table.');

  const found = records.find((r) => r.row === opts.row);
  if (!found) throw new Error('Row ' + opts.row + ' is not a data row on ' + opts.tab + '.');

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

  const metricool = opts.skipMetricool ? [] : await handOffToMetricool({
    userId: opts.userId,
    prepared: opts.prepared,
    networks: rowNetworks,
    videoLink: opts.videoLink,
    title: opts.prepared.title,
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
      updated_at: new Date().toISOString(),
    }, { onConflict: 'spreadsheet_id,tab,row_key' });
  } catch (e) {
    reportError('video-complete:run', e);
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
  prepared: { linkedin: string; tiktok: string; draftId: string | null };
  networks: string[];
  videoLink: string;
  title: string;
}): Promise<PublishOutcome[]> {
  const { userId, prepared, networks, videoLink, title } = args;

  // Is a video needed at all? Only pay for the copy if some network wants one.
  const fileId = parseDriveFileId(videoLink);
  const wantsVideo = networksFor(networks, true).some((n) => NEEDS_VIDEO.has(n));
  let mediaUrl: string | null = null;
  if (wantsVideo && fileId) {
    try {
      const copied = await publicVideoCopy(fileId, title.replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 80) + '.mp4');
      mediaUrl = copied.url;
    } catch (e) {
      // Not fatal: the networks that need a video are dropped below, and the
      // text-only ones still get their drafts.
      reportError('video-sweep:media-copy', e);
    }
  }

  const chosen = networksFor(networks, Boolean(mediaUrl));
  if (!chosen.length) return [];

  const now = new Date();
  const taken = new Set(await takenSlots(userId, now.toISOString()));
  const out: PublishOutcome[] = [];
  for (const network of chosen) {
    const slot = nextFreeSlot(taken, now);
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
      mediaUrl: NEEDS_VIDEO.has(network) ? mediaUrl : null,
      draftId: prepared.draftId,
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

/**
 * Whose account the sweep runs as.
 *
 * The sheet belongs to the clinic, not to a person, but a draft needs an owner
 * and the writer needs a brand profile to speak in. Explicit setting first;
 * otherwise the oldest brand profile, which is the workspace's own.
 */
export async function resolveSweepUser(): Promise<string | null> {
  const explicit = process.env.VIDEO_AUTOPILOT_USER_ID;
  if (explicit) return explicit;

  // A saved Brand Brain is the best answer: it is the voice the copy should be
  // written in as well as an owner for the drafts.
  try {
    const { data } = await supabaseAdmin()
      .from('brand_profiles')
      .select('user_id')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const owner = (data as { user_id?: string } | null)?.user_id;
    if (owner) return owner;
  } catch (e) {
    reportError('video-sweep:user', e);
  }

  // No Brand Brain saved yet. That is a real gap — the copy will use the
  // default voice — but it is not a reason to refuse the whole sweep, which is
  // what it did: the trigger fired correctly, reached the dashboard, and got
  // 503 no_owner, so a working end-to-end setup looked broken over a page
  // nobody had pressed Save on.
  //
  // The sheet belongs to the workspace, and lib/access.ts already says who the
  // workspace is. Fall back to the first allowlisted account that exists.
  try {
    const { data } = await supabaseAdmin().auth.admin.listUsers({ page: 1, perPage: 200 });
    const users = (data?.users || []) as { id: string; email?: string | null; created_at?: string }[];
    const allowed = users
      .filter((u) => isAllowedEmail(u.email ?? null))
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    return allowed[0]?.id || null;
  } catch (e) {
    reportError('video-sweep:user-fallback', e);
    return null;
  }
}
