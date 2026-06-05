import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { STAGES, STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';
import { PRESETS, PRESET_LABELS, downloadCSV, todayIST } from '../utils/reportFilters.js';
import UserReportAnalytics from '../components/UserReportAnalytics.jsx';

function UserMultiSelect({ options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const label = value.length === 0 ? 'All users' : value.length === 1 ? (options.find((o) => o.email === value[0])?.name || value[0]) : `${value.length} users`;
  function toggle(email) { onChange(value.includes(email) ? value.filter((e) => e !== email) : [...value, email]); }
  return (
    <span className="ur-multi" ref={ref}>
      <button type="button" className="ur-multi-btn" onClick={() => setOpen((s) => !s)}>{label} <span>▾</span></button>
      {open && (
        <div className="ur-multi-menu">
          {value.length > 0 && <button type="button" className="ur-multi-clear" onClick={() => onChange([])}>Clear ({value.length})</button>}
          {options.length === 0 && <div className="ur-multi-empty">No users.</div>}
          {options.map((o) => (
            <label key={o.email} className="ur-multi-item">
              <input type="checkbox" checked={value.includes(o.email)} onChange={() => toggle(o.email)} />
              <span>{o.name || o.email}</span>
              {o.role && <span className="role-chip ur-multi-role">{o.role}</span>}
            </label>
          ))}
        </div>
      )}
    </span>
  );
}

// Worked stages shown on every user card — always all of them, even at 0, so
// the row reads consistently. 'lead' is the intake stage (never a winner).
const REPORT_STAGES = STAGES.filter((s) => s !== 'lead' && s !== 'unqualified');

function StageCountPills({ counts }) {
  const c = counts || {};
  // Any unexpected stage present in the data (e.g. a supply stage) is appended.
  const extra = Object.keys(c).filter((s) => !REPORT_STAGES.includes(s) && s !== 'lead' && s !== 'unqualified');
  return [...REPORT_STAGES, ...extra].map((s) => {
    const n = c[s] || 0;
    return (
      <span key={s} className={`dr-count-pill ${n === 0 ? 'dr-count-zero' : ''}`}>
        <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[s] || '#94a3b8' }} />{stageLabel(s)} <strong>{n}</strong>
      </span>
    );
  });
}

