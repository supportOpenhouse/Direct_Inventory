import { useState } from 'react';
import { api } from '../api/client.js';
import { REJECT_REASONS, stageLabel, todayISO } from '../utils/format.js';
import { IconClose } from './icons.jsx';

const TARGET_STAGES = [
  { value: 'qualified',         label: 'Qualified (back to top)' },
  { value: 'call_not_received', label: 'Call Not Received' },
  { value: 'follow_up',         label: 'Follow Up' },
  { value: 'rejected',          label: 'Rejected' },
];

/**
 * Cancel a scheduled visit. Forwards to /api/visits/cancel which talks to the
 * Forms app, clears visit columns on our row, and moves the lead to the picked
 * target stage. A non-empty reason is mandatory — it lands in activity_log.
 */
export default function CancelVisitModal({ item, onCancelled, onClose }) {
  const [reason, setReason] = useState('');
  const [targetStage, setTargetStage] = useState('qualified');
  const [followUp, setFollowUp] = useState('');
  const [stageReason, setStageReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const needsDate   = targetStage === 'call_not_received' || targetStage === 'follow_up';
  const needsReject = targetStage === 'rejected';

  async function submit() {
    setError(null);
    const trimmed = reason.trim();
    if (!trimmed) { setError('Please tell us why this visit is being cancelled.'); return; }
    if (needsDate && !followUp) { setError(`Pick a ${stageLabel(targetStage)} date.`); return; }
    if (needsReject && !stageReason) { setError('Pick a reject reason.'); return; }
    const body = {
      oh_id:        item.oh_id,
      reason:       trimmed,
      target_stage: targetStage,
    };
    if (needsDate)   body.follow_up_at = followUp;
    if (needsReject) body.stage_reason = stageReason;
    try {
      setBusy(true);
      const r = await api.post('/api/visits/cancel', body);
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

        <label style={{ marginTop: 14 }}>Move lead to</label>
        <select value={targetStage} onChange={(e) => setTargetStage(e.target.value)} disabled={busy}>
          {TARGET_STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        {needsDate && (
          <div style={{ marginTop: 14 }}>
            <label>{stageLabel(targetStage)} date <span className="req">*</span></label>
            <input type="date" value={followUp} min={todayISO()} onChange={(e) => setFollowUp(e.target.value)} disabled={busy} />
          </div>
        )}
        {needsReject && (
          <div style={{ marginTop: 14 }}>
            <label>Reject reason <span className="req">*</span></label>
            <select value={stageReason} onChange={(e) => setStageReason(e.target.value)} disabled={busy}>
              <option value="">— choose —</option>
              {REJECT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
        )}

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
