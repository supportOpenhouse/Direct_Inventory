import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { displayCity, formatDateShort, rejectReasonLabel, STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';
import { PRESETS, PRESET_LABELS, downloadCSV, todayIST } from '../utils/reportFilters.js';
import { IconClose } from '../components/icons.jsx';

function StageCountPills({ counts }) {
  return Object.entries(counts).map(([s, n]) => (
    <span key={s} className="dr-count-pill"><span className="stage-dot" style={{ background: STAGE_DOT_COLOR[s] || '#94a3b8' }} />{stageLabel(s)} <strong>{n}</strong></span>
  ));
}
function StagePill({ stage, rejectReason }) {
  if (!stage) return <span className="muted">—</span>;
  const reason = stage === 'rejected' ? rejectReasonLabel(rejectReason) : '';
  return <span className="stage-inline"><span className="stage-dot" style={{ background: STAGE_DOT_COLOR[stage] || '#94a3b8' }} />{stageLabel(stage)}{reason && <span className="stage-reason"> ({reason})</span>}</span>;
}
function fmtTime(iso) { return iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''; }

function DayLeadsModal({ email, date, onClose }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true; setLoading(true);
    api.get(`/api/activity/user-report/leads?email=${encodeURIComponent(email)}&date=${date}`)
      .then((r) => { if (alive) setLeads(r.leads || []); })
      .catch((e) => { if (alive) setError(e.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [email, date]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-day-leads" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head-row"><h3>{formatDateShort(date)}</h3><span className="role-chip">{email}</span><button className="modal-close" onClick={onClose}><IconClose /></button></div>
        {loading && <div className="al-empty">Loading…</div>}
        {error && <div className="modal-error">{error}</div>}
        {!loading && !error && leads.length === 0 && <div className="al-empty">No actions.</div>}
        {!loading && leads.length > 0 && (
          <div className="dr-table-wrap">
            <table className="dr-table">
              <thead><tr><th>Time</th><th>OH-ID</th><th>Society</th><th>City</th><th>Seller</th><th>From</th><th>Final</th><th>Current</th><th>Latest note</th></tr></thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.oh_id}>
                    <td>{fmtTime(l.last_change_at)}</td><td className="inv-td-id">{l.oh_id}</td><td>{l.society || '—'}</td><td>{displayCity(l.city) || '—'}</td><td>{l.seller_name || '—'}</td>
                    <td><StagePill stage={l.from_stage} rejectReason={l.stage_reason} /></td>
                    <td><StagePill stage={l.final_stage} rejectReason={l.stage_reason} /></td>
                    <td>{l.current_stage === l.final_stage ? <span className="muted">same</span> : <StagePill stage={l.current_stage} rejectReason={l.stage_reason} />}</td>
                    <td>{l.day_note?.body
                      ? <span className="inv-clip" title={`${l.day_note.author_name || l.day_note.author_email || ''}${l.day_note.author_name || l.day_note.author_email ? ': ' : ''}${l.day_note.body}`}>{l.day_note.body}</span>
                      : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReportDetail() {
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const paramEmail = (searchParams.get('email') || '').toLowerCase();
  const email = (user?.role !== 'rm' && paramEmail) ? paramEmail : (user?.email || '').toLowerCase();
  const isOwn = email === (user?.email || '').toLowerCase();

  const [from, setFrom] = useState(searchParams.get('from') || todayIST());
  const [to, setTo] = useState(searchParams.get('to') || todayIST());
  const [preset, setPreset] = useState('custom');
  const [data, setData] = useState({ email, actor_name: null, days: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [openDay, setOpenDay] = useState(null);

  async function refresh() {
    if (!email) { setError('email is required'); setLoading(false); return; }
    setLoading(true); setError(null);
    try { setData(await api.get(`/api/activity/user-report/days?${new URLSearchParams({ email, from, to })}`)); }
    catch (e) { setError(e.data?.error || e.message); } finally { setLoading(false); }
  }
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, []);

  function applyPreset(name) { const { from: f, to: t } = PRESETS[name](); setFrom(f); setTo(t); setPreset(name); }
  function onDate(field, val) { setPreset('custom'); if (field === 'from') setFrom(val); else setTo(val); }

  const totals = useMemo(() => { let a = 0; for (const d of data.days) a += d.total; return { days: data.days.length, actions: a }; }, [data]);
  const allStages = useMemo(() => { const s = new Set(); for (const d of data.days) for (const k of Object.keys(d.counts)) s.add(k); return [...s].sort(); }, [data]);

  function exportCSV() {
    const headers = ['Date', 'Actions', ...allStages.map(stageLabel)];
    const rows = data.days.map((d) => [d.day, d.total, ...allStages.map((s) => d.counts[s] || 0)]);
    const safe = (data.actor_name || email).replace(/[^a-z0-9]+/gi, '_');
    downloadCSV(`report_${safe}_${from}_to_${to}.csv`, headers, rows);
  }

  return (
    <div>
      <div className="al-head">
        <div><h2 className="al-title">{isOwn ? 'My Report' : (data.actor_name || email)}{data.actor_role && <span className="role-chip dr-role">{data.actor_role}</span>}</h2><div className="al-subtitle">{email}</div></div>
        <div className="al-result-count">{totals.days} days · {data.unique_leads || 0} unique leads · {totals.actions} actions</div>
      </div>

      <div className="ur-filters">
        <div className="ur-preset-row">{Object.keys(PRESET_LABELS).map((k) => <button key={k} type="button" className={preset === k ? 'pill pill-on' : 'pill'} onClick={() => applyPreset(k)}>{PRESET_LABELS[k]}</button>)}</div>
        <div className="al-date-range"><span className="al-date-lbl">FROM</span><input type="date" className="al-date" value={from} onChange={(e) => onDate('from', e.target.value)} max={todayIST()} /><span className="al-date-sep">to</span><input type="date" className="al-date" value={to} onChange={(e) => onDate('to', e.target.value)} max={todayIST()} /></div>
        <button className="btn-primary" onClick={refresh} disabled={loading}>{loading ? 'Loading…' : 'Apply'}</button>
        <button className="btn-ghost" onClick={exportCSV} disabled={loading || data.days.length === 0}>Download CSV</button>
      </div>

      {error && <div className="modal-error">{error}</div>}
      {!loading && data.days.length === 0 && !error && <div className="al-empty">No stage changes in the selected range.</div>}

      <div className="ur-day-list">
        {data.days.map((d) => (
          <button key={d.day} type="button" className="ur-day-row" onClick={() => setOpenDay(d.day)}>
            <div className="ur-day-date"><strong>{formatDateShort(d.day)}</strong></div>
            <div className="dr-user-counts"><span className="dr-total">{d.total} actions</span><StageCountPills counts={d.counts} /></div>
          </button>
        ))}
      </div>

      {openDay && <DayLeadsModal email={email} date={openDay} onClose={() => setOpenDay(null)} />}
    </div>
  );
}
