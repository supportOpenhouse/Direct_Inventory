import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { formatDateShort, REJECT_REASONS, STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';
import { PRESETS, PRESET_LABELS, downloadCSV, todayIST } from '../utils/reportFilters.js';

function StageCountPills({ counts }) {
  return Object.entries(counts).map(([s, n]) => (
    <span key={s} className="dr-count-pill">
      <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[s] || '#94a3b8' }} />
      {stageLabel(s)} <strong>{n}</strong>
    </span>
  ));
}

function rejectReasonLabel(code) {
  if (!code) return '';
  return REJECT_REASONS.find((r) => r.value === code)?.label || code;
}

function StagePill({ stage, rejectReason }) {
  if (!stage) return <span className="muted">—</span>;
  const reasonLabel = stage === 'rejected' ? rejectReasonLabel(rejectReason) : '';
  return (
    <span className="stage-inline">
      <span className="stage-dot" style={{ background: STAGE_DOT_COLOR[stage] || '#94a3b8' }} />
      {stageLabel(stage)}
      {reasonLabel && <span className="stage-reason"> ({reasonLabel})</span>}
    </span>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// Drill-down: leads list for one (user, day). Fetched lazily when the modal
// opens — the day list endpoint only returns counts, not full lead rows.
function DayLeadsModal({ email, date, onClose }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.get(`/api/activity/user-report/leads?email=${encodeURIComponent(email)}&date=${date}`)
      .then((r) => { if (alive) setLeads(r.leads || []); })
      .catch((e) => { if (alive) setError(e.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [email, date]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-day-leads" onClick={(e) => e.stopPropagation()}>
        <div className="card-detail-head">
          <div className="card-detail-title">
            <strong>{formatDateShort(date)}</strong>
            <span className="oh-id">{email}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {loading && <div className="al-empty">Loading…</div>}
        {error && <div className="modal-error">{error}</div>}
        {!loading && !error && leads.length === 0 && (
          <div className="al-empty">No leads.</div>
        )}
        {!loading && leads.length > 0 && (
          <table className="dr-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>OH-ID</th>
                <th>Society</th>
                <th>City</th>
                <th>Seller</th>
                <th>From</th>
                <th>Final (set by user)</th>
                <th>Current</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.oh_id}>
                  <td className="dr-time">{formatTime(l.last_change_at)}</td>
                  <td className="dr-id">{l.oh_id}</td>
                  <td>{l.society || '—'}</td>
                  <td>{l.city || '—'}</td>
                  <td>{l.seller_name || '—'}</td>
                  <td><StagePill stage={l.from_stage} rejectReason={l.reject_reason} /></td>
                  <td><StagePill stage={l.final_stage} rejectReason={l.reject_reason} /></td>
                  <td>
                    {l.current_stage === l.final_stage
                      ? <span className="muted">same</span>
                      : <StagePill stage={l.current_stage} rejectReason={l.reject_reason} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function AdminUserReportDetail() {
  const [searchParams] = useSearchParams();
  const email = searchParams.get('email') || '';
  const initFrom = searchParams.get('from') || todayIST();
  const initTo = searchParams.get('to') || todayIST();

  const [from, setFrom] = useState(initFrom);
  const [to, setTo] = useState(initTo);
  const [preset, setPreset] = useState('custom');
  const [data, setData] = useState({ email, actor_name: null, days: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openDay, setOpenDay] = useState(null);

  async function refresh() {
    if (!email) { setError('email is required'); setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ email, from, to });
      const r = await api.get(`/api/activity/user-report/days?${params}`);
      setData(r);
    } catch (e) {
      setError(e.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  useEffect(() => {
    const title = data.actor_name ? `${data.actor_name} — User Report` : 'User Report';
    document.title = title;
  }, [data.actor_name]);

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
    for (const d of data.days) leads += d.total;
    return { days: data.days.length, leads };
  }, [data]);

  const allStages = useMemo(() => {
    const s = new Set();
    for (const d of data.days) for (const k of Object.keys(d.counts)) s.add(k);
    return Array.from(s).sort();
  }, [data]);

  function exportCSV() {
    const headers = ['Date', 'Total Leads', ...allStages.map(stageLabel)];
    const rows = data.days.map((d) => [
      d.day,
      d.total,
      ...allStages.map((s) => d.counts[s] || 0),
    ]);
    const safeName = (data.actor_name || email).replace(/[^a-z0-9]+/gi, '_');
    downloadCSV(`user-report_${safeName}_${data.from}_to_${data.to}.csv`, headers, rows);
  }

  return (
    <div className="admin-page daily-report-page user-report-page">
      <div className="al-head">
        <div>
          <h2 className="al-title">
            {data.actor_name || email}
            {data.actor_role && <span className="role-chip dr-role">{data.actor_role}</span>}
          </h2>
          <div className="al-subtitle">{email}</div>
        </div>
        <div className="al-result-count">
          {totals.days} day{totals.days === 1 ? '' : 's'} · {totals.leads} lead{totals.leads === 1 ? '' : 's'}
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
        <button className="btn-primary" onClick={refresh} disabled={loading}>
          {loading ? 'Loading…' : 'Apply'}
        </button>
        <button
          className="btn-ghost"
          onClick={exportCSV}
          disabled={loading || data.days.length === 0}
        >
          Download CSV
        </button>
      </div>

      {error && <div className="modal-error">{error}</div>}

      {!loading && data.days.length === 0 && !error && (
        <div className="al-empty">No stage changes by this user in the selected range.</div>
      )}

      <div className="ur-day-list">
        {data.days.map((d) => (
          <button
            key={d.day}
            type="button"
            className="ur-day-row"
            onClick={() => setOpenDay(d.day)}
            title="Click for lead-level detail"
          >
            <div className="ur-day-date">
              <strong>{formatDateShort(d.day)}</strong>
            </div>
            <div className="dr-user-counts">
              <span className="dr-total">{d.total} lead{d.total === 1 ? '' : 's'}</span>
              <StageCountPills counts={d.counts} />
            </div>
          </button>
        ))}
      </div>

      {openDay && (
        <DayLeadsModal email={email} date={openDay} onClose={() => setOpenDay(null)} />
      )}
    </div>
  );
}
