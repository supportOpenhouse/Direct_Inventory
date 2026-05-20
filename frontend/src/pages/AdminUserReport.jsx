import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';
import { PRESETS, PRESET_LABELS, downloadCSV, todayIST } from '../utils/reportFilters.js';

// Multiselect dropdown — closes on outside click, shows selected count in
// the button label.
function UserMultiSelect({ options, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const label = value.length === 0
    ? 'All users'
    : value.length === 1
      ? (options.find((o) => o.email === value[0])?.name || value[0])
      : `${value.length} users`;

  function toggle(email) {
    if (value.includes(email)) onChange(value.filter((e) => e !== email));
    else onChange([...value, email]);
  }

  return (
    <span className="ur-multi" ref={ref}>
      <button type="button" className="ur-multi-btn" onClick={() => setOpen((s) => !s)}>
        {label} <span className="ur-caret">▾</span>
      </button>
      {open && (
        <div className="ur-multi-menu">
          {value.length > 0 && (
            <button type="button" className="ur-multi-clear" onClick={() => onChange([])}>
              Clear ({value.length})
            </button>
          )}
          {options.length === 0 && <div className="ur-multi-empty">No users.</div>}
          {options.map((o) => (
            <label key={o.email} className="ur-multi-item">
              <input
                type="checkbox"
                checked={value.includes(o.email)}
                onChange={() => toggle(o.email)}
              />
              <span>{o.name || o.email}</span>
              {o.role && <span className="role-chip ur-multi-role">{o.role}</span>}
            </label>
          ))}
        </div>
      )}
    </span>
  );
}

function StageCountPills({ counts }) {
  return Object.entries(counts).map(([s, n]) => (
    <span key={s} className="dr-count-pill">
      <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[s] || '#94a3b8' }} />
      {stageLabel(s)} <strong>{n}</strong>
    </span>
  ));
}

export default function AdminUserReport() {
  const { user } = useAuth();
  const isManager = user?.role === 'manager';
  // Default view is "All" — every user, all dates.
  const [from, setFrom] = useState(() => PRESETS.all().from);
  const [to, setTo] = useState(() => PRESETS.all().to);
  const [preset, setPreset] = useState('all');
  const [users, setUsers] = useState([]);              // selected emails
  const [allUsers, setAllUsers] = useState([]);        // dropdown options
  const [data, setData] = useState({ from: '', to: '', users: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function loadUserOptions() {
    try {
      const r = await api.get('/api/users');
      let items = (r.items || []).filter((u) => u.is_active);
      // A manager filters/drills only within their own RMs.
      if (isManager) items = items.filter((u) => u.manager === user?.id);
      setAllUsers(items.map((u) => ({ email: u.email, name: u.name, role: u.role })));
    } catch { /* non-blocking */ }
  }

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ from, to });
      if (users.length) params.set('users', users.join(','));
      const r = await api.get(`/api/activity/user-report?${params}`);
      setData(r);
    } catch (e) {
      setError(e.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadUserOptions(); refresh(); /* eslint-disable-next-line */ }, []);

  function applyPreset(name) {
    const { from: f, to: t } = PRESETS[name]();
    setFrom(f); setTo(t); setPreset(name);
  }

  function onDateChange(field, val) {
    setPreset('custom');
    if (field === 'from') setFrom(val); else setTo(val);
  }

  const totals = useMemo(() => {
    let leads = 0;
    for (const u of data.users) leads += u.total;
    return { users: data.users.length, leads };
  }, [data]);

  // Stable list of all distinct stages across the current result set — used
  // as the CSV's column order so every row has the same shape.
  const allStages = useMemo(() => {
    const s = new Set();
    for (const u of data.users) for (const k of Object.keys(u.counts)) s.add(k);
    return Array.from(s).sort();
  }, [data]);

  function exportCSV() {
    const headers = ['Actor Email', 'Actor Name', 'Role', 'Total Leads', 'Days Active', ...allStages.map(stageLabel)];
    const rows = data.users.map((u) => [
      u.actor_email,
      u.actor_name || '',
      u.actor_role || '',
      u.total,
      u.days_active,
      ...allStages.map((s) => u.counts[s] || 0),
    ]);
    const name = `user-report_${data.from}_to_${data.to}.csv`;
    downloadCSV(name, headers, rows);
  }

  function userDetailHref(email) {
    const p = new URLSearchParams({ email, from, to });
    return `/admin/user-report/detail?${p.toString()}`;
  }

  return (
    <div className="admin-page daily-report-page user-report-page">
      <div className="al-head">
        <div>
          <h2 className="al-title">User Report</h2>
          <div className="al-subtitle">
            {isManager ? 'Your RMs — per-user' : 'Per-user'} summary of stage moves.
            Click a user to drill down by day.
          </div>
        </div>
        <div className="al-result-count">
          {totals.users} user{totals.users === 1 ? '' : 's'} · {totals.leads} lead{totals.leads === 1 ? '' : 's'}
        </div>
      </div>

      <div className="ur-filters">
        <div className="ur-preset-row">
          {Object.keys(PRESET_LABELS).map((k) => (
            <button
              key={k}
              type="button"
              className={preset === k ? 'pill pill-on' : 'pill'}
              onClick={() => applyPreset(k)}
            >{PRESET_LABELS[k]}</button>
          ))}
        </div>
        <div className="al-date-range">
          <span className="al-date-lbl">FROM</span>
          <input type="date" className="al-date" value={from} onChange={(e) => onDateChange('from', e.target.value)} max={todayIST()} />
          <span className="al-date-sep">to</span>
          <input type="date" className="al-date" value={to} onChange={(e) => onDateChange('to', e.target.value)} max={todayIST()} />
        </div>
        <UserMultiSelect options={allUsers} value={users} onChange={setUsers} />
        <button className="btn-primary" onClick={refresh} disabled={loading}>
          {loading ? 'Loading…' : 'Apply'}
        </button>
        <button
          className="btn-ghost"
          onClick={exportCSV}
          disabled={loading || data.users.length === 0}
          title="Download visible rows as CSV"
        >
          Download CSV
        </button>
      </div>

      {error && <div className="modal-error">{error}</div>}

      {!loading && data.users.length === 0 && !error && (
        <div className="al-empty">No stage changes for the selected range.</div>
      )}

      <div className="ur-user-list">
        {data.users.map((u) => (
          <a
            key={u.actor_email}
            href={userDetailHref(u.actor_email)}
            target="_blank"
            rel="noreferrer"
            className="ur-user-card"
          >
            <div className="dr-user-head">
              <div>
                <strong>{u.actor_name || u.actor_email}</strong>
                {u.actor_role && <span className="role-chip dr-role">{u.actor_role}</span>}
                <div className="dr-user-email">{u.actor_email}</div>
              </div>
              <div className="dr-user-counts">
                <span className="dr-total">{u.total} lead{u.total === 1 ? '' : 's'}</span>
                <span className="dr-count-pill">{u.days_active} day{u.days_active === 1 ? '' : 's'} active</span>
                <StageCountPills counts={u.counts} />
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
