import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { CITIES, foldCities } from '../utils/format.js';

const ALL_ASSIGNED = '__assigned__';
const ALL_DATA = '__all__';

// Lazy — MapLibre is heavy and only needed when a coverage map is shown.
const ScopeMap = lazy(() => import('../components/ScopeMap.jsx'));

function initials(name, email) {
  const s = (name || (email || '').split('@')[0] || '').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase() || '?';
}

const SCOPE_LIMIT = 5;

function ScopeList({ label, items }) {
  const [expanded, setExpanded] = useState(false);
  const list = items || [];
  const overflow = list.length - SCOPE_LIMIT;
  const shown = expanded ? list : list.slice(0, SCOPE_LIMIT);
  return (
    <div className="pf-scope">
      <label>{label}</label>
      {list.length === 0 ? (
        <div className="muted">—</div>
      ) : (
        <ul className="pf-scope-list">
          {shown.map((x) => <li key={x}>{x}</li>)}
          {!expanded && overflow > 0 && (
            <li><button type="button" className="pf-more" onClick={() => setExpanded(true)} title={`Show ${overflow} more`}>… ({overflow} more)</button></li>
          )}
          {expanded && overflow > 0 && (
            <li><button type="button" className="pf-more" onClick={() => setExpanded(false)}>show less</button></li>
          )}
        </ul>
      )}
    </div>
  );
}

