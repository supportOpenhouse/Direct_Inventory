import { useState } from 'react';
import { api } from '../api/client.js';
import { IconReload } from './icons.jsx';

/**
 * Topbar action that runs the CP Inventory match scan. The backend processes
 * one chunk per call (POST /api/inventory/cp-match-scan), so we loop — feeding
 * back `next_cursor` and accumulating totals — until the response is `done`.
 */
export default function CpScanButton() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);

  async function runScan() {
    if (scanning) return;
    if (!window.confirm('Run CP Inventory match scan? This only checks rows that haven’t been scanned yet (or were edited since the last scan).')) return;
    setScanning(true);
    setProgress(0);
    try {
      let cursor = '';
      let totals = { perfect: 0, partial: 0, no_match: 0 };
      let processed = 0;
      for (;;) {
        const r = await api.post('/api/inventory/cp-match-scan', { cursor, prior_totals: totals });
        totals = {
          perfect: totals.perfect + r.perfect,
          partial: totals.partial + r.partial,
          no_match: totals.no_match + r.no_match,
        };
        processed += r.processed;
        setProgress(processed);
        if (r.done) break;
        cursor = r.next_cursor;
      }
      const total = totals.perfect + totals.partial + totals.no_match;
      alert(
        `CP scan complete — ${total} rows.\n`
        + `Perfect: ${totals.perfect}\nPartial: ${totals.partial}\nNo match: ${totals.no_match}`,
      );
    } catch (e) {
      alert('Scan failed: ' + (e.data?.error || e.message));
    } finally {
      setScanning(false);
    }
  }

  return (
    <button className="btn-ghost cp-scan-btn" onClick={runScan} disabled={scanning} title="Re-scan CP Inventory matches">
      <span className={`reload-icon ${scanning ? 'reload-icon-spinning' : ''}`}><IconReload size={16} /></span>
      {scanning ? `Scanning… ${progress}` : 'Re-scan CP'}
    </button>
  );
}
