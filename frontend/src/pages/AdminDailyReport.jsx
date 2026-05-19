import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { formatDateShort, stageLabel, STAGE_DOT_COLOR } from '../utils/format.js';

function todayIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 - now.getTimezoneOffset()) * 60_000);
  return ist.toISOString().slice(0, 10);
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function StagePill({ stage }) {
  if (!stage) return <span className="muted">—</span>;
  return (
    <span className="stage-inline">
      <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[stage] || '#94a3b8' }} />
      {stageLabel(stage)}
    </span>
  );
}

export default function AdminDailyReport() {
  const [date, setDate] = useState(todayIST());
  const [data, setData] = useState({ date: '', users: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh(d = date) {
    setLoading(true);
    setError(null);
    try {
      const r = await api.get(`/api/activity/daily-report?date=${d}`);
      setData(r);
    } catch (e) {
      setError(e.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(date); /* eslint-disable-next-line */ }, []);

  const totals = useMemo(() => {
    const t = { leads: 0, users: data.users.length };
    for (const u of data.users) t.leads += u.total;
    return t;
  }, [data]);

  return (
    <div className="admin-page daily-report-page">
      <div className="al-head">
        <div>
          <h2 className="al-title">Daily Report</h2>
          <div className="al-subtitle">
            Final stage each user left every lead in, for the selected IST day.
          </div>
        </div>
        <div className="al-result-count">
          {totals.users} user{totals.users === 1 ? '' : 's'} · {totals.leads} lead{totals.leads === 1 ? '' : 's'}
        </div>
      </div>

      <div className="al-filters">
        <div className="al-date-range">
          <span className="al-date-lbl">DATE:</span>
          <input
            type="date"
            className="al-date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            max={todayIST()}
          />
        </div>
        <button className="btn-primary" onClick={() => refresh(date)} disabled={loading}>
          {loading ? 'Loading…' : 'Apply'}
        </button>
      </div>

      {error && <div className="modal-error">{error}</div>}

      {!loading && data.users.length === 0 && !error && (
        <div className="al-empty">No stage changes on {formatDateShort(data.date)}.</div>
      )}

      {data.users.map((u) => (
        <section key={u.actor_email} className="dr-user">
          <header className="dr-user-head">
            <div>
              <strong>{u.actor_name || u.actor_email}</strong>
              {u.actor_role && <span className="role-chip dr-role">{u.actor_role}</span>}
              <div className="dr-user-email">{u.actor_email}</div>
            </div>
            <div className="dr-user-counts">
              <span className="dr-total">{u.total} lead{u.total === 1 ? '' : 's'}</span>
              {Object.entries(u.counts).map(([s, n]) => (
                <span key={s} className="dr-count-pill">
                  <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[s] || '#94a3b8' }} />
                  {stageLabel(s)} <strong>{n}</strong>
                </span>
              ))}
            </div>
          </header>

          <table className="dr-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>OH-ID</th>
                <th>Society</th>
                <th>City</th>
                <th>From</th>
                <th>Final (set by user)</th>
                <th>Current</th>
              </tr>
            </thead>
            <tbody>
              {u.leads.map((l) => (
                <tr key={l.oh_id}>
                  <td className="dr-time">{formatTime(l.last_change_at)}</td>
                  <td className="dr-id">{l.oh_id}</td>
                  <td>{l.society || '—'}</td>
                  <td>{l.city || '—'}</td>
                  <td><StagePill stage={l.from_stage} /></td>
                  <td><StagePill stage={l.final_stage} /></td>
                  <td>
                    {l.current_stage === l.final_stage
                      ? <span className="muted">same</span>
                      : <StagePill stage={l.current_stage} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
