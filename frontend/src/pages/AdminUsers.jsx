import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { CITIES } from '../utils/format.js';
import UserEditModal from '../components/UserEditModal.jsx';

const ROLES = ['admin', 'manager', 'rm'];
const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', rm: 'RM' };

// One-line summary of a user's area scope, mirroring resolution precedence:
// society > micro-market > city.
function scopeSummary(u) {
  if ((u.society || []).length) {
    return `Societies: ${u.society.length}`;
  }
  if ((u.micro_market || []).length) {
    return `Micro-markets: ${u.micro_market.length}`;
  }
  if ((u.cities || []).length) {
    return `Cities: ${u.cities.join(', ')}`;
  }
  return '—';
}

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [areas, setAreas] = useState({ cities: [], micro_markets: [], societies: [] });
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ email: '', name: '', phone: '', role: 'rm', cities: [] });
  const [error, setError] = useState(null);
  const [editUser, setEditUser] = useState(null);

  // When role flips to admin, default-select all cities. Admin needs cross-city visibility.
  function setRole(role) {
    setDraft((p) => ({
      ...p,
      role,
      cities: role === 'admin' ? [...CITIES] : p.cities,
    }));
  }

  async function refresh() {
    setLoading(true);
    try {
      const r = await api.get('/api/users');
      setUsers(r.items);
    } finally { setLoading(false); }
  }

  async function loadAreas() {
    try {
      const r = await api.get('/api/users/master-areas');
      setAreas(r);
    } catch { /* non-blocking — modal pickers just stay empty */ }
  }

  useEffect(() => { refresh(); loadAreas(); }, []);

  const managers = useMemo(
    () => users.filter((u) => u.role === 'manager').map((u) => ({ id: u.id, name: u.name, email: u.email })),
    [users],
  );

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
            <select className="role-select" value={draft.role} onChange={(e) => setRole(e.target.value)}>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
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
        <p className="page-hint">After adding, click a user below to set their manager and area scope.</p>
      </div>

      <div className="card-block">
        <h3>All users</h3>
        {loading ? <div>Loading…</div> : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th><th>Name</th><th>Phone</th><th>Role</th>
                <th>Manager</th><th>Area scope</th><th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.is_active ? '' : 'usr-inactive'}>
                  <td>{u.email}</td>
                  <td>{u.name || '—'}</td>
                  <td>{u.phone || '—'}</td>
                  <td>
                    <select
                      className="role-select"
                      value={u.role}
                      onChange={(e) => patch(u.id, { role: e.target.value })}
                    >
                      {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </td>
                  <td>{u.manager_name || u.manager_email || <em className="muted">—</em>}</td>
                  <td className="usr-scope">{scopeSummary(u)}</td>
                  <td>
                    <button className="btn-edit" onClick={() => setEditUser(u)}>
                      <span aria-hidden="true">✎</span> Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editUser && (
        <UserEditModal
          user={editUser}
          managers={managers}
          areas={areas}
          onClose={() => setEditUser(null)}
          onSaved={() => { setEditUser(null); refresh(); }}
        />
      )}
    </div>
  );
}
