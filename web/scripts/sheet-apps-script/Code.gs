// Distribución RRSS CHI → the dashboard, from inside the sheet.
//
// Two files make up the script project: this one and Dialog.html. Paste both
// into Extensions → Apps Script (File → New → HTML file, named "Dialog").
// Setup is in docs/video-autopilot.md, "Making it instant".
//
// Script properties (Project Settings → Script properties):
//   DASHBOARD_URL  https://YOUR_DOMAIN      (no trailing slash)
//   CRON_SECRET    the same secret the dashboard uses — kept here, never in
//                  the script body: anyone with view access can read the code
//   SLOT_TIMES     optional, "13:00,17:00": the quick-pick times in the panel.
//                  Keep it equal to the dashboard's VIDEO_AUTOPILOT_TIMES.
//   INSTANT_TICKS  optional, "on": a box ticked is sent the moment it is
//                  clicked, at the next free slot, without the panel. Off by
//                  default, so a tick waits for "Prepare checked boxes".
//
// What a person does: tick the network boxes on a row (FACEBOOK, INSTAGRAM,
// YOUTUBE, LINKEDIN, TIKTOK, X), select that row (or several), then
// Dashboard → Prepare checked boxes… — or the button, if one was drawn — and
// pick the day and time in the panel. Each row goes to /api/videos/row with
// that time; the dashboard writes the copy each network needs, attaches the
// video, and puts the posts in Metricool exactly as the sweep does. A network
// the row already has is left alone, so pressing it twice sends nothing twice.

var NETWORK_COLUMNS = ['youtube', 'linkedin', 'tiktok', 'x', 'facebook', 'instagram'];
var NETWORK_LABEL = { youtube: 'YouTube', linkedin: 'LinkedIn', tiktok: 'TikTok', x: 'X', facebook: 'Facebook', instagram: 'Instagram' };
var TICK = /^(true|x|✓|✔|yes|si|sí)$/i;
var LINK = /^https:\/\/(drive\.google\.com|www\.youtube\.com|youtu\.be)\//;
var CLINIC_TZ = 'America/Cancun';

// ---------------------------------------------------------------------------
// The menu and the panel.

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Dashboard')
    .addItem('Prepare checked boxes…', 'prepareCheckedBoxes')
    .addToUi();
}

/** Opens the panel. Also the function to assign to a drawn button (Insert → Drawing → ⋮ → Assign script). */
function prepareCheckedBoxes() {
  var html = HtmlService.createHtmlOutputFromFile('Dialog').setWidth(600).setHeight(680);
  SpreadsheetApp.getUi().showModalDialog(html, 'Prepare checked boxes');
}

/**
 * What the panel shows when it opens: the selected rows that have a box
 * ticked, with their titles and networks, plus the quick-pick times.
 */
