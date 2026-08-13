import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useModalExit } from '../utils/useModalExit.js';
import { IconClose } from './icons.jsx';

// 8am–9pm in 30-min slots (same set the schedule modal offers). value = 24h
// HH:MM sent to the backend; label is 12-hour for display.
const TIME_SLOTS = (() => {
  const slots = [];
  for (let m = 8 * 60; m <= 21 * 60; m += 30) {
    const h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, '0');
    const h12 = h % 12 === 0 ? 12 : h % 12;
    slots.push({ value: `${String(h).padStart(2, '0')}:${mm}`, label: `${h12}:${mm} ${h < 12 ? 'AM' : 'PM'}` });
  }
  return slots;
})();

const todayISO = () => new Date().toISOString().slice(0, 10);

// The lead's current visit date/time, split into IST parts to prefill the form.
function istParts(iso) {
  if (!iso) return { date: '', time: '10:00' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: '', time: '10:00' };
  return {
    date: d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),                       // YYYY-MM-DD
    time: d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }), // HH:MM
  };
}

/**
 * Reassign / reschedule a visit_scheduled lead to a new date/time — prefilled
 * with the current visit, editable further. POSTs to /api/visits/reschedule,
 * which forwards to the Forms app (calendar + WhatsApp re-notify) and updates
 * visit_at. The lead stays in visit_scheduled.
 */
export default function RescheduleVisitModal({ item, onRescheduled, onClose: rawClose }) {
  const { onClose, backdropClass } = useModalExit(rawClose);
  const pre = istParts(item.visit_at);
  const currentExec = item.visit_exec || '';
  const [date, setDate] = useState(pre.date);
  const [time, setTime] = useState(pre.time || '10:00');
  const [exec, setExec] = useState(currentExec);   // field exec, by name (Forms wants the name)
  const [execs, setExecs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Keep the prefilled time selectable even if it isn't on a 30-min slot.
  const slots = TIME_SLOTS.some((s) => s.value === time) ? TIME_SLOTS : [{ value: time, label: time }, ...TIME_SLOTS];

  useEffect(() => {
    let alive = true;
    api.get('/api/visits/field-execs').then((r) => { if (alive) setExecs(r.items || []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Exec options by name; keep the current one selectable even if inactive.
  const execNames = execs.map((u) => u.name).filter(Boolean);
  const execList = currentExec && !execNames.includes(currentExec) ? [currentExec, ...execNames] : execNames;

  async function submit() {
    setError(null);
    if (!date) { setError('Pick a new date.'); return; }
    try {
      setBusy(true);
      const payload = { oh_id: item.oh_id, schedule_date: date, schedule_time: time };
      // Only send field_exec when it actually changed — omitting = pure reschedule.
      if (exec && exec !== currentExec) payload.field_exec = exec;
      const r = await api.post('/api/visits/reschedule', payload);
      onRescheduled?.(r);
      onClose();
    } catch (e) {
      // Surface the Forms-app validation message when it bubbles up.
      setError(e?.data?.forms_response?.error || e?.data?.error || e?.message || 'Reschedule failed.');
    } finally { setBusy(false); }
  }

  return (
    <div className={backdropClass} onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row">
          <h3>Reschedule Visit</h3>
          <span className="role-chip">{item.oh_id}</span>
          <button className="modal-close" onClick={onClose}><IconClose /></button>
        </div>
        <p className="modal-sub">{item.society || '—'}</p>
        <div className="form-grid">
          <div><label>New date</label><input type="date" min={todayISO()} value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div><label>New time</label>
            <select value={time} onChange={(e) => setTime(e.target.value)}>
              {slots.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="form-wide-2"><label>Field exec <span className="muted">(change to reassign)</span></label>
            <select value={exec} onChange={(e) => setExec(e.target.value)}>
              {!currentExec && <option value="">— keep current —</option>}
              {execList.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Close</button>
          <button className="btn-primary" onClick={submit} disabled={busy}>{busy ? <><span className="btn-spinner" />Rescheduling…</> : 'Reschedule'}</button>
        </div>
      </div>
    </div>
  );
}
