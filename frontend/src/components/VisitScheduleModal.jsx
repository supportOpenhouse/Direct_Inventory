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
    // Combine manager + rm lists. /api/users supports a single role filter, so
    // run both in parallel and merge.
    Promise.all([
      api.get('/api/users?role=manager'),
      api.get('/api/users?role=rm'),
    ])
      .then(([m, r]) => {
        if (!alive) return;
        const items = [...(m.items || []), ...(r.items || [])]
          .filter((u) => u.is_active !== false)
          .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
        setAssignees(items);
      })
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
                  {u.name || u.email} · {u.role}
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
