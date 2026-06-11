import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { displayCity } from '../utils/format.js';
import { IconClose } from './icons.jsx';
import { emitTicketsChanged } from './TicketModal.jsx';

function rmLabel(rm) {
  if (!rm) return '—';
  return rm.name || rm.email || `#${rm.id}`;
}

/**
 * Raise a ticket. Two modes:
 *   • On a property — search inventory, pick one; the assigned RM is resolved
 *     automatically from the property.
 *   • Direct to RM — no property; pick the RM the ticket is for.
 * Admin/manager only (the topbar button is gated). Managers may only target RMs
 * on their own team (the backend enforces this too).
 */
export default function CreateTicketModal({ onClose, onCreated }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [mode, setMode] = useState('property'); // 'property' | 'direct'
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Property search
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState(null); // chosen inventory item
  const searchTimer = useRef(null);

  // Direct-to-RM
  const [rms, setRms] = useState([]);
  const [rmId, setRmId] = useState('');

  // Load RMs once (for the direct picker). Managers only see their own team.
  useEffect(() => {
    let alive = true;
    api.get('/api/users?role=rm')
      .then((r) => {
        let items = (r.items || []).filter((u) => u.is_active !== false);
        if (!isAdmin) items = items.filter((u) => u.manager === user?.id);
        if (alive) setRms(items);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [isAdmin, user?.id]);

  // Debounced property search.
  useEffect(() => {
    if (mode !== 'property') return undefined;
    if (picked) return undefined; // already chosen
    const term = q.trim();
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!term) { setResults([]); return undefined; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get(`/api/inventory?q=${encodeURIComponent(term)}&limit=10`);
        setResults(r.items || []);
      } catch { setResults([]); }
      finally { setSearching(false); }
    }, 250);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [q, mode, picked]);

  const pickedRm = picked ? (picked.assigned_rms && picked.assigned_rms[0]) : null;
  const pickedHasRm = picked ? ((picked.assigned_rm_ids && picked.assigned_rm_ids.length) || pickedRm) : false;

  async function submit() {
    setError(null);
    if (!title.trim()) { setError('Title is required'); return; }
    const payload = { title: title.trim(), summary: summary.trim() };
    if (mode === 'property') {
      if (!picked) { setError('Choose a property'); return; }
      if (!pickedHasRm) { setError('This property has no assigned RM'); return; }
      payload.oh_id = picked.oh_id;
    } else {
      if (!rmId) { setError('Choose an RM'); return; }
      payload.rm_id = Number(rmId);
    }
    try {
      setSaving(true);
      const created = await api.post('/api/tickets', payload);
      emitTicketsChanged();
      onCreated?.(created);
      onClose();
    } catch (e) {
      setError(e?.data?.error || e?.message || 'Failed to create ticket');
    } finally { setSaving(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row">
          <h3>New Ticket</h3>
          <button className="modal-close" onClick={onClose}><IconClose /></button>
        </div>

        <div className="tk-mode-toggle">
          <button type="button" className={mode === 'property' ? 'on' : ''} onClick={() => setMode('property')}>On a property</button>
          <button type="button" className={mode === 'direct' ? 'on' : ''} onClick={() => setMode('direct')}>Direct to RM</button>
        </div>

        {mode === 'property' ? (
          <div style={{ marginTop: 6 }}>
            <label>Property</label>
            {picked ? (
              <div className="tk-picked">
                <div>
                  <strong>{picked.society || '—'}</strong>
                  <span className="muted"> · {displayCity(picked.city)} · {picked.oh_id}</span>
                </div>
                <div className="tk-picked-rm">
                  {pickedHasRm
                    ? <>RM: <strong>{rmLabel(pickedRm) !== '—' ? rmLabel(pickedRm) : `#${picked.assigned_rm_ids[0]}`}</strong> <span className="muted">(auto)</span></>
                    : <span className="tk-warn">No assigned RM — pick another property</span>}
                </div>
                <button type="button" className="btn-link" onClick={() => { setPicked(null); setResults([]); }}>Change</button>
              </div>
            ) : (
              <>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search society, OH id, tower, seller…" autoFocus />
                {searching && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Searching…</div>}
                {!searching && q.trim() && results.length === 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>No matches.</div>}
                {results.length > 0 && (
                  <ul className="tk-search-list">
                    {results.map((it) => (
                      <li key={it.oh_id}>
                        <button type="button" className="tk-search-row" onClick={() => { setPicked(it); }}>
                          <span className="tk-sr-soc">{it.society || '—'}</span>
                          <span className="tk-sr-meta">{displayCity(it.city)} · {it.oh_id} · RM: {rmLabel(it.assigned_rms && it.assigned_rms[0]) === '—' ? 'Unassigned' : rmLabel(it.assigned_rms[0])}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 6 }}>
            <label>RM</label>
            <select value={rmId} onChange={(e) => setRmId(e.target.value)}>
              <option value="">— choose an RM —</option>
              {rms.map((u) => <option key={u.id} value={String(u.id)}>{u.name || u.email}</option>)}
            </select>
            {rms.length === 0 && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>No RMs available.</div>}
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <label>Title <span className="req">*</span></label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short summary of the issue" />
        </div>
        <div style={{ marginTop: 14 }}>
          <label>Details</label>
          <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} placeholder="Add any context for the RM (optional)" />
        </div>

        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions">
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={saving}>{saving ? <><span className="btn-spinner" />Creating…</> : 'Create Ticket'}</button>
        </div>
      </div>
    </div>
  );
}
