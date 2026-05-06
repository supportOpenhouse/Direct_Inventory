import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { CITIES } from '../utils/format.js';

export default function AdminMapping() {
  const [maps, setMaps] = useState([]);
  const [users, setUsers] = useState([]);
  const [draft, setDraft] = useState({ city: 'Noida', locality: '', society: '', rm_user_id: '', manager_user_id: '' });
  const [error, setError] = useState(null);

  async function refresh() {
    const [m, u] = await Promise.all([api.get('/api/rm-mapping'), api.get('/api/users')]);
    setMaps(m.items); setUsers(u.items);
  }
  useEffect(() => { refresh(); }, []);

  const rms = users.filter((u) => u.role === 'rm');
  const mgrs = users.filter((u) => u.role === 'manager');

  async function add() {
    setError(null);
    try {
      await api.post('/api/rm-mapping', {
        ...draft,
        rm_user_id: Number(draft.rm_user_id),
        manager_user_id: draft.manager_user_id ? Number(draft.manager_user_id) : null,
      });
      setDraft({ city: 'Noida', locality: '', society: '', rm_user_id: '', manager_user_id: '' });
      refresh();
    } catch (e) { setError(e.data?.error || e.message); }
  }

  async function remove(id) {
    if (!window.confirm('Remove this mapping?')) return;
    await api.delete(`/api/rm-mapping/${id}`);
    refresh();
  }

  return (
    <div className="admin-page">
      <h2>RM / Locality Mapping</h2>
      <p className="page-hint">Resolution: society &gt; locality &gt; city. Leave locality/society blank for a city-wide fallback.</p>

      <div className="card-block">
        <h3>Add mapping</h3>
        <div className="form-grid">
          <div><label>City</label>
            <select value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })}>
              {CITIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div><label>Locality (optional)</label><input value={draft.locality} onChange={(e) => setDraft({ ...draft, locality: e.target.value })} /></div>
          <div><label>Society (optional)</label><input value={draft.society} onChange={(e) => setDraft({ ...draft, society: e.target.value })} /></div>
          <div><label>RM</label>
            <select value={draft.rm_user_id} onChange={(e) => setDraft({ ...draft, rm_user_id: e.target.value })}>
              <option value="">— choose RM —</option>
              {rms.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          </div>
          <div><label>Manager</label>
            <select value={draft.manager_user_id} onChange={(e) => setDraft({ ...draft, manager_user_id: e.target.value })}>
              <option value="">— optional —</option>
              {mgrs.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </select>
          </div>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions"><button className="btn-primary" onClick={add}>Add mapping</button></div>
      </div>

      <div className="card-block">
        <h3>All mappings</h3>
        <table className="data-table">
          <thead><tr><th>City</th><th>Locality</th><th>Society</th><th>RM</th><th>Manager</th><th></th></tr></thead>
          <tbody>
            {maps.map((m) => (
              <tr key={m.id}>
                <td>{m.city}</td>
                <td>{m.locality || <em className="muted">—</em>}</td>
                <td>{m.society || <em className="muted">—</em>}</td>
                <td>{m.rm_name || m.rm_email}</td>
                <td>{m.mgr_name || m.mgr_email || <em className="muted">—</em>}</td>
                <td><button className="btn-link" onClick={() => remove(m.id)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
