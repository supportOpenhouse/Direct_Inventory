import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { stageLabel } from '../utils/format.js';

const STAGE_ORDER = ['lead', 'active', 'qualified', 'call_not_received', 'follow_up', 'visit_scheduled', 'visit_completed', 'offer_given', 'rejected'];
const FUNNEL_STAGES = ['qualified', 'visit_scheduled', 'visit_completed', 'offer_given'];
const STAGE_COLOR = {
  lead: '#fa541c', active: '#f59e0b', qualified: '#16a34a', call_not_received: '#EF9F27', follow_up: '#f97316',
  visit_scheduled: '#a855f7', visit_completed: '#639922', offer_given: '#BA7517', rejected: '#cbd5e1',
};
function sortStages(keys) {
  return [...keys].sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a); const ib = STAGE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1; if (ib === -1) return -1; return ia - ib;
  });
}
const stageColor = (s) => STAGE_COLOR[s] || '#94a3b8';

const USER_PALETTE = ['#fa541c', '#378ADD', '#1D9E75', '#7F77DD', '#BA7517', '#dc2626', '#06b6d4', '#a855f7'];
const TOP_USERS = 8; const OTHER_KEY = '__other__';

function niceTicks(rawMax, tickCount = 4) {
  if (rawMax <= 0) return { ticks: [0, 1], niceMax: 1 };
  const rough = rawMax / tickCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const niceMax = Math.ceil(rawMax / step) * step;
  const ticks = [];
  for (let t = 0; t <= niceMax + 1e-9; t += step) ticks.push(Math.round(t));
  return { ticks, niceMax };
}

function buildSeries({ days, groupBy, userNames }) {
  if (groupBy === 'user') {
    const totals = {};
    for (const d of days) for (const [e, n] of Object.entries(d.by_user || {})) totals[e] = (totals[e] || 0) + n;
    const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, TOP_USERS); const rest = sorted.slice(TOP_USERS);
    const series = top.map(([e, total], i) => ({ key: e, label: userNames[e] || e, color: USER_PALETTE[i % USER_PALETTE.length], total }));
    if (rest.length) series.push({ key: OTHER_KEY, label: `Other (${rest.length})`, color: '#94a3b8', total: rest.reduce((a, [, n]) => a + n, 0) });
    const topSet = new Set(top.map(([e]) => e));
    const rows = days.map((d) => {
      const values = {}; let other = 0;
      for (const [e, n] of Object.entries(d.by_user || {})) { if (topSet.has(e)) values[e] = n; else other += n; }
      if (rest.length) values[OTHER_KEY] = other;
      return { day: d.day, total: d.total, values };
    });
    return { series, rows };
  }
  const set = new Set();
  for (const d of days) for (const k of Object.keys(d.counts || {})) set.add(k);
  const series = sortStages([...set]).map((s) => ({ key: s, label: stageLabel(s), color: stageColor(s), total: days.reduce((a, d) => a + (d.counts?.[s] || 0), 0) }));
  const rows = days.map((d) => ({ day: d.day, total: d.total, values: { ...(d.counts || {}) } }));
  return { series, rows };
}

