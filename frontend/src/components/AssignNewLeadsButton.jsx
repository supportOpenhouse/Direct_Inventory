import { useState } from 'react';
import { api } from '../api/client.js';
import { IconReload } from './icons.jsx';

/**
 * Track Tasks action: assign a POC to leads that came in UNASSIGNED
 * (mode='missing' — only fills empty assignments, never overwrites). The cron
 * runs this automatically every 15 min; this is the on-demand "run now". It's
 * rate-limited server-side to once per 15 min, so a 429 surfaces the cooldown
 * message instead of re-running the heavy scan.
 */
export default function AssignNewLeadsButton() {
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await api.post('/api/inventory/assign-missing', { mode: 'missing' });
      window.alert(`Done — ${r.updated} assigned · ${r.scanned} scanned · ${r.remaining} still without an RM.`);
    } catch (e) {
      // 429 = cooldown; the backend message ("ran recently — try again in ~N min")
      // is user-facing, so show it verbatim.
      window.alert(e?.data?.error || ('Assign failed: ' + (e?.message || e)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="btn-ghost cp-scan-btn" onClick={run} disabled={busy}
      title="Assign an RM to leads that came in unassigned (fills empty assignments only)">
      <span className={`reload-icon ${busy ? 'reload-icon-spinning' : ''}`}><IconReload size={16} /></span>
      {busy ? 'Assigning…' : 'Assign New Leads'}
    </button>
  );
}
