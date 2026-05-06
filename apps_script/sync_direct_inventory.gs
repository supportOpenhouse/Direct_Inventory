/**
 * Openhouse Direct Inventory — daily sheet → backend sync.
 *
 * Setup (one time):
 *   1. Open the data sheet (id 1cTKri04m4HEj_JhTxH9FE9h70RL5gRMv4yGtv9g1BQM).
 *   2. Extensions → Apps Script. Paste this file as Code.gs.
 *   3. Project Settings → Script Properties → add:
 *        BACKEND_URL  = https://direct-inventory.onrender.com
 *        SYNC_TOKEN   = <same value as the backend env var SYNC_TOKEN>
 *   4. Run installTrigger() once. Approve the OAuth prompt.
 *
 * After install, runSync() fires automatically every day at 11:30 IST.
 * To trigger manually, hit the "Run" button on runSync().
 *
 * Pattern follows acq_sync.gs from CP Inventory Portal.
 */

const SHEET_NAME = 'Sheet1';

function _props() {
  return PropertiesService.getScriptProperties();
}

function installTrigger() {
  // Remove any existing triggers for runSync
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'runSync') ScriptApp.deleteTrigger(t);
  });
  // Daily at 11:30 IST. Apps Script runs in the script's timezone — set the
  // script TZ to Asia/Kolkata in Project Settings if not already.
  ScriptApp.newTrigger('runSync')
    .timeBased()
    .everyDays(1)
    .atHour(11)
    .nearMinute(30)
    .create();
  Logger.log('Trigger installed: runSync daily at ~11:30 IST.');
}

function runSync() {
  const props = _props();
  const backendUrl = props.getProperty('BACKEND_URL');
  const syncToken  = props.getProperty('SYNC_TOKEN');
  if (!backendUrl || !syncToken) {
    throw new Error('Set BACKEND_URL and SYNC_TOKEN in Script Properties first.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${SHEET_NAME}" not found`);

  const range = sheet.getDataRange();
  const values = range.getValues();
  if (values.length < 2) {
    Logger.log('Sheet has no data rows.');
    return;
  }

  const headers = values[0].map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const obj = {};
    let hasLink = false;
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      if (!key) continue;
      let v = row[j];
      if (v instanceof Date) v = Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd');
      obj[key] = v;
      if (key === 'listing_link' && v) hasLink = true;
    }
    if (hasLink) rows.push(obj);
  }

  Logger.log(`Posting ${rows.length} rows to ${backendUrl}/api/sync/sheet`);

  const resp = UrlFetchApp.fetch(`${backendUrl}/api/sync/sheet`, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Sync-Token': syncToken },
    payload: JSON.stringify({ rows: rows, actor: 'apps-script:direct-inventory' }),
    muteHttpExceptions: true,
  });

  const code = resp.getResponseCode();
  const body = resp.getContentText();
  Logger.log(`HTTP ${code}: ${body}`);
  if (code >= 300) throw new Error(`Sync failed (${code}): ${body}`);
}
