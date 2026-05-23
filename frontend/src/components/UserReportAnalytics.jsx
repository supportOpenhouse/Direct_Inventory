import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { stageLabel } from '../utils/format.js';

// Stages in the order we want to show them across charts. Anything outside
// this list (legacy stages, "(none)") is appended in insertion order.
const STAGE_ORDER = [
  'qualified',
  'call_not_received',
  'follow_up',
  'visit_scheduled',
  'visit_completed',
  'offer_given',
  'unreachable',
  'rejected',
];

// Funnel order — canonical pipeline progression. Labels come from the
// shared `stageLabel` mapping so they stay consistent with the rest of
// the UI.
const FUNNEL_STAGES = ['qualified', 'visit_scheduled', 'visit_completed', 'offer_given'];

// Analytics palette — locally scoped so we don't repaint the rest of the
// app's stage dots. "Rejected" is intentionally the most recessive
// (muted grey) even though it's usually the largest segment — the eye
// should land on live pipeline, not failures.
const ANALYTICS_STAGE_COLOR = {
  qualified:         '#7F77DD',
  call_not_received: '#EF9F27',
  follow_up:         '#378ADD',
  visit_scheduled:   '#1D9E75',
  visit_completed:   '#639922',
  offer_given:       '#BA7517',
  unreachable:       '#94a3b8',
  rejected:          '#D3D1C7',
};

function sortStages(keys) {
  return [...keys].sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a);
    const ib = STAGE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function stageColor(s) {
  return ANALYTICS_STAGE_COLOR[s] || '#94a3b8';
}

// Pick a "nice" axis upper bound + tick interval for a given raw max.
// Round to 1/2/5 * 10^n so ticks land on clean values (0/100/200/300/400,
// not 0/100/201/301/401 — the previous code used Math.round() on
// fractions, which produced the off-by-one ticks seen in the screenshots).
function niceTicks(rawMax, tickCount = 4) {
  if (rawMax <= 0) return { ticks: [0, 1], niceMax: 1 };
  const rough = rawMax / tickCount;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let step;
  if (norm <= 1) step = 1 * mag;
  else if (norm <= 2) step = 2 * mag;
  else if (norm <= 5) step = 5 * mag;
  else step = 10 * mag;
  const niceMax = Math.ceil(rawMax / step) * step;
  const ticks = [];
  for (let t = 0; t <= niceMax + 1e-9; t += step) ticks.push(Math.round(t));
  return { ticks, niceMax };
}

// Palette for user-series (no natural color per user, so cycle through).
// Distinct enough hues that 8+ users on the same chart stay separable.
const USER_PALETTE = [
  '#378ADD', '#EF9F27', '#1D9E75', '#7F77DD', '#BA7517',
  '#dc2626', '#06b6d4', '#a855f7', '#84cc16', '#f43f5e',
];
const TOP_USERS = 8;          // cap distinct series; rest collapses to "Other"
const OTHER_KEY = '__other__';
const OTHER_COLOR = '#94a3b8';

