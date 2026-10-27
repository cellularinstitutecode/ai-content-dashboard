// web/lib/video-ticks.ts
// A box ticked AFTER a row was prepared, acted on as it is clicked.
//
// The sweep reads a row's ticks once, when it prepares the row, and treats a
// prepared row as finished. Ticking Facebook on a video that already went to
// YouTube, LinkedIn and TikTok therefore did nothing — not on the next sweep,
// not ever. The sheet's own Apps Script edit trigger (docs/video-autopilot.md,
// "Making it instant") now POSTs the edited row to /api/videos/row, and this
// does the work for that ONE row:
//
//   1. read the row and its ticks, exactly the way completeRow reads them;
//   2. find what the row was already sent (video_runs.metricool);
//   3. hand the ticked networks that have nothing yet to the same hand-off
//      every other path uses — with the copy already on the draft, so the
//      Facebook text is the one that was written for Facebook, not a rewrite;
//   4. record the answers next to the old ones, and a register line.
//
// Two callers: the sheet's edit trigger, which sends a row as a box is ticked
// and lets the hand-off pick the next free slot; and the sheet's "Prepare
// checked boxes" panel (scripts/sheet-apps-script), which sends the rows a
// person selected with the day and time they chose on the clinic's clock
// (`publishAt`). Both end in the same hand-off, so a post made from the panel
// is the same post the sweep would have made, at the time the person picked.
//
// It only ADDS. An unticked box deletes nothing: a draft waiting in Metricool
// is somebody's work, and the dashboard is where it is withdrawn. A row that
// has not been prepared yet is left to the link trigger and the sweep, which
// own preparation (transcript, keywords, copy); this answers `not_prepared`
// and the script says so in the sheet.
//
// No duplicates, twice over: networksToAdd (lib/tick-add.ts) skips networks the
// row's record says were sent, and the hand-off itself asks the posts table
// (lib/awaiting-posts.ts) before creating anything.
import 'server-only';

import { SOURCE_IDS, readTabWithMeta, tabGid } from '@/lib/google-sources';
import { existingCopyText } from '@/lib/existing-copy';
import { reportError } from '@/lib/report';
import { columnFor, pick, tableFromRows } from '@/lib/sheet-table';
import { VIDEO_NETWORK_COLUMNS, publishedNetworks, tickedNetworks } from '@/lib/sheet-ticks';
import { supabaseAdmin } from '@/lib/supabase-admin';
import { chosenSlot, mergeOutcomes, networksToAdd, type PriorOutcome } from '@/lib/tick-add';
import { scheduleInstantFromInput } from '@/lib/schedule-clock';
import { handOffToMetricool } from '@/lib/video-autopilot';
import { videoKeyFor } from '@/lib/video-event';
import { takenSlots, type PublishOutcome } from '@/lib/video-publish';
import { recordVideoEvent } from '@/lib/video-register';
import { firstLinkIn, rowKeyFor } from '@/lib/video-row';

/** The table header the sweep and completeRow look for; the same list, so a row reads the same way from every door. */
const WANTED_HEADERS = ['tipo de video', 'título del video', 'titulo del video', 'copy', 'link video', 'formato', 'title', 'video', 'youtube', 'linkedin', 'tiktok', 'x', 'facebook', 'instagram', 'email'];

export type TickAddResult =
  /** Drafts were asked for: `made` holds one answer per network, sent or refused. */
  | {
      action: 'added'; tab: string; row: number; title: string; networks: string[]; sent: string[]; refused: { network: string; reason?: string; message?: string }[]; made: PublishOutcome[];
      /** The instant the posts were scheduled for, when the caller asked for one (UTC, ISO). */
      scheduledFor?: string;
      /** True when the time asked for was already taken and the next free slot was used instead. */
      moved?: boolean;
    }
  /** The time asked for has already gone, could not be read, or the calendar is full after it. */
  | { action: 'bad_time'; tab: string; row: number; title: string; reason: 'past' | 'full' | 'unreadable'; message: string }
  /** Held (`hold`): the row is ticked and owed these networks; the dashboard's panel is where its time is picked. */
  | { action: 'needs_time'; tab: string; row: number; title: string; networks: string[]; message: string }
  /** Every ticked network already has its draft. */
  | { action: 'nothing_new'; tab: string; row: number; title: string; have: string[] }
  /** Nothing is ticked on the row. */
  | { action: 'nothing_ticked'; tab: string; row: number; title: string }
  /** The row has no copy yet: preparing is the link trigger's and the sweep's job. */
  | { action: 'not_prepared'; tab: string; row: number; title: string; state: string | null }
  /** The row has no video link, so there is nothing to post. */
  | { action: 'no_link'; tab: string; row: number }
  /** The row is hidden in the sheet; hidden rows are left alone everywhere. */
  | { action: 'hidden'; tab: string; row: number }
  /** The row is not a data row of a video table. */
  | { action: 'not_a_row'; tab: string; row: number };

