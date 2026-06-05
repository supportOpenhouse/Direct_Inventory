import { useEffect, useState } from 'react';
import { api } from '../api/client.js';

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

  useEffect(() => {
    let alive = true;
    api.get('/api/home/task-tracking')
      .then((r) => { if (alive) setUsers(r.users || []); })
      .catch(() => { if (alive) setUsers([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

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
                  <div className="inv-td-muted" style={{ fontWeight: 400, fontSize: 12 }}>{u.email}{u.role ? ` · ${u.role}` : ''}</div>
                </td>
                <td><ProgressCell worked={u.task1_worked} total={u.total} /></td>
                <td><ProgressCell worked={u.task2_worked} total={u.total} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
