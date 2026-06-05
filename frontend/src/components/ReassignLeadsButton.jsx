import { useState } from 'react';
import { api } from '../api/client.js';
import { IconReload } from './icons.jsx';

/**
 * Topbar action shown on the Users page (admin only). Re-runs RM assignment for
 * every property against the current society / micro-market / city scope,
 * overwriting existing assignments where the scope now matches a different RM.
 * Backend: POST /api/inventory/assign-missing { mode: 'all' }.
 */
export default function ReassignLeadsButton() {
  const [busy, setBusy] = useState(false);

  async function reassign() {
    if (busy) return;
    const ok = window.confirm(
      'Re-run RM assignment for ALL leads?\n\n'
      + 'Every property will be re-evaluated against current users.society / '
      + 'micro_market / cities scope and reassigned where a match is found. '
      + 'Existing assignments WILL be overwritten on rows whose scope now '
      + 'belongs to a different RM. This may take 20-30 seconds.',
    );
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.post('/api/inventory/assign-missing', { mode: 'all' });
      window.alert(
        `Done — ${r.updated} reassigned · ${r.scanned} scanned · `
        + `${r.remaining} still without an RM.`,
      );
    } catch (e) {
      window.alert('Reassign failed: ' + (e?.data?.error || e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button className="btn-ghost cp-scan-btn" onClick={reassign} disabled={busy}
      title="Re-evaluate every property against the current society / micro-market / city scope and reassign RMs">
      <span className={`reload-icon ${busy ? 'reload-icon-spinning' : ''}`}><IconReload size={16} /></span>
      {busy ? 'Reassigning…' : 'Reassign Leads'}
    </button>
  );
}