function checkedRowsInSelection() {
  var sheet = SpreadsheetApp.getActiveSheet();
  var header = headerRowOf(sheet);
  if (!header) return { error: 'This tab has no LINK VIDEO column, so it is not a video tab.' };
  var range = SpreadsheetApp.getActiveRange();
  var first = range ? range.getRow() : 0;
  var count = range ? range.getNumRows() : 0;
  var rows = [];
  var titleCol = indexOf(header.names, ['título del video', 'titulo del video', 'title']);
  var copyCol = indexOf(header.names, ['copy', 'caption']);
  var linkCol = indexOf(header.names, ['link video', 'link', 'video link']);
  for (var r = first; r < first + count; r++) {
    if (r <= header.row) continue;
    var values = sheet.getRange(r, 1, 1, sheet.getLastColumn()).getValues()[0];
    var networks = [];
    for (var c = 0; c < header.names.length; c++) {
      var name = header.names[c];
      if (NETWORK_COLUMNS.indexOf(name) >= 0 && TICK.test(String(values[c] || '').trim())) networks.push(name);
    }
    if (!networks.length) continue;
    var title = titleCol >= 0 ? String(values[titleCol] || '').trim() : '';
    if (!title && copyCol >= 0) title = String(values[copyCol] || '').split('\n')[0].trim();
    var link = linkCol >= 0 ? String(values[linkCol] || '').trim() : '';
    rows.push({ row: r, title: title.slice(0, 80), networks: networks, hasLink: LINK.test(link) || /^https?:\/\//.test(link) });
  }
  return {
    tab: sheet.getName(),
    rows: rows,
    slotTimes: slotTimes(),
    tz: CLINIC_TZ,
    today: Utilities.formatDate(new Date(), CLINIC_TZ, 'yyyy-MM-dd'),
    now: Utilities.formatDate(new Date(), CLINIC_TZ, 'HH:mm'),
  };
}

/**
 * The panel's Send: each row to /api/videos/row with the chosen time.
 *
 * `publishAt` is "YYYY-MM-DDTHH:mm" on the clinic's clock; the dashboard turns
 * it into the instant. Rows go one at a time, under the lock the edit trigger
 * also takes: the dashboard gives the first row the time as asked and moves
 * the next to the following free slot, which is how two rows sent together
 * end up two slots apart rather than on top of each other.
 */
function sendCheckedRows(tab, rowNumbers, publishAt) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('DASHBOARD_URL');
  var secret = props.getProperty('CRON_SECRET');
  if (!url || !secret) return { error: 'DASHBOARD_URL and CRON_SECRET must be set in Project Settings → Script properties.' };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(publishAt || ''))) return { error: 'Pick a day and a time first.' };
  var results = [];
  var lock = LockService.getScriptLock();
  lock.waitLock(120000);
  try {
    for (var i = 0; i < rowNumbers.length; i++) {
      var row = Number(rowNumbers[i]);
      var res = UrlFetchApp.fetch(url + '/api/videos/row', {
        method: 'post', contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + secret },
        payload: JSON.stringify({ tab: tab, row: row, publishAt: publishAt }),
        muteHttpExceptions: true,
      });
      report('row ' + row, res);
      results.push(describe(row, res));
    }
  } finally {
    lock.releaseLock();
  }
  var sheet = SpreadsheetApp.getActive().getSheetByName(tab);
  if (sheet && results.length) SpreadsheetApp.getActive().toast(results.map(function (x) { return x.text; }).join('\n'), 'Dashboard', 10);
  return { results: results };
}

// ---------------------------------------------------------------------------
// The edit trigger: a pasted link runs the sweep; a tick is sent at once only
// when INSTANT_TICKS is on. Install it as Triggers → Add Trigger →
// onSheetEdit → From spreadsheet → On edit (an installable trigger; a simple
// onEdit may not call out to the dashboard).

