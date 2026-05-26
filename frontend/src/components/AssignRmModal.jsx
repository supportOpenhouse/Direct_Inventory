import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';

/**
 * Multi-select RM assignment modal — admin opens this from the "Assigned RM"
 * row on the property popup. Lets the user pick zero, one, or several active
 * RMs for the property; submits as PUT /api/inventory/<oh_id>/assigned-rms.
 *
 * `initialRmIds`: the row's current assigned_rm_ids (so existing picks are
 * pre-checked when the modal opens).
 */
export default function AssignRmModal({ ohId, initialRmIds, onClose, onSaved }) {
  const [rms, setRms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set(initialRmIds || []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    api.get('/api/users?role=rm')
      .then((r) => {
        if (!alive) return;
        const items = (r.items || []).filter((u) => u.is_active);
        items.sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
        setRms(items);
      })
      .catch((e) => { if (alive) setError(e?.data?.error || e?.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rms;
    return rms.filter((u) =>
      (u.name || '').toLowerCase().includes(q)
      || (u.email || '').toLowerCase().includes(q));
  }, [rms, query]);

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function save() {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const r = await api.put(
        `/api/inventory/${ohId}/assigned-rms`,
        { rm_ids: Array.from(selected) },
      );
      onSaved(r.item);
    } catch (e) {
      setError(e?.data?.error || e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-assign-rm" onClick={(e) => e.stopPropagation()}>
        <div className="card-detail-head">
          <div className="card-detail-title">
            <strong>Assign RM(s)</strong>
            <span className="muted" style={{ fontSize: 12 }}>{ohId}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <input
          type="text"
          placeholder="Search by name or email…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ar-search"
          autoFocus
        />

        <div className="ar-list">
          {loading && <div className="muted ar-empty">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="muted ar-empty">No matching RMs.</div>
          )}
          {!loading && filtered.map((u) => (
            <label key={u.id} className="ar-item" title={u.email}>
              <input
                type="checkbox"
                checked={selected.has(u.id)}
                onChange={() => toggle(u.id)}
              />
              <span className="ar-item-name">{u.name || u.email}</span>
            </label>
          ))}
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <span className="muted" style={{ flex: 1, fontSize: 12 }}>
            {selected.size} selected
          </span>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
