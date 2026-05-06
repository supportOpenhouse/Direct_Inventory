import { useState } from 'react';
import { api } from '../api/client.js';

export default function VisitScheduleModal({ item, onClose, onScheduled }) {
  const [scheduledAt, setScheduledAt] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    if (!scheduledAt || !phone) {
      setError('Both fields are required');
      return;
    }
    try {
      setSubmitting(true);
      const r = await api.post('/api/visits/schedule', {
        oh_id: item.oh_id,
        scheduled_at: new Date(scheduledAt).toISOString(),
        field_exec_phone: phone,
      });
      onScheduled(r);
    } catch (e) {
      setError(e.data?.error || e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Schedule visit — {item.oh_id}</h3>
        <p className="modal-sub">{item.society} · {item.locality} · {item.city}</p>
        <label>Scheduled at</label>
        <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
        <label>Field executive phone</label>
        <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit phone" />
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Scheduling…' : 'Schedule visit'}
          </button>
        </div>
      </div>
    </div>
  );
}
