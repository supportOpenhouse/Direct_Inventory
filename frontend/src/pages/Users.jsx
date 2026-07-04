import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { CITIES } from '../utils/format.js';
import UserEditModal from '../components/UserEditModal.jsx';

const ROLES = ['admin', 'manager', 'rm'];
const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', rm: 'RM' };

function scopeSummary(u) {
  const parts = [];
  const cities = u.cities || [];
  if (cities.length) parts.push(cities.length <= 3 ? `Cities: ${cities.join(', ')}` : `Cities: ${cities.length}`);
  if ((u.micro_market || []).length) parts.push(`Micro-markets: ${u.micro_market.length}`);
  if ((u.society || []).length) parts.push(`Societies: ${u.society.length}`);
  return parts.length ? parts.join(' · ') : '—';
}

function SortTh({ field, label, sort, onSort }) {
  const active = sort.field === field;
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  return <th className={`data-th-sortable ${active ? 'data-th-active' : ''}`} onClick={() => onSort({ field, dir: active && sort.dir === 'asc' ? 'desc' : 'asc' })}>{label} <span>{arrow}</span></th>;
}

export default function Users() {
  const [users, setUsers] = useState([]);
  const [areas, setAreas] = useState({ cities: [], micro_markets: [], societies: [] });
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ email: '', name: '', phone: '', role: 'rm', cities: [] });
  const [error, setError] = useState(null);
  const [editUser, setEditUser] = useState(null);
  const [sort, setSort] = useState({ field: null, dir: 'asc' });
  const [clashes, setClashes] = useState([]);
  const [clashLoading, setClashLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);

  function setRole(role) { setDraft((p) => ({ ...p, role, cities: role === 'admin' ? [...CITIES] : p.cities })); }

  async function refresh() { setLoading(true); try { setUsers((await api.get('/api/users')).items); } finally { setLoading(false); } }
  async function loadAreas() { try { setAreas(await api.get('/api/users/master-areas')); } catch { /* non-blocking */ } }
  async function loadClashes() { setClashLoading(true); try { setClashes((await api.get('/api/users/clashed-societies')).items || []); } catch { setClashes([]); } finally { setClashLoading(false); } }
  async function recompute() { setRecomputing(true); try { await api.post('/api/users/recompute-societies', {}); await loadClashes(); } catch (e) { alert(e.data?.error || e.message); } finally { setRecomputing(false); } }
  // Users list first (fast); defer the heavier Clashed Societies fetch until
  // after it lands so it never delays the users table.
  useEffect(() => { refresh().then(loadClashes); loadAreas(); }, []);

  const managers = useMemo(() => users.filter((u) => u.role === 'manager').map((u) => ({ id: u.id, name: u.name, email: u.email })), [users]);
  const sortedUsers = useMemo(() => {
    if (!sort.field) return users;
    const keyOf = (u) => (sort.field === 'manager' ? (u.manager_name || u.manager_email || '') : (u[sort.field] ?? '')).toString().toLowerCase();
    return [...users].sort((a, b) => { const av = keyOf(a), bv = keyOf(b); if (av < bv) return sort.dir === 'asc' ? -1 : 1; if (av > bv) return sort.dir === 'asc' ? 1 : -1; return 0; });
  }, [users, sort]);

  function toggleCity(c) { setDraft((p) => ({ ...p, cities: p.cities.includes(c) ? p.cities.filter((x) => x !== c) : [...p.cities, c] })); }
  async function add() {
    setError(null);
    try { await api.post('/api/users', draft); setDraft({ email: '', name: '', phone: '', role: 'rm', cities: [] }); refresh(); }
    catch (e) { setError(e.data?.error || e.message); }
  }
  async function patch(id, body) { try { await api.patch(`/api/users/${id}`, body); refresh(); } catch (e) { alert(e.data?.error || e.message); } }

  return (
    <div>
      <div className="card-block">
        <h3>Add user</h3>
        <div className="adduser-row">
          <div className="au-field"><label>Email</label><input type="text" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} placeholder="someone@openhouse.in" /></div>
          <div className="au-field"><label>Name</label><input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
          <div className="au-field"><label>Phone</label><input type="tel" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} /></div>
        </div>
        <div className="adduser-row">
          <div className="au-role"><label>Role</label><select className="role-select" value={draft.role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></div>
          <div className="au-field"><label>Cities</label><div className="city-pills">{CITIES.map((c) => <button key={c} type="button" className={draft.cities.includes(c) ? 'pill pill-on' : 'pill'} onClick={() => toggleCity(c)}>{c}</button>)}</div></div>
          <div className="au-actions"><button className="btn-primary" onClick={add}>Add user</button></div>
        </div>
        {error && <div className="modal-error">{error}</div>}
        <p className="page-hint">After adding, click Edit to set manager and area scope.</p>
      </div>

      <div className="card-block">
        <h3>All users</h3>
        <table className="data-table">
          <thead><tr>
            <SortTh field="email" label="Email" sort={sort} onSort={setSort} />
            <SortTh field="name" label="Name" sort={sort} onSort={setSort} />
            <th>Phone</th>
            <SortTh field="role" label="Role" sort={sort} onSort={setSort} />
            <SortTh field="manager" label="Manager" sort={sort} onSort={setSort} />
            <th>Area scope</th><th />
          </tr></thead>
          <tbody>
            {loading ? (
              // Skeleton rows — headers stay visible, cells shimmer until data lands.
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={`skel-${i}`}>
                  {Array.from({ length: 7 }).map((__, c) => <td key={c}><span className="inv-skel" /></td>)}
                </tr>
              ))
            ) : (
              sortedUsers.map((u) => (
                <tr key={u.id} className={u.is_active ? '' : 'usr-inactive'}>
                  <td>{u.email}</td>
                  <td>{u.name || '—'}</td>
                  <td>{u.phone || '—'}</td>
                  <td><select className="role-select" value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></td>
                  <td>{u.manager_name || u.manager_email || <em className="muted">—</em>}</td>
                  <td><span className="usr-scope" title={scopeSummary(u)}>{scopeSummary(u)}</span></td>
                  <td><button className="btn-edit" onClick={() => setEditUser(u)}>✎ Edit</button></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="card-block">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Clashed Societies</h3>
          {!clashLoading && <span className="role-chip">{clashes.length} societ{clashes.length === 1 ? 'y' : 'ies'}</span>}
          <span className="page-hint" style={{ margin: 0 }}>Societies in more than one RM&apos;s scope — the overlaps that cause multi-RM leads.</span>
          <span style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={recompute} disabled={recomputing}>{recomputing ? 'Recomputing…' : 'Recompute scopes'}</button>
        </div>
        {clashLoading ? (
          <p className="muted">Loading…</p>
        ) : clashes.length === 0 ? (
          <p className="muted">No clashes — every society is covered by at most one RM. 🎉</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Society</th><th>Shared by (RMs)</th></tr></thead>
            <tbody>
              {clashes.map((c) => (
                <tr key={c.society}>
                  <td><strong>{c.society}</strong> <span className="muted">×{c.n}</span></td>
                  <td>{(c.rms || []).map((r) => r.name).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editUser && <UserEditModal user={editUser} managers={managers} areas={areas} onClose={() => setEditUser(null)} onSaved={() => { setEditUser(null); refresh().then(loadClashes); }} />}
    </div>
  );
}
