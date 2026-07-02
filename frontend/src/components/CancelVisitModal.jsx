import { useState } from 'react';
import { api } from '../api/client.js';
import { REJECT_REASONS } from '../utils/format.js';
import { IconClose } from './icons.jsx';

/**
 * Cancel a scheduled visit. The lead ALWAYS moves to Rejected (with a reason).
 * The old qualified / call-not-received / follow-up targets were removed: those
 * are active-pipeline stages, and the supply-sync would revert them back to
 * visit_scheduled from a lingering cp_inventory_status visit date. Rejected is
 * the clean terminal outcome. Forwards to /api/visits/cancel — talks to the
 * Forms app, clears our visit columns, sets stage=rejected + stage_reason.
 * A non-empty cancel reason is mandatory (it lands in activity_log).
 */
export default function CancelVisitModal({ item, onCancelled, onClose }) {
  const [reason, setReason] = useState('');
  const [stageReason, setStageReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    const trimmed = reason.trim();
    if (!trimmed) { setError('Please tell us why this visit is being cancelled.'); return; }
    if (!stageReason) { setError('Pick a reject reason.'); return; }
    try {
      setBusy(true);
      const r = await api.post('/api/visits/cancel', {
        oh_id:        item.oh_id,
        reason:       trimmed,
        target_stage: 'rejected',
        stage_reason: stageReason,
      });
      onCancelled?.(r);
      onClose();
    } catch (e) {
      // Surface the Forms-app response when the 502 comes from a Forms reject
      // (deploy lag, validation, etc.) so we don't have to guess from a generic
      // "forms app rejected cancel".
      const top = e.data?.error || e.message || 'Failed to cancel visit';
      const fs  = e.data?.forms_status;
      const fr  = e.data?.forms_response;
      let detail = '';
      if (fr && typeof fr === 'object') detail = fr.error || JSON.stringify(fr);
      else if (typeof fr === 'string')  detail = fr;
      setError(detail ? `${top}${fs ? ` (Forms ${fs})` : ''}: ${detail}` : top);
    } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row">
          <h3>Cancel Visit</h3>
          <span className="role-chip">{item.oh_id}</span>
          <button className="modal-close" onClick={onClose}><IconClose /></button>
        </div>
        <p className="modal-sub">{item.society || '—'}</p>

        <label>Why are you cancelling? <span className="req">*</span></label>
        <textarea
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="A short note — e.g. seller postponed, exec unavailable, …"
          disabled={busy}
        />

        <p className="modal-sub" style={{ marginTop: 14 }}>Cancelling a visit moves the lead to <strong>Rejected</strong>.</p>
        <label>Reject reason <span className="req">*</span></label>
        <select value={stageReason} onChange={(e) => setStageReason(e.target.value)} disabled={busy}>
          <option value="">— choose —</option>
          {REJECT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
        </select>

        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Keep Visit</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? <><span className="btn-spinner" />Cancelling…</> : 'Cancel Visit'}
          </button>
        </div>
      </div>
    </div>
  );
}
