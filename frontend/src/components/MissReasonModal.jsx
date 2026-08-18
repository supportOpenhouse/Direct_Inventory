import { useState } from 'react';
import { api } from '../api/client.js';
import { toast } from '../utils/toast.js';

/* "Why didn't it connect?" — the disposition dialog an RM opens from a completed call
   that needs a result. Reason + mandatory notes; on submit it POSTs the miss and the
   server decides the follow-up / reject / RNR outcome (see api/live_calls.py). */

// label → follow-up delay (minutes); null = invalid number → Rejected. Mirrors MISS_REASONS.
const REASONS = {
  'Did Not Pick / Not Reachable': 180,
  'Switched Off': 360,
  'Invalid Number': null,
};

// Client mirror of _followup_date() — preview only; the server is authoritative.
function previewDate(minutes) {
  const d = new Date(Date.now() + minutes * 60000);
  const h = d.getHours();
  if (h >= 19) { d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0); }
  else if (h < 10) d.setHours(10, 0, 0, 0);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export default function MissReasonModal({ ohId, queueItemId, onClose, onDone }) {
  const [reason, setReason] = useState('Did Not Pick / Not Reachable');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const mins = REASONS[reason];
  const isReject = mins === null;

  async function submit() {
    if (!notes.trim()) return toast('Notes are required.', 'error');
    setBusy(true);
    try {
      const r = await api.post(`/api/live-calls/leads/${encodeURIComponent(ohId)}/result`,
        { connected: false, reason, notes: notes.trim(), queue_item_id: queueItemId }, { silent: true });
      if (r.status === 'blocked') {
        toast(`Spam blocker — try again in ${r.retry_in_minutes} minutes`, 'error');
        return;  // nothing recorded; leave the dialog open
      }
      if (r.rejected) toast('Invalid number — moved to Rejected', 'info');
      else if (r.moved_to_rnr) toast('10 missed calls — moved to Rejected (RNR)', 'error');
      else toast(r.follow_up_at ? `Not reached · follow-up ${r.follow_up_at}` : 'Not reached · follow-up set', 'info');
      onClose();
      onDone?.();
    } catch (e) {
      toast(e?.data?.error || e?.message || 'Could not save', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lc-overlay" onClick={onClose}>
      <div className="lc-modal" onClick={(e) => e.stopPropagation()}>
        <div className="lc-mh">Why didn’t it connect?</div>
        <div className="lc-mb">
          <label className="dl-field">
            <span>Reason</span>
            <select className="dl-input" value={reason} onChange={(e) => setReason(e.target.value)}>
              {Object.keys(REASONS).map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="dl-field">
            <span>Notes <b style={{ color: 'var(--red)' }}>*</b></span>
            <textarea className="dl-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="What happened on the call…" />
            {!notes.trim() && <em className="dl-hint" style={{ color: 'var(--red)' }}>⚠ Notes are required.</em>}
          </label>
          <p className="dl-note" style={{ margin: 0 }}>
            {isReject ? 'Invalid number — this lead moves to Rejected.' : `Follow-up will be set for ${previewDate(mins)}.`}
          </p>
        </div>
        <div className="lc-mf">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={busy || !notes.trim()}>
            {busy ? 'Saving…' : 'Log attempt'}
          </button>
        </div>
      </div>
    </div>
  );
}