export default function MyProfile() {
  const { user } = useAuth();
  const isAdminViewer = user?.role === 'admin';

  const [me, setMe] = useState(null);          // own profile — always the LEFT side
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Admin "view as" — only feeds the coverage MAP, never the left side.
  const [people, setPeople] = useState([]);
  const [viewId, setViewId] = useState('');
  const [mapProfile, setMapProfile] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    api.get('/api/users/profile')
      .then((r) => { if (alive) setMe(r); })
      .catch((e) => { if (alive) setError(e.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!isAdminViewer) return;
    api.get('/api/users').then((r) => setPeople((r.items || []).filter((u) => u.role !== 'admin'))).catch(() => setPeople([]));
  }, [isAdminViewer]);

  useEffect(() => {
    if (!isAdminViewer || !viewId || viewId === ALL_ASSIGNED || viewId === ALL_DATA) { setMapProfile(null); return undefined; }
    let alive = true;
    setMapProfile(null); // clear old user's data immediately → show loading while fetching
    api.get(`/api/users/profile?user_id=${viewId}`)
      .then((r) => { if (alive) setMapProfile(r); })
      .catch(() => { if (alive) setMapProfile(null); });
    return () => { alive = false; };
  }, [isAdminViewer, viewId]);

  // Union of all RMs' assigned scope — for "View all assigned".
  const assignedScope = useMemo(() => {
    const rms = people.filter((u) => u.role === 'rm');
    const uniq = (a) => [...new Set(a)];
    return {
      cities: foldCities(uniq(rms.flatMap((u) => u.cities || []))),
      society: uniq(rms.flatMap((u) => u.society || [])),
      micro_market: uniq(rms.flatMap((u) => u.micro_market || [])),
    };
  }, [people]);

  if (loading) return <div className="al-empty">Loading…</div>;
  if (error) return <div className="modal-error">{error}</div>;
  if (!me) return null;

  const p = me;                       // left side = own profile (unchanged by "view as")
  const { role } = p;
  const cityList = foldCities(p.cities);
  const showTeam = role === 'admin' || role === 'manager';
  const showScope = role === 'manager' || role === 'rm';

  // What the coverage map shows: { cities, society, plotAll, label }.
  let mapScope = null;
  if (!isAdminViewer) {
    if (role === 'manager' || role === 'rm') mapScope = { cities: cityList, society: p.society || [], micro_market: p.micro_market || [], label: '' };
  } else if (viewId === ALL_DATA) {
    mapScope = { cities: CITIES, society: [], micro_market: [], plotAll: true, label: 'All data' };
  } else if (viewId === ALL_ASSIGNED) {
    mapScope = { cities: assignedScope.cities, society: assignedScope.society, micro_market: assignedScope.micro_market, label: 'All assigned (RMs)' };
  } else if (mapProfile && (mapProfile.role === 'manager' || mapProfile.role === 'rm')) {
    mapScope = { cities: foldCities(mapProfile.cities), society: mapProfile.society || [], micro_market: mapProfile.micro_market || [], label: mapProfile.name || mapProfile.email };
  }
  const showMap = !!mapScope;

  const detailsCard = (
    <div className="card-block">
      <div className="pf-head">
        <span className="pf-avatar">{initials(p.name, p.email)}</span>
        <div>
          <div className="pf-name">{p.name || '—'} <span className="role-chip">{role}</span></div>
          <div className="muted">{p.email}</div>
        </div>
      </div>

      <div className="pf-grid">
        <div className="pf-field"><label>Name</label><div>{p.name || '—'}</div></div>
        <div className="pf-field"><label>Email</label><div>{p.email}</div></div>
        <div className="pf-field"><label>Phone</label><div>{p.phone || '—'}</div></div>
        <div className="pf-field"><label>Role</label><div style={{ textTransform: 'capitalize' }}>{role}</div></div>
        {(role === 'manager' || role === 'rm') && (
          <div className="pf-field"><label>My Manager</label>
            <div>{p.manager ? (p.manager.name || p.manager.email) : <span className="muted">—</span>}</div>
          </div>
        )}
      </div>

      {showScope && (
        <div className="pf-scope-row">
          {(role === 'manager' || role === 'rm') && <ScopeList label="My City" items={cityList} />}
          {role === 'rm' && <ScopeList label="My Micro-market" items={p.micro_market} />}
          {role === 'rm' && <ScopeList label="My Society" items={p.society} />}
        </div>
      )}
    </div>
  );

  const teamCard = showTeam && (
    <div className="card-block">
      <h3>My Team <span className="muted">{p.team?.length || 0}</span></h3>
      {(!p.team || p.team.length === 0)
        ? <p className="muted">No one reports to you yet.</p>
        : (
          <table className="data-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {p.team.map((m) => (
                <tr key={m.id}>
                  <td>{m.name || '—'}</td>
                  <td>{m.email}</td>
                  <td style={{ textTransform: 'capitalize' }}>{m.role}</td>
                  <td>{m.is_active ? 'Active' : <span className="muted">Inactive</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );

  const adminBar = isAdminViewer && (
    <div className="card-block pov-bar">
      <label>Map — view as</label>
      <select value={viewId} onChange={(e) => setViewId(e.target.value)} className="role-select">
        <option value="">— select a user —</option>
        <option value={ALL_ASSIGNED}>View all assigned</option>
        <option value={ALL_DATA}>View all data</option>
        {people.map((u) => <option key={u.id} value={u.id}>{u.name || u.email} · {u.role}</option>)}
      </select>
    </div>
  );

  const mapCard = showMap ? (
    <div className="card-block scope-card">
      <h3>Coverage map
        {isAdminViewer && mapScope.label && <span className="muted"> — {mapScope.label}</span>}
        <span className="muted"> · approximate</span>
      </h3>
      <Suspense fallback={<div className="scope-map-skeleton">Loading map…</div>}>
        <ScopeMap cities={mapScope.cities} society={mapScope.society} micro_market={mapScope.micro_market || []} plotAll={!!mapScope.plotAll} />
      </Suspense>
    </div>
  ) : isAdminViewer && (
    // Admin with nothing selected — keep the map's place with a skeletal box.
    <div className="card-block scope-card">
      <h3>Coverage map</h3>
      <div className="scope-map-skeleton">
        {viewId ? 'Loading…' : 'Select a user or view option above to show the coverage map.'}
      </div>
    </div>
  );

  return (
    <div className="profile-page">
      <div className="profile-grid2">
        <div className="profile-col">{detailsCard}{teamCard}</div>
        <div className="profile-col">{adminBar}{mapCard}</div>
      </div>
    </div>
  );
}
