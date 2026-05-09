/**
 * Openhouse Direct Inventory — OH Pricing weekly sync.
 *
 * Source sheet (separate from the inventory sheet): two tabs we care about:
 *   - "Gurgaon"     → Gurgaon societies
 *   - "Noida + GZB" → Noida + Ghaziabad societies
 *
 * Each tab is expected to have headers (case/space/punct insensitive) including
 * at minimum: Society, BHK, Area (or Area sqft / Size), Price (or OH Price).
 * The "Noida + GZB" tab should also have a City column ("Noida" or "Ghaziabad")
 * so we know which city each row belongs to. The "Gurgaon" tab can omit it.
 *
 * Setup (one time):
 *   1. Open the OH Pricing sheet (id 19lHea4MAz71etXjxeili6-dwbSU9QWzulLoZl1li7HI).
 *   2. Extensions → Apps Script. Paste this file as a new .gs file.
 *   3. Project Settings → Time zone: Asia/Kolkata.
 *   4. Project Settings → Script Properties → add:
 *        BACKEND_URL = https://direct-inventory.onrender.com
 *        SYNC_TOKEN  = (same value as the backend's SYNC_TOKEN env var)
 *   5. Run OHP_runPricingSync once to seed; then OHP_installTrigger to schedule
 *      a weekly Friday push.
 */

const OHP_TABS = [
  { sheet: 'Gurgaon',     sourceSheet: 'Gurgaon' },
  { sheet: 'Noida + GZB', sourceSheet: 'Noida + GZB' },
];
const OHP_BATCH_SIZE = 500;

function OHP_props_() {
  return PropertiesService.getScriptProperties();
}

function OHP_installTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'OHP_runPricingSync') ScriptApp.deleteTrigger(t);
  });
  // Weekly Friday at ~10:00 IST.
  ScriptApp.newTrigger('OHP_runPricingSync')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.FRIDAY)
    .atHour(10)
    .create();
  Logger.log('Trigger installed: OHP_runPricingSync every Friday at ~10:00 IST.');
}

function OHP_normHeader_(h) {
  return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function OHP_collectRows_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(OHP_normHeader_);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const obj = {};
    let hasAnything = false;
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      if (!key) continue;
      let v = row[j];
      if (v instanceof Date) v = Utilities.formatDate(v, 'Asia/Kolkata', 'yyyy-MM-dd');
      obj[key] = v;
      if (v !== '' && v !== null && v !== undefined) hasAnything = true;
    }
    if (hasAnything) rows.push(obj);
  }
  return rows;
}

function OHP_postBatch_(backendUrl, syncToken, sourceSheet, batch, b, totalBatches) {
  const resp = UrlFetchApp.fetch(`${backendUrl}/api/sync/oh-pricing`, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Sync-Token': syncToken },
    payload: JSON.stringify({
      source_sheet: sourceSheet,
      rows: batch,
      actor: `apps-script:oh-pricing:${sourceSheet}:batch-${b + 1}/${totalBatches}`,
    }),
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  Logger.log(`[${sourceSheet}] Batch ${b + 1}/${totalBatches} (${batch.length}) → HTTP ${code}: ${body}`);
  if (code >= 300) throw new Error(`[${sourceSheet}] Batch ${b + 1} failed (${code}): ${body}`);
  return JSON.parse(body || '{}');
}

function OHP_runPricingSync() {
  const props = OHP_props_();
  const backendUrl = props.getProperty('BACKEND_URL');
  const syncToken  = props.getProperty('SYNC_TOKEN');
  if (!backendUrl || !syncToken) {
    throw new Error('Set BACKEND_URL and SYNC_TOKEN in Script Properties first.');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const grandTotals = {};

  for (const { sheet: sheetName, sourceSheet } of OHP_TABS) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Logger.log(`Sheet "${sheetName}" not found — skipping.`);
      continue;
    }
    const allRows = OHP_collectRows_(sheet);
    Logger.log(`[${sourceSheet}] ${allRows.length} non-empty rows`);
    if (allRows.length === 0) {
      // Still send an empty batch so the backend wipes the table for this source.
      OHP_postBatch_(backendUrl, syncToken, sourceSheet, [], 0, 1);
      continue;
    }
    const totalBatches = Math.ceil(allRows.length / OHP_BATCH_SIZE);
    const totals = { fetched: 0, inserted: 0, skipped: 0 };
    for (let b = 0; b < totalBatches; b++) {
      const batch = allRows.slice(b * OHP_BATCH_SIZE, (b + 1) * OHP_BATCH_SIZE);
      const r = OHP_postBatch_(backendUrl, syncToken, sourceSheet, batch, b, totalBatches);
      totals.fetched  += r.fetched  || 0;
      totals.inserted += r.inserted || 0;
      totals.skipped  += r.skipped  || 0;
    }
    grandTotals[sourceSheet] = totals;
  }

  Logger.log(`PRICING SYNC DONE — ${JSON.stringify(grandTotals)}`);
}
