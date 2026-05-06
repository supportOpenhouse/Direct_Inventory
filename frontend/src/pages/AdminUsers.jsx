import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { CITIES } from '../utils/format.js';

const ROLES = ['admin', 'manager', 'rm'];

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ email: '', name: '', phone: '', role: 'rm', cities: [] });
  const [error, setError] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api.get('/api/users');
      setUsers(r.items);
    } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); }, []);

  function toggleCity(c) {
    setDraft((p) => ({
      ...p,
      cities: p.cities.includes(c) ? p.cities.filter((x) => x !== c) : [...p.cities, c],
    }));
  }

  async function add() {
    setError(null);
    try {
      await api.post('/api/users', draft);
      setDraft({ email: '', name: '', phone: '', role: 'rm', cities: [] });
      refresh();
    } catch (e) { setError(e.data?.error || e.message); }
  }

  async function patch(id, body) {
    try { await api.patch(`/api/users/${id}`, body); refresh(); }
    catch (e) { alert(e.data?.error || e.message); }
  }

  return (
    <div className="admin-page">
      <h2>Users</h2>

      <div className="card-block">
        <h3>Add user</h3>
        <div className="form-grid">
          <div><label>Email</label><input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="someone@openhouse.in" /></div>
          <div><label>Name</label><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <div><label>Phone</label><input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></div>
          <div><label>Role</label>
            <select value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div className="form-wide">
            <label>Cities</label>
            <div className="city-pills">
              {CITIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={draft.cities.includes(c) ? 'pill pill-on' : 'pill'}
                  onClick={() => toggleCity(c)}
                >{c}</button>
              ))}
            </div>
          </div>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <div className="modal-actions"><button className="btn-primary" onClick={add}>Add user</button></div>
      </div>

      <div className="card-block">
        <h3>All users</h3>
        {loading ? <div>Loading…</div> : (
          <table className="data-table">
            <thead><tr><th>Email</th><th>Name</th><th>Phone</th><th>Role</th><th>Cities</th><th>Active</th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>{u.name || '—'}</td>
                  <td>{u.phone || '—'}</td>
                  <td>
                    <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td>{(u.cities || []).join(', ') || '—'}</td>
                  <td>
                    <input type="checkbox" checked={!!u.is_active}
                      onChange={(e) => patch(u.id, { is_active: e.target.checked })} />
                  </td>
                  <td></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
