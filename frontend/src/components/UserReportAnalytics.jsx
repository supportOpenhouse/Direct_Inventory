import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';
import SlideTabs from './SlideTabs.jsx';

const STAGE_ORDER = ['lead', 'active', 'qualified', 'call_not_received', 'follow_up', 'visit_scheduled', 'visit_completed', 'offer_given', 'rejected'];
const FUNNEL_STAGES = ['qualified', 'visit_scheduled', 'visit_completed', 'offer_given'];
function sortStages(keys) {
  return [...keys].sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a); const ib = STAGE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1; if (ib === -1) return -1; return ia - ib;
  });
}
// Single source of truth: the same stage colours the filter boxes / stage dots use.
const stageColor = (s) => STAGE_DOT_COLOR[s] || '#94a3b8';

const SEG_GAP = 2;   // surface gap between stacked segments
const BAR_R = 4;     // rounded data-end (top of the stack only)

// Bar with a rounded TOP and a square baseline — the data-end is rounded, the
// end anchored to the axis is not. Interior stack segments use a plain rect.
function roundedTopPath(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, h, w / 2));
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`;
}

// Monotone cubic (Fritsch–Carlson). Smooth, but cannot overshoot — a plain
// Catmull-Rom dips below zero between two zero days, which for counts is a lie.
function smoothPath(pts) {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;
  if (n === 2) return `M${pts[0][0]},${pts[0][1]} L${pts[1][0]},${pts[1][1]}`;
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i += 1) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    m[i] = dy[i] / dx[i];
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i += 1) {
    if (m[i - 1] * m[i] <= 0) { t[i] = 0; continue; }
    const w1 = 2 * dx[i] + dx[i - 1];
    const w2 = dx[i] + 2 * dx[i - 1];
    t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
  }
  t[n - 1] = m[n - 2];
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i += 1) {
    d += ` C${pts[i][0] + dx[i] / 3},${pts[i][1] + (t[i] * dx[i]) / 3}`
      + ` ${pts[i + 1][0] - dx[i] / 3},${pts[i + 1][1] - (t[i + 1] * dx[i]) / 3}`
      + ` ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Roll daily rows up into week (Mon-start) or month buckets. 'all' stays daily.
