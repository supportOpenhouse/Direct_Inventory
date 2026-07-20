import { useState } from 'react';
import { api } from '../api/client.js';
import { IconClose } from './icons.jsx';
import { useModalExit } from '../utils/useModalExit.js';

/**
 * Cancel a scheduled visit. The lead moves straight to the supply-tracker
 * terminal `rejected_post_visit` with reason `visit_cancelled` — matching what
 * the supply-sync derives from cp_inventory_status, so setting it here just
 * gives immediate feedback and the sync reinforces the same value. Forwards to
 * /api/visits/cancel — talks to the Forms app, clears our visit columns, sets
 * stage. A non-empty cancel note is mandatory (it lands in activity_log).
 */
export default function CancelVisitModal({ item, onCancelled, onClose: rawClose }) {
  const { onClose, backdropClass } = useModalExit(rawClose);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    const trimmed = reason.trim();
    if (!trimmed) { setError('Please tell us why this visit is being cancelled.'); return; }
    try {
      setBusy(true);
      const r = await api.post('/api/visits/cancel', {
        oh_id:        item.oh_id,
        reason:       trimmed,
        target_stage: 'rejected_post_visit',
        stage_reason: 'visit_cancelled',
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
    <div className={backdropClass} onClick={onClose}>
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

        <p className="modal-sub" style={{ marginTop: 14 }}>
          The lead will move to <strong>Rejected Post Visit</strong> · <em>Visit Cancelled</em>.
        </p>

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
