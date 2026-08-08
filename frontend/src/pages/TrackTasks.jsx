import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { STAGES, SUPPLY_STAGES, STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';
import { todayIST } from '../utils/reportFilters.js';
import AssignNewLeadsButton from '../components/AssignNewLeadsButton.jsx';

// Two-line column headers to keep columns narrow. 2-word labels split one word
// per line; these 3-word labels split at a custom point.
const STAGE_HEADER_OVERRIDE = {
  call_not_received: ['Call Not', 'Received'],
  token_to_ama: ['Token', 'to AMA'],
  rejected_post_visit: ['Rejected', 'Post Visit'],
  cancelled_post_token: ['Cancelled', 'Post Token'],
};
function stageHeaderLines(stage) {
  if (STAGE_HEADER_OVERRIDE[stage]) return STAGE_HEADER_OVERRIDE[stage];
  const words = stageLabel(stage).split(' ');
  return words.length === 2 ? words : [stageLabel(stage)];
}

// A worked/total progress meter — orange while in progress, green when done.
function ProgressCell({ worked, total }) {
  const pct = total > 0 ? Math.round((worked / total) * 100) : 0;
  const done = total > 0 && worked >= total;
  return (
    <div className="tt-prog">
      <div className="tt-prog-bar">
        <div className="tt-prog-fill" style={{ width: `${pct}%`, background: done ? '#16a34a' : '#f97316' }} />
      </div>
      <span className="tt-prog-num">
        <strong>{worked}</strong> / {total}
        <span className="muted"> · {pct}%</span>
        {done && <span className="tt-done">✓</span>}
      </span>
    </div>
  );
}

// Admin-only overview of today's task progress, per assigned user.
export default function TrackTasks() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [rmCounts, setRmCounts] = useState([]);
  const [loadingCounts, setLoadingCounts] = useState(true);
  // "Assigned at" range filter for the RM Lead Counts table (empty = all-time).
  const [assignedFrom, setAssignedFrom] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [month, setMonth] = useState('');   // selected 'YYYY-MM' from the dropdown ('' = custom/none)

  // Last 12 months for the "Choose month" dropdown. Months outside the current
  // year get a "'YY" suffix (e.g. Dec '25); each maps to that month's full range.
  const monthOptions = useMemo(() => {
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const cy = now.getFullYear();
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(cy, now.getMonth() - i, 1);
      const y = d.getFullYear();
      const m = d.getMonth();
      const mm = String(m + 1).padStart(2, '0');
      const lastDay = String(new Date(y, m + 1, 0).getDate()).padStart(2, '0');
      return {
        value: `${y}-${mm}`,
        label: MON[m] + (y !== cy ? ` '${String(y).slice(2)}` : ''),
        from: `${y}-${mm}-01`,
        to: `${y}-${mm}-${lastDay}`,
      };
    });
  }, []);
  function pickMonth(v) {
    setMonth(v);
    const o = monthOptions.find((x) => x.value === v);
    setAssignedFrom(o ? o.from : '');
    setAssignedTo(o ? o.to : '');
  }

  const loadTasks = useCallback(() => api.get('/api/home/task-tracking')
    .then((r) => setUsers(r.users || []))
    .catch(() => setUsers([]))
    .finally(() => setLoading(false)), []);
  const loadCounts = useCallback(() => {
    const p = new URLSearchParams();
    if (assignedFrom) p.set('assigned_from', assignedFrom);
    if (assignedTo) p.set('assigned_to', assignedTo);
    const qs = p.toString();
    setLoadingCounts(true);
    return api.get(`/api/home/rm-stage-counts${qs ? `?${qs}` : ''}`)
      .then((r) => setRmCounts(r.users || []))
      .catch(() => setRmCounts([]))
      .finally(() => setLoadingCounts(false));
  }, [assignedFrom, assignedTo]);
  // Latest loadCounts, callable from the mount effect without making it a dep
  // (which would re-run the auto-assign every time the date range changes).
  const loadCountsRef = useRef(loadCounts);
  loadCountsRef.current = loadCounts;

  // Counts refetch whenever the range changes (and on mount).
  useEffect(() => { loadCounts(); }, [loadCounts]);

  useEffect(() => {
    let alive = true;
    loadTasks();
    // Auto-assign unassigned leads when this tab opens. Only fires when there's
    // actual work, and the 15-min server cooldown still gates it (a 429 just
    // means it ran recently → silently ignored, no spam). Refresh the tables
    // only if a run actually assigned rows.
    (async () => {
      try {
        const c = await api.get('/api/inventory/counts?rm_id=none');
        if (!alive || !(c?.total > 0)) return;
        const r = await api.post('/api/inventory/assign-missing', { mode: 'missing' });
        if (alive && r?.updated > 0) { loadTasks(); loadCountsRef.current(); }
      } catch { /* cooldown 429 / transient — silent */ }
    })();
    return () => { alive = false; };
  }, [loadTasks]);

  // Columns = the stages that actually appear, in canonical board → supply order.
  const stageCols = useMemo(() => {
    const present = new Set();
    rmCounts.forEach((u) => Object.keys(u.counts || {}).forEach((s) => present.add(s)));
    const canon = [...STAGES, ...SUPPLY_STAGES];
    const ordered = canon.filter((s) => present.has(s));
    const extra = [...present].filter((s) => !canon.includes(s));
    return [...ordered, ...extra];
  }, [rmCounts]);

  // RM-column sort for the RM Lead Counts table. null = backend order (total desc).
  const [rmSort, setRmSort] = useState(null);
  const sortedRmCounts = useMemo(() => {
    if (!rmSort) return rmCounts;
    return [...rmCounts].sort((a, b) => {
      const an = (a.name || a.email || '').toLowerCase();
      const bn = (b.name || b.email || '').toLowerCase();
      return rmSort === 'asc' ? an.localeCompare(bn) : bn.localeCompare(an);
    });
  }, [rmCounts, rmSort]);

  // Column totals across all RMs, for the TOTAL footer row.
  const totalsRow = useMemo(() => {
    const byStage = {};
    let total = 0;
    for (const u of rmCounts) {
      total += u.total || 0;
      for (const s of Object.keys(u.counts || {})) byStage[s] = (byStage[s] || 0) + u.counts[s];
    }
    return { total, byStage };
  }, [rmCounts]);

  const cols = 3;
  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Track Tasks</h2>
          <div className="ph-sub">Today's task progress for users with new leads assigned today.</div>
        </div>
        <span className="toolbar-spacer" />
        <AssignNewLeadsButton />
      </div>

      <div className="inv-table-wrap">
        <table className="inv-table">
          <thead>
            <tr>
              <th className="inv-th">User</th>
              <th className="inv-th">Task 1 · Leads → Active</th>
              <th className="inv-th">Task 2 · Active → Qualified</th>
            </tr>
          </thead>
          <tbody>
            {loading && Array.from({ length: 6 }).map((_, r) => (
              <tr className="inv-row" key={`s${r}`}>{Array.from({ length: cols }).map((__, c) => <td key={c}><span className="inv-skel" /></td>)}</tr>
            ))}
            {!loading && users.length === 0 && (
              <tr><td className="inv-empty" colSpan={cols}>No users have leads created today.</td></tr>
            )}
            {!loading && users.map((u) => (
              <tr className="inv-row" key={u.id}>
                <td className="inv-td-society">
                  {u.name || u.email}
                  <div className="inv-td-muted" style={{ fontWeight: 400, fontSize: 12 }}>
                    {u.unassigned ? 'Leads with no RM assigned' : `${u.email || ''}${u.role ? ` · ${u.role}` : ''}`}
                  </div>
                </td>
                <td><ProgressCell worked={u.task1_worked} total={u.total} /></td>
                <td><ProgressCell worked={u.task2_worked} total={u.total} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="page-head" style={{ marginTop: 28 }}>
        <h2>RM Lead Counts</h2>
        <div className="ph-sub"></div>
        <span className="page-head-spacer" />
        <div className="al-date-range">
          <span className="al-date-lbl">ASSIGNED AT</span>
          <select className="role-select al-month" value={month} onChange={(e) => pickMonth(e.target.value)} aria-label="Choose month">
            <option value="">Choose month…</option>
            {monthOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input type="date" className="al-date" value={assignedFrom} max={assignedTo || todayIST()} onChange={(e) => { setAssignedFrom(e.target.value); setMonth(''); }} aria-label="Assigned from" />
          <span className="al-date-sep">to</span>
          <input type="date" className="al-date" value={assignedTo} min={assignedFrom} max={todayIST()} onChange={(e) => { setAssignedTo(e.target.value); setMonth(''); }} aria-label="Assigned to" />
          {(assignedFrom || assignedTo) && <button type="button" className="btn-link" onClick={() => { setAssignedFrom(''); setAssignedTo(''); setMonth(''); }}>Clear</button>}
        </div>
      </div>

      <div className="inv-table-wrap">
        <table className="inv-table">
          <thead>
            <tr>
              <th className="inv-th">
                <button type="button" className="th-sort" onClick={() => setRmSort((d) => (d === 'asc' ? 'desc' : 'asc'))}>
                  RM {rmSort === 'asc' ? '▲' : rmSort === 'desc' ? '▼' : '⇅'}
                </button>
              </th>
              <th className="inv-th inv-th-right">Total</th>
              {stageCols.map((s) => (
                <th key={s} className="inv-th inv-th-right" title={stageLabel(s)}
                  style={{ color: STAGE_DOT_COLOR[s] || '#94a3b8' }}>
                  {stageHeaderLines(s).map((ln, i) => (
                    <div key={i} className="rmlc-hline">{ln}</div>
                  ))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loadingCounts && Array.from({ length: 6 }).map((_, r) => (
              <tr className="inv-row" key={`sc${r}`}>{Array.from({ length: stageCols.length + 2 }).map((__, c) => <td key={c}><span className="inv-skel" /></td>)}</tr>
            ))}
            {!loadingCounts && rmCounts.length === 0 && (
              <tr><td className="inv-empty" colSpan={stageCols.length + 2}>No RMs with assigned leads.</td></tr>
            )}
            {!loadingCounts && sortedRmCounts.map((u) => (
              <tr className="inv-row" key={u.id}>
                <td className="inv-td-society">{u.name || u.email}</td>
                <td className="inv-td-num"><strong>{u.total}</strong></td>
                {stageCols.map((s) => (
                  <td key={s} className="inv-td-num">{u.counts?.[s] || 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
          {!loadingCounts && rmCounts.length > 0 && (
            <tfoot>
              <tr className="rmlc-total">
                <td>Total</td>
                <td className="inv-td-num">{totalsRow.total}</td>
                {stageCols.map((s) => <td key={s} className="inv-td-num">{totalsRow.byStage[s] || 0}</td>)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
