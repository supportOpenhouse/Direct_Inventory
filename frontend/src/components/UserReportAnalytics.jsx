import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { STAGE_DOT_COLOR, stageLabel } from '../utils/format.js';

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

// Funnel order — what we care about as the conversion sequence.
const FUNNEL_STAGES = ['qualified', 'visit_scheduled', 'visit_completed', 'offer_given'];

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
  return STAGE_DOT_COLOR[s] || '#94a3b8';
}

// Stacked bar chart of stage activity per day. Pure SVG — no chart lib.
function DailyTrendChart({ days }) {
  const [hover, setHover] = useState(null); // { x, y, day, total, counts }

  const stages = useMemo(() => {
    const set = new Set();
    for (const d of days) for (const k of Object.keys(d.counts || {})) set.add(k);
    return sortStages(Array.from(set));
  }, [days]);

  const max = useMemo(
    () => days.reduce((m, d) => Math.max(m, d.total || 0), 0) || 1,
    [days],
  );

  if (days.length === 0) {
    return <div className="ura-empty">No daily activity in this range.</div>;
  }

  const W = 880;
  const H = 280;
  const PAD = { top: 16, right: 16, bottom: 36, left: 40 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const slot = innerW / days.length;
  const barW = Math.max(4, Math.min(28, slot * 0.7));

  // y-axis ticks — 4 evenly spaced.
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));

  // Show ~8 x-axis labels max so they don't overlap.
  const xLabelEvery = Math.max(1, Math.ceil(days.length / 8));

  return (
    <div className="ura-chart-wrap">
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="ura-chart">
        {ticks.map((t, i) => {
          const y = PAD.top + innerH - (t / max) * innerH;
          return (
            <g key={i}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
                    stroke="#f1f5f9" strokeWidth="1" />
              <text x={PAD.left - 6} y={y + 3} fontSize="10" fill="#94a3b8"
                    textAnchor="end">{t}</text>
            </g>
          );
        })}
        {days.map((d, i) => {
          const x = PAD.left + slot * i + (slot - barW) / 2;
          let yCursor = PAD.top + innerH;
          const segments = [];
          for (const s of stages) {
            const v = d.counts?.[s] || 0;
            if (v === 0) continue;
            const h = (v / max) * innerH;
            yCursor -= h;
            segments.push(
              <rect key={s} x={x} y={yCursor} width={barW} height={h}
                    fill={stageColor(s)} />,
            );
          }
          const dayLabel = d.day.slice(5); // MM-DD
          const showLabel = i % xLabelEvery === 0 || i === days.length - 1;
          return (
            <g key={d.day}
               onMouseEnter={() => setHover({ x: x + barW / 2, y: yCursor, ...d })}
               onMouseLeave={() => setHover(null)}>
              {/* invisible hit-area covers the entire column */}
              <rect x={PAD.left + slot * i} y={PAD.top}
                    width={slot} height={innerH} fill="transparent" />
              {segments}
              {showLabel && (
                <text x={x + barW / 2} y={H - PAD.bottom + 14}
                      fontSize="10" fill="#64748b" textAnchor="middle">
                  {dayLabel}
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
          <div className="ura-tt-title">{hover.day} · {hover.total} lead{hover.total === 1 ? '' : 's'}</div>
          {sortStages(Object.keys(hover.counts || {})).map((s) => (
            <div key={s} className="ura-tt-row">
              <span className="stage-dot" style={{ background: stageColor(s) }} />
              <span>{stageLabel(s)}</span>
              <strong>{hover.counts[s]}</strong>
            </div>
          ))}
        </div>
      )}
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

// Horizontal bar chart — top users by total leads, with stage breakdown.
function UserLeaderboard({ users }) {
  const sorted = useMemo(
    () => [...users].sort((a, b) => b.total - a.total).slice(0, 15),
    [users],
  );
  const stages = useMemo(() => {
    const set = new Set();
    for (const u of sorted) for (const k of Object.keys(u.counts || {})) set.add(k);
    return sortStages(Array.from(set));
  }, [sorted]);
  const max = sorted.reduce((m, u) => Math.max(m, u.total), 0) || 1;

  if (sorted.length === 0) {
    return <div className="ura-empty">No users to rank.</div>;
  }

  return (
    <div className="ura-leaderboard">
      {sorted.map((u, idx) => (
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
            <div className="ura-lb-bar" style={{ width: `${(u.total / max) * 100}%` }}>
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

// Funnel: qualified → visit_scheduled → visit_completed → offer_given.
// Each step shows count, % of previous step, and % of top of funnel.
function FunnelChart({ totals }) {
  const steps = FUNNEL_STAGES.map((s) => ({
    stage: s,
    value: totals[s] || 0,
  }));
  const top = steps[0].value || 1;
  const max = Math.max(...steps.map((s) => s.value), 1);

  const anyData = steps.some((s) => s.value > 0);
  if (!anyData) {
    return <div className="ura-empty">No funnel data — none of the funnel stages were reached.</div>;
  }

  return (
    <div className="ura-funnel">
      {steps.map((s, i) => {
        const widthPct = (s.value / max) * 100;
        const overallPct = top > 0 ? ((s.value / top) * 100).toFixed(1) : '0.0';
        const stepPct = i === 0
          ? null
          : (steps[i - 1].value > 0
              ? ((s.value / steps[i - 1].value) * 100).toFixed(1)
              : '0.0');
        return (
          <div key={s.stage} className="ura-funnel-row">
            <div className="ura-funnel-label">
              <span className="stage-dot" style={{ background: stageColor(s.stage) }} />
              {stageLabel(s.stage)}
            </div>
            <div className="ura-funnel-bar-wrap">
              <div
                className="ura-funnel-bar"
                style={{
                  width: `${widthPct}%`,
                  background: stageColor(s.stage),
                }}
              >
                <span className="ura-funnel-val">{s.value}</span>
              </div>
            </div>
            <div className="ura-funnel-pct">
              {stepPct !== null && (
                <span className="ura-funnel-step">{stepPct}% <span className="muted">vs prev</span></span>
              )}
              <span className="ura-funnel-overall">{overallPct}% <span className="muted">of top</span></span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function UserReportAnalytics({ from, to, users, reportData }) {
  const [trend, setTrend] = useState({ daily_trend: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ from, to });
    if (users.length) params.set('users', users.join(','));
    api.get(`/api/activity/user-report/analytics?${params}`)
      .then((r) => { if (alive) setTrend(r); })
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

  if (loading) return <div className="al-empty">Loading analytics…</div>;
  if (error) return <div className="modal-error">{error}</div>;

  return (
    <div className="ura-grid">
      <section className="ura-card ura-card-wide">
        <h3 className="ura-title">Daily activity</h3>
        <div className="ura-subtitle">Stage changes per day, stacked by final stage.</div>
        <DailyTrendChart days={trend.daily_trend || []} />
      </section>

      <section className="ura-card">
        <h3 className="ura-title">Stage distribution</h3>
        <div className="ura-subtitle">Share of leads by final stage.</div>
        <StageDistribution totals={totals} />
      </section>

      <section className="ura-card">
        <h3 className="ura-title">Conversion funnel</h3>
        <div className="ura-subtitle">Lead → visit scheduled → visit completed → offer given.</div>
        <FunnelChart totals={totals} />
      </section>

      <section className="ura-card ura-card-wide">
        <h3 className="ura-title">User leaderboard</h3>
        <div className="ura-subtitle">Top {Math.min((reportData.users || []).length, 15)} users by lead volume.</div>
        <UserLeaderboard users={reportData.users || []} />
      </section>
    </div>
  );
}