function DailyTrendChart({ days, chartType, groupBy, userNames }) {
  const [hover, setHover] = useState(null);
  const { series, rows } = useMemo(() => buildSeries({ days, groupBy, userNames: userNames || {} }), [days, groupBy, userNames]);
  const rawMax = useMemo(() => {
    if (chartType === 'line') { let m = 0; for (const r of rows) for (const s of series) m = Math.max(m, r.values[s.key] || 0); return m || 1; }
    return rows.reduce((m, r) => Math.max(m, r.total || 0), 0) || 1;
  }, [rows, series, chartType]);
  const { ticks, niceMax } = useMemo(() => niceTicks(rawMax, 4), [rawMax]);
  if (days.length === 0) return <div className="ura-empty">No daily activity in this range.</div>;

  const W = 880, H = 300, PAD = { top: 28, right: 16, bottom: 36, left: 40 };
  const innerW = W - PAD.left - PAD.right, innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / rows.length, barW = Math.max(4, Math.min(28, slot * 0.7));
  const xLabelEvery = Math.max(1, Math.ceil(rows.length / 8));
  const xOf = (i) => PAD.left + slot * i + slot / 2;
  const yOf = (v) => PAD.top + innerH - (v / niceMax) * innerH;

  return (
    <div className="ura-chart-wrap">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="ura-chart">
        {ticks.map((t, i) => { const y = yOf(t); return (
          <g key={i}><line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="var(--hairline)" /><text x={PAD.left - 6} y={y + 3} fontSize="10" fill="var(--text-faint)" textAnchor="end">{t}</text></g>
        ); })}
        {chartType === 'bar' && rows.map((r, i) => {
          const x = PAD.left + slot * i + (slot - barW) / 2; let yc = PAD.top + innerH; const segs = [];
          for (const s of series) { const v = r.values[s.key] || 0; if (!v) continue; const h = (v / niceMax) * innerH; yc -= h; segs.push(<rect key={s.key} x={x} y={yc} width={barW} height={h} fill={s.color} rx="2" />); }
          return <g key={r.day}>{segs}</g>;
        })}
        {chartType === 'line' && series.map((s) => (
          <g key={s.key}>
            <polyline points={rows.map((r, i) => `${xOf(i)},${yOf(r.values[s.key] || 0)}`).join(' ')} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" />
            {rows.map((r, i) => <circle key={i} cx={xOf(i)} cy={yOf(r.values[s.key] || 0)} r="3" fill={s.color} />)}
          </g>
        ))}
        {rows.map((r, i) => {
          const x = xOf(i); const showLabel = i % xLabelEvery === 0 || i === rows.length - 1;
          const topY = chartType === 'line' ? yOf(Math.max(...series.map((s) => r.values[s.key] || 0), 0)) : yOf(r.total);
          return (
            <g key={`o-${r.day}`} onMouseEnter={() => setHover({ x, y: topY, ...r })} onMouseLeave={() => setHover(null)}>
              <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH} fill="transparent" />
              {showLabel && <text x={x} y={H - PAD.bottom + 14} fontSize="10" fill="var(--text-muted)" textAnchor="middle">{r.day.slice(5)}</text>}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="ura-tooltip" style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%` }}>
          <div className="ura-tt-title">{hover.day} · {hover.total} action{hover.total === 1 ? '' : 's'}</div>
          {series.filter((s) => (hover.values?.[s.key] || 0) > 0).map((s) => (
            <div key={s.key} className="ura-tt-row"><span className="stage-dot" style={{ background: s.color }} /><span>{s.label}</span><strong>{hover.values[s.key]}</strong></div>
          ))}
        </div>
      )}
      <div className="ura-legend">{series.map((s) => <span key={s.key} className="ura-legend-item"><span className="stage-dot" style={{ background: s.color }} />{s.label}</span>)}</div>
    </div>
  );
}

function StageDistribution({ totals }) {
  const entries = useMemo(() => sortStages(Object.keys(totals)).map((s) => ({ stage: s, value: totals[s] || 0 })).filter((e) => e.value > 0), [totals]);
  const total = entries.reduce((a, b) => a + b.value, 0);
  if (total === 0) return <div className="ura-empty">No stage data.</div>;
  const SIZE = 200, RO = 90, RI = 56, cx = SIZE / 2, cy = SIZE / 2;
  let acc = 0;
  const segs = entries.map((e) => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2; acc += e.value;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2; const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + RO * Math.cos(start), y1 = cy + RO * Math.sin(start), x2 = cx + RO * Math.cos(end), y2 = cy + RO * Math.sin(end);
    const x3 = cx + RI * Math.cos(end), y3 = cy + RI * Math.sin(end), x4 = cx + RI * Math.cos(start), y4 = cy + RI * Math.sin(start);
    return { ...e, d: `M ${x1} ${y1} A ${RO} ${RO} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${RI} ${RI} 0 ${large} 0 ${x4} ${y4} Z` };
  });
  return (
    <div className="ura-donut-wrap">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {segs.map((s) => <path key={s.stage} d={s.d} fill={stageColor(s.stage)}><title>{stageLabel(s.stage)}: {s.value}</title></path>)}
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="22" fontWeight="700" fill="var(--text)">{total}</text>
        <text x={cx} y={cy + 16} textAnchor="middle" fontSize="11" fill="var(--text-muted)">actions</text>
      </svg>
      <div className="ura-donut-legend">
        {entries.map((e) => (
          <div key={e.stage} className="ura-legend-row">
            <span className="stage-dot" style={{ background: stageColor(e.stage) }} />
            <span className="ura-legend-name">{stageLabel(e.stage)}</span>
            <span className="ura-legend-pct">{((e.value / total) * 100).toFixed(1)}%</span>
            <strong className="ura-legend-val">{e.value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function FunnelChart({ funnel }) {
  const steps = FUNNEL_STAGES.map((key) => ({ key, label: stageLabel(key), value: funnel?.[key] || 0 }));
  const top = steps[0].value;
  if (!steps.some((s) => s.value > 0)) return <div className="ura-empty">No leads reached a funnel stage.</div>;
  return (
    <div className="ura-funnel-wrap">
      <div className="ura-ft-head"><div>Stage</div><div>Share of cohort</div><div className="ura-ft-col-count">Leads</div><div>vs previous</div></div>
      {steps.map((s, i) => {
        const prev = i === 0 ? top : steps[i - 1].value;
        const widthPct = top > 0 ? Math.max((s.value / top) * 100, 1) : 0;
        const conv = i === 0 ? null : (prev > 0 ? (s.value / prev) * 100 : 0);
        const cls = conv === null ? '' : conv < 30 ? 'ura-ft-conv-bad' : conv < 60 ? 'ura-ft-conv-mid' : 'ura-ft-conv-good';
        return (
          <div key={s.key} className="ura-ft-row">
            <div className="ura-ft-col-stage"><span className="stage-dot" style={{ background: stageColor(s.key) }} /><strong>{s.label}</strong>{i === 0 && <span className="ura-ft-cohort-tag">cohort</span>}</div>
            <div><div className="ura-ft-bar-track"><div className="ura-ft-bar-fill" style={{ width: `${widthPct}%`, background: stageColor(s.key) }} /></div><div className="ura-ft-bar-pct">{((s.value / top) * 100).toFixed(1)}% of cohort</div></div>
            <div className="ura-ft-col-count">{s.value}</div>
            <div>{conv === null ? <span className="muted">—</span> : <span className={`ura-ft-conv ${cls}`}>{conv.toFixed(1)}%</span>}</div>
          </div>
        );
      })}
      <div className="ura-funnel-foot">Cohort = leads in this period; later stages count those that ever reached the stage.</div>
    </div>
  );
}

function UserLeaderboard({ users }) {
  const ranked = useMemo(() => users.map((u) => {
    const vs = (u.counts?.visit_scheduled) || 0; const vsPct = u.total > 0 ? (vs / u.total) * 100 : 0;
    return { ...u, vs, vsPct };
  }).sort((a, b) => (b.vsPct - a.vsPct) || (b.total - a.total)).slice(0, 15), [users]);
  const stages = useMemo(() => { const set = new Set(); for (const u of ranked) for (const k of Object.keys(u.counts || {})) set.add(k); return sortStages([...set]); }, [ranked]);
  const maxTotal = ranked.reduce((m, u) => Math.max(m, u.total), 0) || 1;
  if (ranked.length === 0) return <div className="ura-empty">No RMs to rank.</div>;
  return (
    <div className="ura-leaderboard">
      <div className="ura-lb-head"><div /><div /><div>Activity mix</div><div className="ura-lb-col-num">Volume</div><div className="ura-lb-col-num">% Visit</div></div>
      {ranked.map((u, idx) => (
        <div key={u.actor_email} className="ura-lb-row">
          <div className="ura-lb-rank">{idx + 1}</div>
          <div className="ura-lb-name"><div><strong>{u.actor_name || u.actor_email}</strong>{u.actor_role && <span className="role-chip" style={{ marginLeft: 6 }}>{u.actor_role}</span>}</div><div className="ura-lb-email">{u.actor_email}</div></div>
          <div><div className="ura-lb-bar" style={{ width: `${(u.total / maxTotal) * 100}%` }}>{stages.map((s) => { const v = u.counts?.[s] || 0; if (!v) return null; return <span key={s} className="ura-lb-seg" style={{ width: `${(v / u.total) * 100}%`, background: stageColor(s) }} title={`${stageLabel(s)}: ${v}`} />; })}</div></div>
          <div className="ura-lb-total">{u.total}</div>
          <div className="ura-lb-pct">{u.vsPct.toFixed(1)}%</div>
        </div>
      ))}
    </div>
  );
}

export default function UserReportAnalytics({ from, to, users, reportData }) {
  const [analytics, setAnalytics] = useState({ daily_trend: [], funnel: {}, user_names: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chartType, setChartType] = useState('bar');
  const [groupBy, setGroupBy] = useState('stage');

  useEffect(() => {
    let alive = true; setLoading(true); setError(null);
    const params = new URLSearchParams({ from, to });
    if (users.length) params.set('users', users.join(','));
    api.get(`/api/activity/user-report/analytics?${params}`)
      .then((r) => { if (alive) setAnalytics(r); })
      .catch((e) => { if (alive) setError(e.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [from, to, users]);

  const totals = useMemo(() => {
    const out = {};
    for (const u of reportData.users || []) for (const [s, n] of Object.entries(u.counts || {})) out[s] = (out[s] || 0) + n;
    return out;
  }, [reportData]);
  const rmRows = useMemo(() => (reportData.users || []).filter((u) => (u.actor_role || '').toLowerCase() !== 'admin'), [reportData]);

  if (loading) return <div className="al-empty">Loading analytics…</div>;
  if (error) return <div className="modal-error">{error}</div>;

  return (
    <div className="ura-grid">
      <section className="ura-card ura-card-wide">
        <div className="ura-card-head">
          <div><h3 className="ura-title">Daily activity</h3><div className="ura-subtitle">Stage changes per day, {groupBy === 'stage' ? 'by final stage' : 'by user'}.</div></div>
          <div className="ura-card-controls">
            <div className="ura-seg"><button className={chartType === 'bar' ? 'ura-seg-on' : ''} onClick={() => setChartType('bar')}>Bar</button><button className={chartType === 'line' ? 'ura-seg-on' : ''} onClick={() => setChartType('line')}>Line</button></div>
            <div className="ura-seg"><button className={groupBy === 'stage' ? 'ura-seg-on' : ''} onClick={() => setGroupBy('stage')}>By stage</button><button className={groupBy === 'user' ? 'ura-seg-on' : ''} onClick={() => setGroupBy('user')}>By user</button></div>
          </div>
        </div>
        <DailyTrendChart days={analytics.daily_trend || []} chartType={chartType} groupBy={groupBy} userNames={analytics.user_names || {}} />
      </section>

      <section className="ura-card">
        <h3 className="ura-title">Activity by stage</h3>
        <div className="ura-subtitle">Actions grouped by the stage they ended at.</div>
        <StageDistribution totals={totals} />
      </section>

      <section className="ura-card">
        <h3 className="ura-title">Conversion funnel</h3>
        <div className="ura-subtitle">Of leads in this period, how many reached each stage.</div>
        <FunnelChart funnel={analytics.funnel || {}} />
      </section>

      <section className="ura-card ura-card-wide">
        <h3 className="ura-title">RM leaderboard</h3>
        <div className="ura-subtitle">Top RMs by % of activity that reached Visit Scheduled. Admins excluded.</div>
        <UserLeaderboard users={rmRows} />
      </section>
    </div>
  );
}