export default function Report() {
  const { user } = useAuth();
  const isManager = user?.role === 'manager';
  const [from, setFrom] = useState(() => PRESETS.all().from);
  const [to, setTo] = useState(() => PRESETS.all().to);
  const [preset, setPreset] = useState('all');
  const [users, setUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [data, setData] = useState({ from: '', to: '', users: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('users');

  async function loadOptions() {
    try {
      const r = await api.get('/api/users');
      let items = (r.items || []).filter((u) => u.is_active);
      if (isManager) items = items.filter((u) => u.manager === user?.id);
      setAllUsers(items.map((u) => ({ email: u.email, name: u.name, role: u.role })));
    } catch { /* non-blocking */ }
  }
  async function refresh() {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({ from, to });
      if (users.length) params.set('users', users.join(','));
      setData(await api.get(`/api/activity/user-report?${params}`));
    } catch (e) { setError(e.data?.error || e.message); } finally { setLoading(false); }
  }
  useEffect(() => { loadOptions(); refresh(); /* eslint-disable-next-line */ }, []);

  function applyPreset(name) { const { from: f, to: t } = PRESETS[name](); setFrom(f); setTo(t); setPreset(name); }
  function onDate(field, val) { setPreset('custom'); if (field === 'from') setFrom(val); else setTo(val); }

  const totals = useMemo(() => {
    let actions = 0, uniqueLeads = 0;
    for (const u of data.users) { actions += u.total || 0; uniqueLeads += u.unique_leads || 0; }
    return { users: data.users.length, actions, uniqueLeads };
  }, [data]);
  const allStages = useMemo(() => { const s = new Set(); for (const u of data.users) for (const k of Object.keys(u.counts)) s.add(k); return [...s].sort(); }, [data]);

  function exportCSV() {
    const headers = ['Actor Email', 'Actor Name', 'Role', 'Unique Leads', 'Actions', 'Days Active', ...allStages.map(stageLabel)];
    const rows = data.users.map((u) => [u.actor_email, u.actor_name || '', u.actor_role || '', u.unique_leads || 0, u.total, u.days_active, ...allStages.map((s) => u.counts[s] || 0)]);
    downloadCSV(`user-report_${data.from}_to_${data.to}.csv`, headers, rows);
  }
  function detailHref(email) { return `/report/detail?${new URLSearchParams({ email, from, to })}`; }

  return (
    <div>
      <div className="al-head">
        <div><div className="al-subtitle">{isManager ? 'Your RMs — per-user stage activity. Click to drill down.' : 'Per-user summary of stage moves. Click a user to drill down.'}</div></div>
        <div className="al-result-count">{totals.users} users · {totals.uniqueLeads} unique leads · {totals.actions} actions</div>
      </div>

      <div className="ur-filters">
        <div className="ur-preset-row">{Object.keys(PRESET_LABELS).map((k) => <button key={k} type="button" className={preset === k ? 'pill pill-on' : 'pill'} onClick={() => applyPreset(k)}>{PRESET_LABELS[k]}</button>)}</div>
        <div className="al-date-range"><span className="al-date-lbl">FROM</span><input type="date" className="al-date" value={from} onChange={(e) => onDate('from', e.target.value)} max={todayIST()} /><span className="al-date-sep">to</span><input type="date" className="al-date" value={to} onChange={(e) => onDate('to', e.target.value)} max={todayIST()} /></div>
        <UserMultiSelect options={allUsers} value={users} onChange={setUsers} />
        <button className="btn-primary" onClick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Apply'}</button>
        {tab === 'users' && <button className="btn-ghost" onClick={exportCSV} disabled={loading || data.users.length === 0}>Download CSV</button>}
      </div>

      <div className="ur-tabs">
        <button className={tab === 'users' ? 'ur-tab ur-tab-on' : 'ur-tab'} onClick={() => setTab('users')}>Users</button>
        <button className={tab === 'analytics' ? 'ur-tab ur-tab-on' : 'ur-tab'} onClick={() => setTab('analytics')}>Analytics</button>
      </div>

      {error && <div className="modal-error">{error}</div>}

      {tab === 'users' && (
        <>
          {!loading && data.users.length === 0 && !error && <div className="al-empty">No stage changes for the selected range.</div>}
          <div className="ur-user-list">
            {data.users.map((u) => (
              <a key={u.actor_email} href={detailHref(u.actor_email)} target="_blank" rel="noreferrer" className="ur-user-card">
                {/* Row 1 (name line): name + role on the left, the headline
                    counts on the right. Row 2 (email line): email left, all the
                    stage pills right — so each block lines up with its row. */}
                <div className="ur-card-row">
                  <span className="ur-card-name"><strong>{u.actor_name || u.actor_email}</strong>{u.actor_role && <span className="role-chip dr-role">{u.actor_role}</span>}</span>
                  <div className="dr-meta-row">
                    <span className="dr-total">{u.unique_leads || 0} unique</span>
                    <span className="dr-total">{u.total} actions</span>
                    <span className="dr-count-pill">{u.days_active} days active</span>
                  </div>
                </div>
                <div className="ur-card-row">
                  <span className="dr-user-email">{u.actor_email}</span>
                  <div className="dr-stage-row"><StageCountPills counts={u.counts} /></div>
                </div>
              </a>
            ))}
          </div>
        </>
      )}

      {tab === 'analytics' && <UserReportAnalytics from={data.from || from} to={data.to || to} users={users} reportData={data} />}
    </div>
  );
}