// Build the (series, perDayValues) shape the chart renders from. Returns
// { series: [{key, label, color, total}], rows: [{day, total, values}] }
// where values[key] is that series' count for that day.
function buildSeries({ days, groupBy, userNames }) {
  if (groupBy === 'user') {
    // Sum per-user across all days to pick the top-N. Everything else
    // collapses to a single "Other" series so the legend stays readable
    // even on a 30-day window with 40+ users.
    const totalsByUser = {};
    for (const d of days) {
      for (const [email, n] of Object.entries(d.by_user || {})) {
        totalsByUser[email] = (totalsByUser[email] || 0) + n;
      }
    }
    const sortedUsers = Object.entries(totalsByUser)
      .sort((a, b) => b[1] - a[1]);
    const top = sortedUsers.slice(0, TOP_USERS);
    const rest = sortedUsers.slice(TOP_USERS);
    const series = top.map(([email, total], i) => ({
      key: email,
      label: userNames[email] || email,
      color: USER_PALETTE[i % USER_PALETTE.length],
      total,
    }));
    if (rest.length > 0) {
      series.push({
        key: OTHER_KEY,
        label: `Other (${rest.length} user${rest.length === 1 ? '' : 's'})`,
        color: OTHER_COLOR,
        total: rest.reduce((a, [, n]) => a + n, 0),
      });
    }
    const topEmails = new Set(top.map(([e]) => e));
    const rows = days.map((d) => {
      const values = {};
      let otherSum = 0;
      for (const [email, n] of Object.entries(d.by_user || {})) {
        if (topEmails.has(email)) values[email] = n;
        else otherSum += n;
      }
      if (rest.length > 0) values[OTHER_KEY] = otherSum;
      return { day: d.day, total: d.total, values };
    });
    return { series, rows };
  }
  // groupBy === 'stage' — existing shape, derived from d.counts.
  const stageSet = new Set();
  for (const d of days) for (const k of Object.keys(d.counts || {})) stageSet.add(k);
  const series = sortStages(Array.from(stageSet)).map((s) => ({
    key: s,
    label: stageLabel(s),
    color: stageColor(s),
    total: days.reduce((a, d) => a + (d.counts?.[s] || 0), 0),
  }));
  const rows = days.map((d) => ({
    day: d.day,
    total: d.total,
    values: { ...(d.counts || {}) },
  }));
  return { series, rows };
}