export async function addTickedNetworks(opts: {
  userId: string;
  tab: string;
  row: number;
  spreadsheetId?: string;
  /** What is left of the request's clock; the hand-off stops starting work in time to answer. */
  budgetMs?: number;
  /**
   * When the posts should go out, as the sheet's panel sends it: "YYYY-MM-DDTHH:mm"
   * on the clinic's clock (lib/schedule-clock.ts). Without it the hand-off picks the
   * next free slot, as a tick from the edit trigger always has.
   */
  publishAt?: string | null;
  /**
   * Hold rather than send: read the row, record a `ticked` line in the register
   * so the dashboard's Prepare checked boxes lists it first, and answer
   * `needs_time`. What the sheet's edit trigger gets for a tick with no time.
   */
  hold?: boolean;
}): Promise<TickAddResult> {
  const spreadsheetId = opts.spreadsheetId || SOURCE_IDS.videosSheet();
  const { tab, row } = opts;
  const { rows, hidden } = await readTabWithMeta(spreadsheetId, tab);
  const { header, records } = tableFromRows(rows, WANTED_HEADERS);
  if (!header.length || !columnFor(header, 'link video', 'link', 'video link')) return { action: 'not_a_row', tab, row };
  const found = records.find((r) => r.row === row);
  if (!found) return { action: 'not_a_row', tab, row };
  if (hidden.has(row)) return { action: 'hidden', tab, row };

  const rec = found.rec;
  const title = pick(rec, 'título del video', 'titulo del video', 'title');
  const videoLink = firstLinkIn(pick(rec, 'link video', 'link', 'video link'));
  if (!videoLink) return { action: 'no_link', tab, row };
  const label = title || videoLink;
  const rowKey = rowKeyFor(title, videoLink);

  // The row's record. '*' for the reason the sweep gives: a column this
  // database has not migrated yet must not make the whole read fail.
  const admin = supabaseAdmin();
  const { data: existing, error: priorError } = await admin
    .from('video_runs')
    .select('*')
    .eq('spreadsheet_id', spreadsheetId).eq('tab', tab).eq('row_key', rowKey)
    .maybeSingle()
    .then((x) => x, (e: unknown) => ({ data: null, error: e as { message?: string } }));
  if (priorError) throw new Error('The row’s record could not be read: ' + (priorError.message || 'database error'));
  const prior = existing as { state?: string | null; draft_id?: string | null; metricool?: unknown } | null;
  if (!prior || prior.state !== 'prepared') return { action: 'not_prepared', tab, row, title: label, state: prior?.state ?? null };

  const ticked = tickedNetworks(VIDEO_NETWORK_COLUMNS, (col: string) => pick(rec, col));
  if (!ticked.length) return { action: 'nothing_ticked', tab, row, title: label };
  const priorOutcomes: PublishOutcome[] = Array.isArray(prior.metricool) ? (prior.metricool as PublishOutcome[]) : [];
  const networks = networksToAdd(ticked, priorOutcomes as PriorOutcome[]);
  if (opts.hold) {
    // Remembered, not sent. Written whether or not anything is owed: a row
    // whose every tick already has its post is still the row the person just
    // ticked, and the panel offers to move those posts to the time chosen.
    void recordVideoEvent({
      userId: opts.userId,
      videoKey: videoKeyFor(spreadsheetId, tab, rowKey),
      event: 'ticked',
      actor: 'sheet',
      title: title || null,
      link: videoLink,
      detail: { tab, row, gid: await tabGid(spreadsheetId, tab), ticked: ticked.filter((n) => n !== 'email'), owed: networks },
    });
    if (!networks.length) return { action: 'nothing_new', tab, row, title: label, have: ticked.filter((n) => n !== 'email') };
    return {
      action: 'needs_time', tab, row, title: label, networks,
      message: 'Row ' + row + ' is ticked for ' + networks.join(', ') + '. Pick the day and time in the dashboard’s Video Library → Prepare checked boxes, and it is sent then.',
    };
  }
  if (!networks.length) {
    return { action: 'nothing_new', tab, row, title: label, have: ticked.filter((n) => n !== 'email') };
  }

  // The time the panel asked for, checked against the calendar (lib/tick-add.ts
  // chosenSlot): as given when free, the next grid slot after it when taken,
  // refused when gone. Decided before any copy is written, so a bad time costs
  // nothing. The shape is a datetime-local value on the clinic's clock, which
  // is what the sheet's panel and the dashboard's composer both send.
  let publicationDate: string | undefined;
  let moved = false;
  if (typeof opts.publishAt === 'string' && opts.publishAt.trim()) {
    const iso = scheduleInstantFromInput(opts.publishAt);
    if (!iso) return { action: 'bad_time', tab, row, title: label, reason: 'unreadable', message: 'The time could not be read: ' + opts.publishAt + '. Send YYYY-MM-DDTHH:mm on the clinic’s clock.' };
    const now = new Date();
    const choice = chosenSlot(new Date(iso), await takenSlots(opts.userId, now.toISOString()), now);
    if (!choice.ok) {
      return choice.reason === 'past'
        ? { action: 'bad_time', tab, row, title: label, reason: 'past', message: 'That time has already gone. Pick a later one.' }
        : { action: 'bad_time', tab, row, title: label, reason: 'full', message: 'Every posting slot after that time is taken inside the scheduling horizon.' };
    }
    publicationDate = choice.at.toISOString();
    moved = choice.moved;
  }

  // The copy already on the draft — the long post, the caption, the title and
  // any text written for one network — so this pass sends what the first one
  // would have. The sheet's COPY cell is the fallback for a row whose copy a
  // person wrote (lib/existing-copy.ts), which has no pack text of its own.
  let pack: { linkedin?: unknown; tiktok?: unknown; title?: unknown; tailored?: unknown } = {};
  if (prior.draft_id) {
    const { data: d } = await admin.from('drafts').select('pack').eq('id', prior.draft_id).maybeSingle().then((x) => x, () => ({ data: null }));
    pack = ((d as { pack?: Record<string, unknown> | null } | null)?.pack || {}) as typeof pack;
  }
  const sheetCopy = existingCopyText(pick(rec, 'copy', 'caption'));
  const linkedin = typeof pack.linkedin === 'string' && pack.linkedin.trim() ? pack.linkedin : sheetCopy;
  const tiktok = typeof pack.tiktok === 'string' && pack.tiktok.trim() ? pack.tiktok : sheetCopy;
  if (!linkedin && !tiktok) {
    // Prepared, but with no text anywhere: nothing can be sent. Recorded as
    // refused so the register says why rather than nothing.
    const made: PublishOutcome[] = networks.map((network) => ({ network, ok: false, reason: 'metricool_error', message: 'The row is marked prepared but has no copy on its draft or in the sheet, so nothing could be sent.' }));
    return { action: 'added', tab, row, title: label, networks, sent: [], refused: made.map((m) => ({ network: m.network, reason: m.reason, message: m.message })), made };
  }
  const tailored = pack.tailored && typeof pack.tailored === 'object' ? (pack.tailored as Partial<Record<string, string>>) : null;
  const draftTitle = typeof pack.title === 'string' && pack.title.trim() ? pack.title : null;

  const made = await handOffToMetricool({
    userId: opts.userId,
    prepared: { linkedin: linkedin || tiktok, tiktok: tiktok || linkedin, draftId: prior.draft_id || null, title: draftTitle, tailored },
    // Only the networks owed: an explicit list, so the hand-off's defaults never apply here.
    networks,
    videoLink,
    title: draftTitle || label,
    format: pick(rec, 'formato', 'format'),
    sheetYoutube: pick(rec, 'youtube'),
    published: publishedNetworks(VIDEO_NETWORK_COLUMNS, (col: string) => pick(rec, col)),
    rowLabel: tab + ' · row ' + row,
    budgetMs: opts.budgetMs,
    // The panel's time, when there is one; every network of the row shares it.
    publicationDate,
  });

  // The record: this pass's answers beside the old ones, so the next tick sees
  // these networks as done and the register's row chip stays whole.
  const { error: upErr } = await admin
    .from('video_runs')
    .update({ metricool: mergeOutcomes(priorOutcomes, made), updated_at: new Date().toISOString() })
    .eq('spreadsheet_id', spreadsheetId).eq('tab', tab).eq('row_key', rowKey)
    .then((x) => x, (e: unknown) => ({ error: e as { message?: string } }));
  if (upErr) reportError('video-ticks:run', upErr, { tab, row: String(row) });

  const sent = made.filter((m) => m.ok).map((m) => m.network);
  const refused = made.filter((m) => !m.ok).map((m) => ({ network: m.network, reason: m.reason, message: m.message }));
  void recordVideoEvent({
    userId: opts.userId,
    videoKey: videoKeyFor(spreadsheetId, tab, rowKey),
    event: 'queued',
    actor: 'sheet',
    title: draftTitle || title || null,
    link: videoLink,
    detail: { tab, row, gid: await tabGid(spreadsheetId, tab), ticked: networks, networks: sent, refused, ...(publicationDate ? { scheduledFor: publicationDate, moved } : {}) },
  });
  return { action: 'added', tab, row, title: label, networks, sent, refused, made, ...(publicationDate ? { scheduledFor: publicationDate, moved } : {}) };
}
