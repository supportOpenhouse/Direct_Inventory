import { useState } from 'react';
import { REJECT_REASONS } from '../utils/format.js';

export default function RejectReasonModal({ ohId, onSelect, onClose }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  function confirm() {
    if (!reason || submitting) return;
    setSubmitting(true);
    onSelect(reason);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Reject reason{ohId ? ` — ${ohId}` : ''}</h3>
        <p className="modal-sub">Pick one before this card moves to Rejected.</p>
        <label>Reason</label>
        <select autoFocus value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">— choose —</option>
          {REJECT_REASONS.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary" onClick={confirm} disabled={!reason || submitting}>
            {submitting ? 'Saving…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}