// Daily activity chart. Two axes of variation:
//   chartType: 'bar' (stacked) | 'line' (one polyline per series)
//   groupBy:   'stage'         | 'user'
// Day-over-day % delta is shown above each day's total in both modes.
function DailyTrendChart({ days, chartType, groupBy, userNames }) {
  const [hover, setHover] = useState(null);

  const { series, rows } = useMemo(
    () => buildSeries({ days, groupBy, userNames: userNames || {} }),
    [days, groupBy, userNames],
  );

  const rawMax = useMemo(() => {
    if (chartType === 'line') {
      // For line mode the Y range needs to fit the tallest *single* series
      // value, not the daily total — otherwise lines hug the baseline.
      let m = 0;
      for (const r of rows) for (const s of series) m = Math.max(m, r.values[s.key] || 0);
      return m || 1;
    }
    return rows.reduce((m, r) => Math.max(m, r.total || 0), 0) || 1;
  }, [rows, series, chartType]);
  const { ticks, niceMax } = useMemo(() => niceTicks(rawMax, 4), [rawMax]);

  if (days.length === 0) {
    return <div className="ura-empty">No daily activity in this range.</div>;
  }

  const W = 880;
  const H = 300;
  const PAD = { top: 28, right: 16, bottom: 36, left: 40 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / rows.length;
  const barW = Math.max(4, Math.min(28, slot * 0.7));
  const xLabelEvery = Math.max(1, Math.ceil(rows.length / 8));
  // Plot a point at the center of each day's column for line mode.
  const xOf = (i) => PAD.left + slot * i + slot / 2;
  const yOf = (v) => PAD.top + innerH - (v / niceMax) * innerH;

  return (
    <div className="ura-chart-wrap">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="ura-chart">
        {ticks.map((t, i) => {
          const y = yOf(t);
          return (
            <g key={i}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
                    stroke="#f1f5f9" strokeWidth="1" />
              <text x={PAD.left - 6} y={y + 3} fontSize="10" fill="#94a3b8"
                    textAnchor="end">{t}</text>
            </g>
          );
        })}

        {chartType === 'bar' && rows.map((r, i) => {
          const x = PAD.left + slot * i + (slot - barW) / 2;
          let yCursor = PAD.top + innerH;
          const segments = [];
          for (const s of series) {
            const v = r.values[s.key] || 0;
            if (v === 0) continue;
            const h = (v / niceMax) * innerH;
            yCursor -= h;
            segments.push(
              <rect key={s.key} x={x} y={yCursor} width={barW} height={h}
                    fill={s.color} />,
            );
          }
          return <g key={r.day}>{segments}</g>;
        })}

        {chartType === 'line' && series.map((s) => {
          const pts = rows
            .map((r, i) => `${xOf(i)},${yOf(r.values[s.key] || 0)}`)
            .join(' ');
          return (
            <g key={s.key}>
              <polyline points={pts} fill="none"
                        stroke={s.color} strokeWidth="2"
                        strokeLinejoin="round" strokeLinecap="round" />
              {rows.map((r, i) => (
                <circle key={i} cx={xOf(i)} cy={yOf(r.values[s.key] || 0)}
                        r="3" fill={s.color} />
              ))}
            </g>
          );
        })}

        {/* Day-over-day % delta on TOTAL + x-axis label + hit area, drawn
            after the bars/lines so it always overlays cleanly. */}
        {rows.map((r, i) => {
          const x = xOf(i);
          const prev = i > 0 ? rows[i - 1].total || 0 : null;
          const deltaPct = (prev != null && prev > 0)
            ? ((r.total - prev) / prev) * 100
            : null;
          const topY = chartType === 'line'
            ? yOf(Math.max(...series.map((s) => r.values[s.key] || 0), 0))
            : yOf(r.total);
          const deltaY = Math.max(PAD.top - 8, topY - 6);
          const showLabel = i % xLabelEvery === 0 || i === rows.length - 1;
          return (
            <g key={`o-${r.day}`}
               onMouseEnter={() => setHover({ x, y: topY, ...r, deltaPct })}
               onMouseLeave={() => setHover(null)}>
              <rect x={PAD.left + slot * i} y={PAD.top}
                    width={slot} height={innerH} fill="transparent" />
              {deltaPct !== null && r.total !== prev && (
                <text x={x} y={deltaY} fontSize="10" fontWeight="700"
                      textAnchor="middle"
                      fill={deltaPct > 0 ? '#16a34a' : '#dc2626'}>
                  {deltaPct > 0 ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(0)}%
                </text>
              )}
              {showLabel && (
                <text x={x} y={H - PAD.bottom + 14} fontSize="10"
                      fill="#64748b" textAnchor="middle">
                  {r.day.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div
          className="ura-tooltip"
          style={{
            left: `${(hover.x / W) * 100}%`,
            top: `${(hover.y / H) * 100}%`,
          }}
        >
          <div className="ura-tt-title">
            {hover.day} · {hover.total} action{hover.total === 1 ? '' : 's'}
          </div>
          {series
            .filter((s) => (hover.values?.[s.key] || 0) > 0)
            .map((s) => (
              <div key={s.key} className="ura-tt-row">
                <span className="stage-dot" style={{ background: s.color }} />
                <span>{s.label}</span>
                <strong>{hover.values[s.key]}</strong>
              </div>
            ))}
        </div>
      )}
      <div className="ura-legend">
        {series.map((s) => (
          <span key={s.key} className="ura-legend-item">
            <span className="stage-dot" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// Donut chart of stage distribution across the whole filtered range.
function StageDistribution({ totals }) {
  const entries = useMemo(() => {
    const stages = sortStages(Object.keys(totals));
    return stages.map((s) => ({ stage: s, value: totals[s] || 0 }))
      .filter((e) => e.value > 0);
  }, [totals]);

  const total = entries.reduce((a, b) => a + b.value, 0);
  if (total === 0) {
    return <div className="ura-empty">No stage data.</div>;
  }

  const SIZE = 200;
  const R_OUTER = 90;
  const R_INNER = 56;
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  let acc = 0;
  const segments = entries.map((e) => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += e.value;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const largeArc = end - start > Math.PI ? 1 : 0;
    const x1 = cx + R_OUTER * Math.cos(start);
    const y1 = cy + R_OUTER * Math.sin(start);
    const x2 = cx + R_OUTER * Math.cos(end);
    const y2 = cy + R_OUTER * Math.sin(end);
    const x3 = cx + R_INNER * Math.cos(end);
    const y3 = cy + R_INNER * Math.sin(end);
    const x4 = cx + R_INNER * Math.cos(start);
    const y4 = cy + R_INNER * Math.sin(start);
    const d = [
      `M ${x1} ${y1}`,
      `A ${R_OUTER} ${R_OUTER} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${x3} ${y3}`,
      `A ${R_INNER} ${R_INNER} 0 ${largeArc} 0 ${x4} ${y4}`,
      'Z',
    ].join(' ');
    return { ...e, d };
  });

  return (
    <div className="ura-donut-wrap">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {segments.map((seg) => (
          <path key={seg.stage} d={seg.d} fill={stageColor(seg.stage)}>
            <title>{stageLabel(seg.stage)}: {seg.value} ({((seg.value / total) * 100).toFixed(1)}%)</title>
          </path>
        ))}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="22" fontWeight="700" fill="#0f1115">
          {total}
        </text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontSize="11" fill="#64748b">
          total leads
        </text>
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

// RM leaderboard. Primary rank = % of activity that reached
// visit_scheduled (the most useful performance signal we can compute
// from the user-report response without a new endpoint). Volume is
// shown alongside as context, and is the tiebreaker.
function UserLeaderboard({ users }) {
  const ranked = useMemo(() => {
    const enriched = users.map((u) => {
      const vs = (u.counts && u.counts.visit_scheduled) || 0;
      const vsPct = u.total > 0 ? (vs / u.total) * 100 : 0;
      return { ...u, vs, vsPct };
    });
    return enriched
      .sort((a, b) => (b.vsPct - a.vsPct) || (b.total - a.total))
      .slice(0, 15);
  }, [users]);

  const stages = useMemo(() => {
    const set = new Set();
    for (const u of ranked) for (const k of Object.keys(u.counts || {})) set.add(k);
    return sortStages(Array.from(set));
  }, [ranked]);
  const maxTotal = ranked.reduce((m, u) => Math.max(m, u.total), 0) || 1;

  if (ranked.length === 0) {
    return <div className="ura-empty">No RMs to rank.</div>;
  }

  return (
    <div className="ura-leaderboard">
      <div className="ura-lb-head">
        <div />
        <div />
        <div className="ura-lb-col-h">Activity mix</div>
        <div className="ura-lb-col-h ura-lb-col-num">Volume</div>
        <div className="ura-lb-col-h ura-lb-col-num">% Visit Scheduled</div>
      </div>
      {ranked.map((u, idx) => (
        <div key={u.actor_email} className="ura-lb-row">
          <div className="ura-lb-rank">{idx + 1}</div>
          <div className="ura-lb-name">
            <div className="ura-lb-name-line">
              <strong>{u.actor_name || u.actor_email}</strong>
              {u.actor_role && <span className="role-chip">{u.actor_role}</span>}
            </div>
            <div className="ura-lb-email">{u.actor_email}</div>
          </div>
          <div className="ura-lb-bar-wrap">
            <div className="ura-lb-bar" style={{ width: `${(u.total / maxTotal) * 100}%` }}>
              {stages.map((s) => {
                const v = u.counts?.[s] || 0;
                if (v === 0) return null;
                const pct = (v / u.total) * 100;
                return (
                  <span
                    key={s}
                    className="ura-lb-seg"
                    style={{ width: `${pct}%`, background: stageColor(s) }}
                    title={`${stageLabel(s)}: ${v}`}
                  />
                );
              })}
            </div>
          </div>
          <div className="ura-lb-total">{u.total}</div>
          <div className="ura-lb-pct">{u.vsPct.toFixed(1)}%</div>
        </div>
      ))}
      <div className="ura-legend">
        {stages.map((s) => (
          <span key={s} className="ura-legend-item">
            <span className="stage-dot" style={{ background: stageColor(s) }} />
            {stageLabel(s)}
          </span>
        ))}
      </div>
    </div>
  );
}

// Threshold below which a step-over-step % is just noise on a tiny
// base — we still show the number, but in muted "n=X, not meaningful"
// styling instead of bold/red/green that suggests a real performance
// signal.
const TINY_BASE = 5;

// Stepped stage table. Replaces the prior trapezoidal SVG funnel: at
// real cohort ratios (e.g. 18k → 5 → 1 → 1) a funnel shape cannot draw
// segments both proportional and visible without visually lying, so we
// switched to a tabular layout per Ashish's call. Each row carries a
// proportional mini-bar (linear, capped at the cohort top so widths can
// only ever shrink down the funnel), the count, and the conversion
// from the previous step.
function FunnelChart({ funnel }) {
  const steps = FUNNEL_STAGES.map((key) => ({
    key,
    label: stageLabel(key),
    value: funnel?.[key] || 0,
  }));
  const top = steps[0].value;
  const anyData = steps.some((s) => s.value > 0);

  if (!anyData) {
    return (
      <div className="ura-empty">
        No leads reached any funnel stage in this period.
      </div>
    );
  }

  return (
    <div className="ura-funnel-wrap">
      <div className="ura-ft-head">
        <div className="ura-ft-col-stage">Stage</div>
        <div className="ura-ft-col-bar">Share of cohort</div>
        <div className="ura-ft-col-count">Leads</div>
        <div className="ura-ft-col-conv">vs previous</div>
      </div>
      {steps.map((s, i) => {
        const prev = i === 0 ? top : steps[i - 1].value;
        const widthPct = top > 0 ? Math.max((s.value / top) * 100, 1) : 0;
        const conversion = i === 0
          ? null
          : prev > 0
            ? (s.value / prev) * 100
            : 0;
        // Guardrail: a conversion computed on n ≤ 5 isn't statistically
        // meaningful — render it muted instead of green/red so the eye
        // doesn't read it as a real signal.
        const tinyBase = i > 0 && prev <= TINY_BASE;
        const convClass = conversion === null
          ? ''
          : tinyBase
            ? 'ura-ft-conv ura-ft-conv-tiny'
            : conversion < 30
              ? 'ura-ft-conv ura-ft-conv-bad'
              : conversion < 60
                ? 'ura-ft-conv ura-ft-conv-mid'
                : 'ura-ft-conv ura-ft-conv-good';
        return (
          <div key={s.key} className="ura-ft-row">
            <div className="ura-ft-col-stage">
              <span className="stage-dot" style={{ background: stageColor(s.key) }} />
              <strong>{s.label}</strong>
              {i === 0 && <span className="ura-ft-cohort-tag">cohort</span>}
            </div>
            <div className="ura-ft-col-bar">
              <div className="ura-ft-bar-track">
                <div
                  className="ura-ft-bar-fill"
                  style={{
                    width: `${widthPct}%`,
                    background: stageColor(s.key),
                  }}
                />
              </div>
              <div className="ura-ft-bar-pct">
                {top > 0 ? ((s.value / top) * 100).toFixed(1) : '0.0'}% of cohort
              </div>
            </div>
            <div className="ura-ft-col-count">
              <strong>{s.value.toLocaleString()}</strong>
            </div>
            <div className="ura-ft-col-conv">
              {conversion === null ? (
                <span className="muted">—</span>
              ) : (
                <>
                  <span className={convClass}>{conversion.toFixed(1)}%</span>
                  {tinyBase ? (
                    <span className="ura-ft-note">n={prev}, not meaningful</span>
                  ) : (
                    <span className="ura-ft-note">{prev - s.value} dropped</span>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
      <div className="ura-funnel-foot">
        Cohort = leads assigned in this period. Subsequent stages count
        cohort leads that have ever reached that stage.{' '}
        Overall:{' '}
        <strong>
          {top > 0 ? ((steps[steps.length - 1].value / top) * 100).toFixed(1) : '0.0'}%
        </strong>{' '}
        top-to-bottom conversion.
      </div>
    </div>
  );
}

export default function UserReportAnalytics({ from, to, users, reportData }) {
  const [analytics, setAnalytics] = useState({ daily_trend: [], funnel: {}, user_names: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [chartType, setChartType] = useState('bar');   // 'bar' | 'line'
  const [groupBy, setGroupBy] = useState('stage');     // 'stage' | 'user'

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ from, to });
    if (users.length) params.set('users', users.join(','));
    api.get(`/api/activity/user-report/analytics?${params}`)
      .then((r) => { if (alive) setAnalytics(r); })
      .catch((e) => { if (alive) setError(e.data?.error || e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [from, to, users]);

  // Aggregate stage totals across all users in the current report data.
  const totals = useMemo(() => {
    const out = {};
    for (const u of reportData.users || []) {
      for (const [s, n] of Object.entries(u.counts || {})) {
        out[s] = (out[s] || 0) + n;
      }
    }
    return out;
  }, [reportData]);

  // RM leaderboard: drop admin-role users (they're noise on a sales-perf
  // view) and rank by % of activity that resulted in "visit scheduled".
  // Falls back to volume as the tiebreaker.
  // MUST be declared BEFORE the loading/error early returns — Rules of
  // Hooks: a hook called only on the post-loading render would crash
  // the component and leave the analytics tab blank.
  const rmRows = useMemo(() => {
    const all = reportData.users || [];
    return all.filter((u) => (u.actor_role || '').toLowerCase() !== 'admin');
  }, [reportData]);

  if (loading) return <div className="al-empty">Loading analytics…</div>;
  if (error) return <div className="modal-error">{error}</div>;

  return (
    <div className="ura-grid">
      <section className="ura-card ura-card-wide">
        <div className="ura-card-head">
          <div>
            <h3 className="ura-title">Daily activity</h3>
            <div className="ura-subtitle">
              Number of stage changes recorded per day,{' '}
              {groupBy === 'stage' ? 'grouped by final stage' : 'grouped by user'}.
              ▲/▼ vs the previous day on each column.
            </div>
          </div>
          <div className="ura-card-controls">
            <div className="ura-seg">
              <button
                type="button"
                className={chartType === 'bar' ? 'ura-seg-on' : ''}
                onClick={() => setChartType('bar')}
              >Bar</button>
              <button
                type="button"
                className={chartType === 'line' ? 'ura-seg-on' : ''}
                onClick={() => setChartType('line')}
              >Line</button>
            </div>
            <div className="ura-seg">
              <button
                type="button"
                className={groupBy === 'stage' ? 'ura-seg-on' : ''}
                onClick={() => setGroupBy('stage')}
              >By stage</button>
              <button
                type="button"
                className={groupBy === 'user' ? 'ura-seg-on' : ''}
                onClick={() => setGroupBy('user')}
              >By user</button>
            </div>
          </div>
        </div>
        <DailyTrendChart
          days={analytics.daily_trend || []}
          chartType={chartType}
          groupBy={groupBy}
          userNames={analytics.user_names || {}}
        />
      </section>

      <section className="ura-card">
        <h3 className="ura-title">Activity by stage</h3>
        <div className="ura-subtitle">
          Each user-day-lead action grouped by the stage it ended at. NOT
          a count of leads — same lead worked on two days counts twice.
        </div>
        <StageDistribution totals={totals} />
      </section>

      <section className="ura-card">
        <h3 className="ura-title">Conversion funnel</h3>
        <div className="ura-subtitle">
          Of leads assigned in this period, how many have ever reached
          each stage. Counts distinct leads (one lead = one count).
        </div>
        <FunnelChart funnel={analytics.funnel || {}} />
      </section>

      <section className="ura-card ura-card-wide">
        <h3 className="ura-title">RM leaderboard</h3>
        <div className="ura-subtitle">
          Top {Math.min(rmRows.length, 15)} RMs by % of their activity
          that moved a lead to Visit Scheduled. Admins excluded.
        </div>
        <UserLeaderboard users={rmRows} />
      </section>
    </div>
  );
}
