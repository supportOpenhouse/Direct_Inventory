import { useState } from 'react';
import { api } from '../api/client.js';
import { rejectReasonsForStage, STAGE_DOT_COLOR, STAGES, stageLabel, todayISO } from '../utils/format.js';
import { IconClose } from './icons.jsx';
import VisitScheduleModal from './VisitScheduleModal.jsx';

/**
 * Edit-status popup — the old stage-change flow. A stage dropdown plus the
 * right sub-flow per target stage:
 *   follow_up        → follow-up date picker
 *   visit_scheduled  → opens the VisitScheduleModal (field exec, date, time…)
 *   rejected         → reject-reason dropdown
 *   others           → straight stage set
 *
 * `lead` and `active` are not selectable targets here — intake/working states
 * aren't set from this dropdown, and a lead must never be moved back to `lead`.
 */
const STAGE_OPTIONS = STAGES.filter((s) => s !== 'lead' && s !== 'active');

export default function StatusEditModal({ item, onUpdated, onClose }) {
  const [stage, setStage] = useState(item.stage);
  const [followUp, setFollowUp] = useState(item.follow_up_at ? item.follow_up_at.slice(0, 10) : '');
  const [reason, setReason] = useState(item.stage_reason || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [showVisit, setShowVisit] = useState(false);

  const needsVisit = stage === 'visit_scheduled';
  const needsReason = stage === 'rejected';
  const needsDate = stage === 'follow_up';

  const stageExcluded = !STAGE_OPTIONS.includes(stage);

  async function save() {
    setError(null);
    if (stageExcluded) { setError('Pick a stage to move to'); return; }
    if (needsVisit) { setShowVisit(true); return; }
    if (needsReason && !reason) { setError('Pick a reject reason'); return; }
    const body = { stage };
    if (needsReason) body.stage_reason = reason;
    if (needsDate) body.follow_up_at = followUp || null;
    try {
      setSaving(true);
      const r = await api.patch(`/api/inventory/${item.oh_id}`, body);
      onUpdated(r.item || { ...item, ...body });
      onClose();
    } catch (e) {
      setError(e.data?.error || e.message);
    } finally { setSaving(false); }
  }

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-head-row">
            <h3>Edit Status</h3>
            <span className="role-chip">{item.oh_id}</span>
            <button className="modal-close" onClick={onClose}><IconClose /></button>
          </div>
          <p className="modal-sub">{item.society || '—'}</p>

          <label>Stage</label>
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            {stageExcluded && <option value={stage} disabled>{stageLabel(stage)} (current)</option>}
            {STAGE_OPTIONS.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
          </select>
          <div style={{ marginTop: 6, fontSize: 12 }} className="muted">
            <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[stage] }} />
            {needsVisit ? 'Saving will open the visit scheduler.'
              : needsReason ? 'Choose a reason for rejection.'
                : needsDate ? 'Set the next follow-up date.'
                  : `Move this lead to ${stageLabel(stage)}.`}
          </div>

          {needsDate && (
            <div style={{ marginTop: 14 }}>
              <label>Follow-up date</label>
              <input type="date" value={followUp} min={todayISO()} onChange={(e) => setFollowUp(e.target.value)} />
            </div>
          )}
          {needsReason && (
            <div style={{ marginTop: 14 }}>
              <label>Reject reason <span className="req">*</span></label>
              <select value={reason} onChange={(e) => setReason(e.target.value)}>
                <option value="">— choose —</option>
                {/* Reason set depends on the lead's CURRENT stage: an unqualified
                    intake lead uses listing-quality reasons; a worked lead uses
                    the engagement reasons. */}
                {rejectReasonsForStage(item.stage).map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          )}

          {error && <div className="modal-error">{error}</div>}
          <div className="modal-actions">
            <span style={{ flex: 1 }} />
            <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn-primary" onClick={save} disabled={saving}>
              {needsVisit ? 'Schedule Visit →' : (saving ? <><span className="btn-spinner" />Saving…</> : 'Save')}
            </button>
          </div>
        </div>
      </div>

      {showVisit && (
        <VisitScheduleModal
          item={item}
          onClose={() => setShowVisit(false)}
          onScheduled={(updated) => { setShowVisit(false); onUpdated(updated && updated.oh_id ? updated : { ...item, stage: 'visit_scheduled' }); onClose(); }}
        />
      )}
    </>
  );
}
