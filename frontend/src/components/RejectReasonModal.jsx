import { useState } from 'react';
import { rejectReasonsForStage } from '../utils/format.js';
import { IconClose } from './icons.jsx';

export default function RejectReasonModal({ ohId, stage, onSelect, onClose }) {
  const reasons = rejectReasonsForStage(stage);
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
        <div className="modal-head-row"><h3>Reject reason{ohId ? ` — ${ohId}` : ''}</h3><button className="modal-close" onClick={onClose}><IconClose /></button></div>
        <p className="modal-sub">Pick one before this lead moves to Rejected.</p>
        <label>Reason</label>
        <select autoFocus value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">— choose —</option>
          {reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>
        <div className="modal-actions"><span style={{ flex: 1 }} /><button className="btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button><button className="btn-primary" onClick={confirm} disabled={!reason || submitting}>{submitting ? 'Saving…' : 'Confirm'}</button></div>
      </div>
    </div>
  );
}
