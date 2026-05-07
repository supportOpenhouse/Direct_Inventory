/**
 * Openhouse Direct Inventory — daily sheet → backend sync.
 *
 * Names are prefixed with DI_ so this can coexist with other Apps Scripts in
 * the same Sheet (Apps Script puts every .gs file in one shared global scope).
 *
 * Setup (one time):
 *   1. Open the data sheet (id 1cTKri04m4HEj_JhTxH9FE9h70RL5gRMv4yGtv9g1BQM).
 *   2. Extensions → Apps Script. Paste this file as a new .gs file.
 *   3. Project Settings → Script Properties → add:
 *        BACKEND_URL  = https://direct-inventory.onrender.com
 *        SYNC_TOKEN   = <same value as the backend env var SYNC_TOKEN>
 *   4. Run DI_runSync once to seed; then DI_installTrigger to schedule daily.
 */

const DI_SHEET_NAME = 'Sheet1';
const DI_BATCH_SIZE = 200;   // Per-POST. Keeps each request under Render's 60s gunicorn timeout.

function DI_props_() {
  return PropertiesService.getScriptProperties();
}

function DI_installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'DI_runSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('DI_runSync')
    .timeBased()
    .everyDays(1)
    .atHour(11)
    .nearMinute(30)
    .create();
  Logger.log('Trigger installed: DI_runSync daily at ~11:30 IST.');
}

function DI_runSync() {
  const props = DI_props_();
  const backendUrl = props.getProperty('BACKEND_URL');
  const syncToken  = props.getProperty('SYNC_TOKEN');
  if (!backendUrl || !syncToken) {
    throw new Error('Set BACKEND_URL and SYNC_TOKEN in Script Properties first.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DI_SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${DI_SHEET_NAME}" not found`);

  const values = sheet.getDataRange().getValues();
  if (values.length < 2) {
    Logger.log('Sheet has no data rows.');
    return;
  }

  const headers = values[0].map(h => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  const allRows = [];
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
    if (hasLink) allRows.push(obj);
  }

  const totalBatches = Math.ceil(allRows.length / DI_BATCH_SIZE);
  Logger.log(`Sheet has ${allRows.length} rows with listing_link. Posting in ${totalBatches} batch(es) of up to ${DI_BATCH_SIZE}.`);

  const totals = { fetched: 0, inserted: 0, updated: 0, skipped: 0, errors: 0 };

  for (let b = 0; b < totalBatches; b++) {
    const batch = allRows.slice(b * DI_BATCH_SIZE, (b + 1) * DI_BATCH_SIZE);
    const resp = UrlFetchApp.fetch(`${backendUrl}/api/sync/sheet`, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Sync-Token': syncToken },
      payload: JSON.stringify({ rows: batch, actor: `apps-script:direct-inventory:batch-${b + 1}/${totalBatches}` }),
      muteHttpExceptions: true,
    });
    const code = resp.getResponseCode();
    const body = resp.getContentText();
    Logger.log(`Batch ${b + 1}/${totalBatches} (${batch.length} rows) → HTTP ${code}: ${body}`);
    if (code >= 300) {
      throw new Error(`Sync failed at batch ${b + 1} (${code}): ${body}`);
    }
    try {
      const r = JSON.parse(body);
      totals.fetched  += r.fetched  || 0;
      totals.inserted += r.inserted || 0;
      totals.updated  += r.updated  || 0;
      totals.skipped  += r.skipped  || 0;
      totals.errors   += r.errors   || 0;
    } catch (e) {}
  }

  Logger.log(`SYNC DONE — total fetched=${totals.fetched}, inserted=${totals.inserted}, updated=${totals.updated}, skipped=${totals.skipped}, errors=${totals.errors}`);
}
