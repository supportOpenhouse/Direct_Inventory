import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';

export default function VisitScheduleModal({ item, onClose, onScheduled }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [execs, setExecs] = useState([]);
  const [execPhone, setExecPhone] = useState('');
  const [loadingExecs, setLoadingExecs] = useState(true);
  // Admin-only — pick which manager/RM the visit is being scheduled on
  // behalf of. Required for the Forms app to attribute the assignment.
  const [assignees, setAssignees] = useState([]);
  const [assignedBy, setAssignedBy] = useState('');
  const [loadingAssignees, setLoadingAssignees] = useState(isAdmin);
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

  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    // Pulled from properties.users — same source the Forms app validates
    // assigned_by against — so we can only ever pick an email it will accept.
    api.get('/api/visits/assignees')
      .then((r) => { if (alive) setAssignees(r.items || []); })
      .catch((e) => { if (alive) setError(`Couldn't load assignees: ${e.data?.error || e.message}`); })
      .finally(() => { if (alive) setLoadingAssignees(false); });
    return () => { alive = false; };
  }, [isAdmin]);

  async function submit() {
    setError(null);
    if (!date || !time || !execPhone) {
      setError('Date, Time and Field Exec are required');
      return;
    }
    if (isAdmin && !assignedBy) {
      setError('Pick who this visit is assigned by');
      return;
    }
    try {
      setSubmitting(true);
      const r = await api.post('/api/visits/schedule', {
        oh_id: item.oh_id,
        schedule_date: date,
        schedule_time: time,
        field_exec_phone: execPhone,
        ...(isAdmin ? { assigned_by_email: assignedBy } : {}),
      });
      onScheduled(r);
    } catch (e) {
      // 409: backend detected a visit already exists. Don't show the raw
      // error — surface the existing details and close gracefully.
      if (e.status === 409 && e.data?.existing_visit) {
        const ev = e.data.existing_visit;
        const when = ev.visit_at ? new Date(ev.visit_at).toLocaleString() : 'previously';
        alert(`Visit already scheduled for ${item.oh_id} on ${when}.\nNo new request was sent.`);
        onClose();
        return;
      }
      // Forms-side slot conflict: the field exec already has a booking at this
      // time. Tell the user to pick something else and show Forms' suggestions.
      const fr = e.data?.forms_response;
      if (e.data?.forms_status === 409 && fr && typeof fr === 'object' && fr.error === 'Slot conflict') {
        const lines = ['Choose a different time or date.'];
        if (fr.message) lines.push(fr.message);
        if (Array.isArray(fr.suggested_times) && fr.suggested_times.length) {
          lines.push(`Suggested times: ${fr.suggested_times.join(', ')}`);
        }
        setError(lines.join(' '));
        return;
      }
      const parts = [e.data?.error || e.message];
      if (e.data?.forms_status) parts.push(`(status ${e.data.forms_status})`);
      if (fr) {
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

        {isAdmin ? (
          <>
            <label>Assigned By <span className="req">*</span></label>
            <select
              value={assignedBy}
              onChange={(e) => setAssignedBy(e.target.value)}
              disabled={loadingAssignees}
            >
              <option value="">{loadingAssignees ? 'Loading…' : 'Select manager / RM…'}</option>
              {assignees.map((u) => (
                <option key={u.id} value={u.email}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
          </>
        ) : (
          <div className="assigned-by">
            Assigned by: <strong>{user?.name || user?.email || '—'}</strong>
          </div>
        )}

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
