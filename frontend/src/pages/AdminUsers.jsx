import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { CITIES } from '../utils/format.js';
import UserEditModal from '../components/UserEditModal.jsx';

const ROLES = ['admin', 'manager', 'rm'];
const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', rm: 'RM' };

// One-line summary of a user's area scope. Now that scope levels stack
// (society + micro_market + cities can all be set on the same RM), every
// non-empty level is listed instead of just the most-specific one.
function scopeSummary(u) {
  const parts = [];
  const cities = u.cities || [];
  if (cities.length) {
    // Cities are typically few (1–3) so list them inline; for larger sets
    // fall back to a count to keep the cell readable.
    parts.push(cities.length <= 3
      ? `Cities: ${cities.join(', ')}`
      : `Cities: ${cities.length}`);
  }
  if ((u.micro_market || []).length) parts.push(`Micro-markets: ${u.micro_market.length}`);
  if ((u.society || []).length)      parts.push(`Societies: ${u.society.length}`);
  return parts.length ? parts.join(' · ') : '—';
}

// Sortable header cell for the users table.
function SortTh({ field, label, sort, onSort }) {
  const active = sort.field === field;
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  return (
    <th
      className={`data-th-sortable ${active ? 'data-th-active' : ''}`}
      onClick={() => onSort({ field, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' })}
    >
      {label} <span className="data-th-arrow">{arrow}</span>
    </th>
  );
}

export default function AdminUsers() {
  const [users, setUsers] = useState([]);
  const [reassigning, setReassigning] = useState(false);

  async function reassignAllLeads() {
    if (reassigning) return;
    const ok = window.confirm(
      'Re-run RM assignment for ALL leads?\n\n'
      + 'Every property will be re-evaluated against current users.society / '
      + 'micro_market / cities scope and reassigned where a match is found. '
      + 'Existing assignments WILL be overwritten on rows whose scope now '
      + 'belongs to a different RM. This may take 20-30 seconds.',
    );
    if (!ok) return;
    setReassigning(true);
    try {
      const r = await api.post('/api/inventory/assign-missing', { mode: 'all' });
      window.alert(
        `Done — ${r.updated} reassigned · ${r.scanned} scanned · `
        + `${r.remaining} still without an RM.`,
      );
    } catch (e) {
      window.alert('Reassign failed: ' + (e?.data?.error || e?.message || e));
    } finally {
      setReassigning(false);
    }
  }

  const [areas, setAreas] = useState({ cities: [], micro_markets: [], societies: [] });
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ email: '', name: '', phone: '', role: 'rm', cities: [] });
  const [error, setError] = useState(null);
  const [editUser, setEditUser] = useState(null);
  // null field = backend's default order (role, then email).
  const [sort, setSort] = useState({ field: null, dir: 'asc' });

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

  // Client-side sort — the user list is small and fully loaded.
  const sortedUsers = useMemo(() => {
    if (!sort.field) return users;
    const keyOf = (u) => {
      if (sort.field === 'manager') return (u.manager_name || u.manager_email || '').toLowerCase();
      return (u[sort.field] ?? '').toString().toLowerCase();
    };
    return [...users].sort((a, b) => {
      const av = keyOf(a);
      const bv = keyOf(b);
      if (av < bv) return sort.dir === 'asc' ? -1 : 1;
      if (av > bv) return sort.dir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [users, sort]);

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
      <div className="al-head">
        <h2>Users</h2>
        <button
          className="btn-ghost"
          onClick={reassignAllLeads}
          disabled={reassigning}
          title="Re-evaluate every property against the current society / micro_market / city scope and reassign RMs"
        >
          {reassigning ? 'Reassigning…' : 'Reassign Leads'}
        </button>
      </div>

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
                <SortTh field="email" label="Email" sort={sort} onSort={setSort} />
                <SortTh field="name" label="Name" sort={sort} onSort={setSort} />
                <th>Phone</th>
                <SortTh field="role" label="Role" sort={sort} onSort={setSort} />
                <SortTh field="manager" label="Manager" sort={sort} onSort={setSort} />
                <th>Area scope</th><th></th>
              </tr>
            </thead>
            <tbody>
              {sortedUsers.map((u) => (
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
