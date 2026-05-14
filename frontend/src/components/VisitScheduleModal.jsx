import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function VisitScheduleModal({ item, onClose, onScheduled }) {
  const { user } = useAuth();
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [execs, setExecs] = useState([]);
  const [execPhone, setExecPhone] = useState('');
  const [loadingExecs, setLoadingExecs] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/api/visits/field-execs')
      .then((r) => { if (alive) setExecs(r.items || []); })
      .catch((e) => { if (alive) setError(`Couldn't load field execs: ${e.data?.error || e.message}`); })
      .finally(() => { if (alive) setLoadingExecs(false); });
    return () => { alive = false; };
  }, []);

  async function submit() {
    setError(null);
    if (!date || !time || !execPhone) {
      setError('Date, Time and Field Exec are required');
      return;
    }
    // Combine date + time as a local datetime → ISO. Backend stores it as TIMESTAMPTZ.
    const local = new Date(`${date}T${time}`);
    if (Number.isNaN(local.getTime())) {
      setError('Invalid date or time');
      return;
    }
    try {
      setSubmitting(true);
      const r = await api.post('/api/visits/schedule', {
        oh_id: item.oh_id,
        scheduled_at: local.toISOString(),
        field_exec_phone: execPhone,
      });
      onScheduled(r);
    } catch (e) {
      const parts = [e.data?.error || e.message];
      if (e.data?.forms_status) parts.push(`(status ${e.data.forms_status})`);
      if (e.data?.forms_response) {
        const fr = e.data.forms_response;
        parts.push(typeof fr === 'string' ? fr : JSON.stringify(fr));
      }
      setError(parts.filter(Boolean).join(' — '));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-visit" onClick={(e) => e.stopPropagation()}>
        <h3>Schedule Visit</h3>
        <p className="modal-sub">{item.oh_id} · {item.society || '—'}</p>

        <label>Date <span className="req">*</span></label>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

        <label>Time <span className="req">*</span></label>
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />

        <label>Field Exec <span className="req">*</span></label>
        <select
          value={execPhone}
          onChange={(e) => setExecPhone(e.target.value)}
          disabled={loadingExecs}
        >
          <option value="">{loadingExecs ? 'Loading…' : 'Select…'}</option>
          {execs.map((u) => (
            <option key={u.id} value={u.phone}>
              {u.name} {u.phone ? `(${u.phone})` : ''}
            </option>
          ))}
        </select>

        <div className="assigned-by">
          Assigned by: <strong>{user?.name || user?.email || '—'}</strong>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
