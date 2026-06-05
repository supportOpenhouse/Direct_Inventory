import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { REJECT_REASONS, STAGES, stageLabel, todayISO } from '../utils/format.js';

/**
 * Floating bar shown in select-mode with ≥1 rows selected. Supports: change
 * stage (with reject-reason picker), assign RM, set follow-up date, toggle
 * priority. One POST /api/inventory/bulk-update for the whole selection.
 */
export default function BulkActionBar({ selected, role, onCleared, onDone }) {
  const [action, setAction] = useState('');     // 'stage' | 'assign_rm' | 'follow_up' | 'priority_on' | 'priority_off'
  const [stage, setStage] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [rms, setRms] = useState([]);
  const [rmId, setRmId] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const canSetPriority = ['admin', 'manager', 'rm'].includes(role);

  useEffect(() => {
    api.get('/api/users?role=rm').then((r) => setRms(r.items || [])).catch(() => setRms([]));
  }, []);

  async function submit() {
    setError(null);
    const oh_ids = Array.from(selected);
    if (!oh_ids.length) return;
    const updates = {};
    if (action === 'stage') {
      if (!stage) { setError('Pick a stage'); return; }
      if (stage === 'visit_scheduled') { setError('Visit Scheduled needs the per-row modal'); return; }
      updates.stage = stage;
      if (stage === 'rejected') {
        if (!rejectReason) { setError('Pick a reject reason'); return; }
        updates.stage_reason = rejectReason;
      }
    } else if (action === 'assign_rm') {
      if (!rmId) { setError('Pick an RM'); return; }
      updates.assigned_rm_ids = [Number(rmId)]; // replaces any existing assignment
    } else if (action === 'follow_up') {
      if (!followUp) { setError('Pick a follow-up date'); return; }
      updates.follow_up_at = followUp;
    } else if (action === 'priority_on') {
      updates.priority = true;
    } else if (action === 'priority_off') {
      updates.priority = false;
    } else {
      setError('Pick an action'); return;
    }
    try {
      setSubmitting(true);
      const r = await api.post('/api/inventory/bulk-update', { oh_ids, updates });
      onDone(r);
    } catch (e) {
      setError(e.data?.error || e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bulk-bar">
      <span className="bulk-count">{selected.size} selected</span>

      <select value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="">— action —</option>
        <option value="stage">Change Stage</option>
        <option value="assign_rm">Assign RM</option>
        <option value="follow_up">Set Follow-Up Date</option>
        {canSetPriority && <option value="priority_on">Mark Priority</option>}
        {canSetPriority && <option value="priority_off">Unmark Priority</option>}
      </select>

      {action === 'stage' && (
        <>
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">— stage —</option>
            {STAGES.filter((s) => s !== 'visit_scheduled').map((s) => (
              <option key={s} value={s}>{stageLabel(s)}</option>
            ))}
          </select>
          {stage === 'rejected' && (
            <select value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}>
              <option value="">— reason —</option>
              {REJECT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          )}
        </>
      )}

      {action === 'assign_rm' && (
        <select value={rmId} onChange={(e) => setRmId(e.target.value)}>
          <option value="">— RM —</option>
          {rms.map((u) => (
            <option key={u.id} value={u.id}>{u.name || u.email}</option>
          ))}
        </select>
      )}

      {action === 'follow_up' && (
        <input type="date" value={followUp} min={todayISO()} onChange={(e) => setFollowUp(e.target.value)} />
      )}

      <button className="btn-primary" disabled={submitting || !action} onClick={submit}>
        {submitting ? 'Applying…' : 'Apply'}
      </button>
      <button className="btn-ghost" onClick={onCleared} disabled={submitting}>Cancel</button>
      {error && <span className="bulk-error">{error}</span>}
    </div>
  );
}