function bucketDays(days, mode) {
  if (mode === 'all') return days;
  const keyOf = (day) => {
    if (mode === 'months') return day.slice(0, 7);
    const d = new Date(`${day}T00:00:00`);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // back to Monday
    return isoLocal(d);
  };
  const map = new Map();
  for (const d of days) {
    const k = keyOf(d.day);
    if (!map.has(k)) map.set(k, { day: k, total: 0, counts: {}, by_user: {} });
    const b = map.get(k);
    b.total += d.total || 0;
    for (const [s, n] of Object.entries(d.counts || {})) b.counts[s] = (b.counts[s] || 0) + n;
    for (const [e, n] of Object.entries(d.by_user || {})) b.by_user[e] = (b.by_user[e] || 0) + n;
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function bucketLabel(key, mode) {
  if (mode === 'months') {
    const [y, m] = key.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  }
  return key.slice(5);
}

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

function DailyTrendChart({ days, chartType, groupBy, userNames, bucketMode }) {
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
  const slot = innerW / rows.length, barW = Math.max(4, Math.min(24, slot * 0.7));
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
          const x = PAD.left + slot * i + (slot - barW) / 2;
          let yc = PAD.top + innerH;                                   // baseline
          const nz = series.filter((s) => (r.values[s.key] || 0) > 0);
          const segs = nz.map((s, idx) => {
            const h = ((r.values[s.key] || 0) / niceMax) * innerH;
            const yTop = yc - h;
            // Leave SEG_GAP of surface above the segment below (never below the
            // baseline one), so touching stage colours read apart without a stroke.
            const drawH = Math.max(1, h - (idx > 0 ? SEG_GAP : 0));
            const isTop = idx === nz.length - 1;
            yc = yTop;
            return isTop
              ? <path key={s.key} d={roundedTopPath(x, yTop, barW, drawH, BAR_R)} fill={s.color} />
              : <rect key={s.key} x={x} y={yTop} width={barW} height={drawH} fill={s.color} />;
          });
          return <g key={r.day}>{segs}</g>;
        })}
        {chartType === 'line' && series.map((s) => (
          <g key={s.key}>
            <path d={smoothPath(rows.map((r, i) => [xOf(i), yOf(r.values[s.key] || 0)]))}
              fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {/* Markers only when they can breathe; 2px surface ring keeps them
                legible where series cross. */}
            {rows.length <= 31 && rows.map((r, i) => (
              <circle key={i} cx={xOf(i)} cy={yOf(r.values[s.key] || 0)} r="4"
                fill={s.color} stroke="var(--surface)" strokeWidth="2" />
            ))}
          </g>
        ))}
        {rows.map((r, i) => {
          const x = xOf(i); const showLabel = i % xLabelEvery === 0 || i === rows.length - 1;
          const topY = chartType === 'line' ? yOf(Math.max(...series.map((s) => r.values[s.key] || 0), 0)) : yOf(r.total);
          return (
            <g key={`o-${r.day}`} onMouseEnter={() => setHover({ x, y: topY, ...r })} onMouseLeave={() => setHover(null)}>
              <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={innerH} fill="transparent" />
              {showLabel && <text x={x} y={H - PAD.bottom + 14} fontSize="10" fill="var(--text-muted)" textAnchor="middle">{bucketLabel(r.day, bucketMode)}</text>}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="ura-tooltip" style={{ left: `${(hover.x / W) * 100}%`, top: `${(hover.y / H) * 100}%` }}>
          <div className="ura-tt-title">{bucketLabel(hover.day, bucketMode)} · {hover.total} action{hover.total === 1 ? '' : 's'}</div>
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
  const [tlMode, setTlMode] = useState('all');   // all | months | weeks
  const [tlN, setTlN] = useState(3);             // 1–12 of the chosen unit

  // Timeline window. 'all' keeps the page's date filter; months/weeks look back
  // N units from today and roll the days up into that many buckets.
  const range = useMemo(() => {
    if (tlMode === 'all') return { from, to };
    const start = new Date();
    if (tlMode === 'months') { start.setDate(1); start.setMonth(start.getMonth() - (tlN - 1)); }
    else { start.setDate(start.getDate() - (tlN * 7 - 1)); }
    return { from: isoLocal(start), to: isoLocal(new Date()) };
  }, [tlMode, tlN, from, to]);

  useEffect(() => {
    let alive = true; setLoading(true); setError(null);
    const params = new URLSearchParams({ from: range.from, to: range.to });
    if (users.length) params.set('users', users.join(','));
    api.get(`/api/activity/user-report/analytics?${params}`)
      .then((r) => { if (alive) setAnalytics(r); })
      .catch((e) => { if (alive) setError(e.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [range.from, range.to, users]);

  const trend = useMemo(() => bucketDays(analytics.daily_trend || [], tlMode), [analytics, tlMode]);

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
          <div>
            <h3 className="ura-title">{tlMode === 'all' ? 'Daily activity' : tlMode === 'months' ? 'Monthly activity' : 'Weekly activity'}</h3>
            <div className="ura-subtitle">
              Stage changes per {tlMode === 'all' ? 'day' : tlMode === 'months' ? 'month' : 'week'}, {groupBy === 'stage' ? 'by final stage' : 'by user'}
              {tlMode !== 'all' && ` · last ${tlN} ${tlMode === 'months' ? 'month' : 'week'}${tlN === 1 ? '' : 's'}`}.
            </div>
          </div>
          <div className="ura-card-controls">
            <SlideTabs className="ura-seg"><button className={chartType === 'bar' ? 'ura-seg-on' : ''} onClick={() => setChartType('bar')}>Bar</button><button className={chartType === 'line' ? 'ura-seg-on' : ''} onClick={() => setChartType('line')}>Line</button></SlideTabs>
            <SlideTabs className="ura-seg"><button className={groupBy === 'stage' ? 'ura-seg-on' : ''} onClick={() => setGroupBy('stage')}>By stage</button><button className={groupBy === 'user' ? 'ura-seg-on' : ''} onClick={() => setGroupBy('user')}>By user</button></SlideTabs>
            <SlideTabs className="ura-seg">
              <button className={tlMode === 'all' ? 'ura-seg-on' : ''} onClick={() => setTlMode('all')}>All</button>
              <button className={tlMode === 'months' ? 'ura-seg-on' : ''} onClick={() => setTlMode('months')}>Months</button>
              <button className={tlMode === 'weeks' ? 'ura-seg-on' : ''} onClick={() => setTlMode('weeks')}>Weeks</button>
            </SlideTabs>
            {tlMode !== 'all' && (
              <select className="role-select ura-tl-n" value={tlN} onChange={(e) => setTlN(Number(e.target.value))}
                aria-label={`Number of ${tlMode}`}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            )}
          </div>
        </div>
        <DailyTrendChart days={trend} chartType={chartType} groupBy={groupBy} userNames={analytics.user_names || {}} bucketMode={tlMode} />
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
