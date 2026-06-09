import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { STAGES, SUPPLY_STAGES, STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';

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

  useEffect(() => {
    let alive = true;
    api.get('/api/home/task-tracking')
      .then((r) => { if (alive) setUsers(r.users || []); })
      .catch(() => { if (alive) setUsers([]); })
      .finally(() => { if (alive) setLoading(false); });
    api.get('/api/home/rm-stage-counts')
      .then((r) => { if (alive) setRmCounts(r.users || []); })
      .catch(() => { if (alive) setRmCounts([]); })
      .finally(() => { if (alive) setLoadingCounts(false); });
    return () => { alive = false; };
  }, []);

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

  const cols = 3;
  return (
    <div>
      <div className="page-head">
        <h2>Track Tasks</h2>
        <div className="ph-sub">Today's task progress for users with new leads assigned today.</div>
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
        <div className="ph-sub">All leads per RM, broken down by stage.</div>
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
        </table>
      </div>
    </div>
  );
}