function onSheetEdit(e) {
  if (!e || !e.range) return;
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('DASHBOARD_URL');
  var secret = props.getProperty('CRON_SECRET');
  if (!url || !secret) return;
  var instant = String(props.getProperty('INSTANT_TICKS') || '').toLowerCase() === 'on';

  var sheet = e.range.getSheet();
  var header = headerRowOf(sheet);
  if (!header) return; // not a video tab

  // Read the RANGE, not e.value: a pasted row or a dragged fill is how rows
  // actually get added, and e.value is only set for a single-cell edit.
  var values = e.range.getValues();
  var firstCol = e.range.getColumn();
  var firstRow = e.range.getRow();
  var pastedLink = false;
  var tickedRows = {};
  for (var r = 0; r < values.length; r++) {
    var row = firstRow + r;
    if (row <= header.row) continue;
    for (var c = 0; c < values[r].length; c++) {
      var v = String(values[r][c] || '');
      if (LINK.test(v)) pastedLink = true;
      var name = header.names[firstCol + c - 1];
      // A tick, not an untick: the dashboard only ever adds.
      if (instant && name && NETWORK_COLUMNS.indexOf(name) >= 0 && TICK.test(v.trim())) tickedRows[row] = true;
    }
  }
  var rows = Object.keys(tickedRows);
  if (!pastedLink && !rows.length) return;

  // One at a time: two boxes ticked a second apart must not race each other
  // into the same row. The dashboard dedupes as well; this keeps it simple.
  var lock = LockService.getScriptLock();
  lock.waitLock(120000);
  try {
    if (pastedLink) {
      // Fire and forget: the sweep is idempotent, a duplicate call is harmless
      // and a dropped one is caught by the cron.
      report('sweep', UrlFetchApp.fetch(url + '/api/videos/watch', {
        method: 'post', headers: { Authorization: 'Bearer ' + secret }, muteHttpExceptions: true,
      }));
    }
    for (var i = 0; i < rows.length; i++) {
      var res = UrlFetchApp.fetch(url + '/api/videos/row', {
        method: 'post', contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + secret },
        payload: JSON.stringify({ tab: sheet.getName(), row: Number(rows[i]) }),
        muteHttpExceptions: true,
      });
      report('row ' + rows[i], res);
      SpreadsheetApp.getActive().toast(describe(Number(rows[i]), res).text, 'Dashboard', 8);
    }
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Helpers.

/** The quick-pick times, from SLOT_TIMES or the clinic's default grid. */
function slotTimes() {
  var raw = String(PropertiesService.getScriptProperties().getProperty('SLOT_TIMES') || '13:00,17:00');
  var out = [];
  raw.split(/[,;\s]+/).forEach(function (t) { if (/^\d{1,2}:\d{2}$/.test(t)) out.push(t.length === 4 ? '0' + t : t); });
  return out.length ? out : ['13:00', '17:00'];
}

// The header row: the first of the top twenty rows with a LINK VIDEO cell.
// Returns its 1-based row and the lower-cased names by column index.
function headerRowOf(sheet) {
  var top = sheet.getRange(1, 1, Math.min(20, sheet.getLastRow()), sheet.getLastColumn()).getValues();
  for (var r = 0; r < top.length; r++) {
    var names = top[r].map(function (h) { return String(h || '').trim().toLowerCase(); });
    if (names.indexOf('link video') >= 0) return { row: r + 1, names: names };
  }
  return null;
}

function indexOf(names, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    var at = names.indexOf(candidates[i]);
    if (at >= 0) return at;
  }
  return -1;
}

// Say so in the execution log rather than failing silently forever — a wrong
// URL or a mismatched secret looks exactly like "nothing happened".
function report(what, res) {
  if (res.getResponseCode() >= 300) Logger.log(what + ' failed: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
}

/** One line a person reads, from the dashboard's answer for a row. */
function describe(row, res) {
  var out = { row: row, ok: false, text: '' };
  try {
    var j = JSON.parse(res.getContentText());
    out.action = j.action;
    out.sent = j.sent || [];
    out.refused = j.refused || [];
    out.scheduledFor = j.scheduledFor || null;
    out.moved = Boolean(j.moved);
    if (!j.ok) out.text = 'Row ' + row + ': ' + (j.message || j.error || 'failed');
    else if (j.action === 'added') {
      out.ok = out.sent.length > 0;
      var when = j.scheduledFor ? ' for ' + Utilities.formatDate(new Date(j.scheduledFor), CLINIC_TZ, 'EEE d MMM, HH:mm') + (j.moved ? ' (that slot was taken, moved to the next free one)' : '') : '';
      out.text = 'Row ' + row + ': ' + (out.sent.length ? 'sent to Metricool' + when + ' — ' + out.sent.map(label).join(', ') : 'nothing sent')
        + (out.refused.length ? ' — not ' + out.refused.map(function (x) { return label(x.network) + ' (' + (x.message || x.reason || 'refused') + ')'; }).join(', ') : '');
    }
    else if (j.action === 'nothing_new') out.text = 'Row ' + row + ': every ticked network already has its post';
    else if (j.action === 'nothing_ticked') out.text = 'Row ' + row + ': no box is ticked';
    else if (j.action === 'not_prepared') out.text = 'Row ' + row + ': not prepared yet — the sweep writes its copy first, then tick and send';
    else if (j.action === 'bad_time') out.text = 'Row ' + row + ': ' + (j.message || 'that time cannot be used');
    else out.text = 'Row ' + row + ': ' + String(j.action || '').replace(/_/g, ' ');
  } catch (err) {
    out.text = 'Row ' + row + ': the dashboard answered ' + res.getResponseCode();
  }
  return out;
}

function label(network) {
  var n = String(network || '').toLowerCase();
  if (n === 'twitter') n = 'x';
  return NETWORK_LABEL[n] || network;
}
